#!/usr/bin/env node
// test/member-invite.cli.test.mjs — spawn the REAL `aios member` CLI against a stub
// Team-Brain HTTP server (mirrors test/stakeholders.cli.test.mjs's approach, node:test +
// node:assert style like scripts/brain-mcp.test.mjs). Covers brain-api v1.7
// POST /api/v1/members/invite + GET /api/v1/members: happy path, --tools parsing,
// the pre-v1.7 404 tolerance message, email-delivery-failed → login_url, manual mode,
// and `aios member list`'s table.
//
// Run: node --test test/member-invite.cli.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

function token(req) {
  return String(req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
}
function send(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

// One stub server, branching on the Bearer key so every scenario is one process.
const invited = []; // records POST bodies for assertion
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const route = url.pathname.replace(/^\/api\/v1/, "");
  const tok = token(req);

  if (route === "/members/invite" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      invited.push({ tok, body });

      if (tok === "pre-v17-key") {
        return send(res, 404, { error: { code: "not_found", message: "no such route" } });
      }
      if (tok === "non-admin-key") {
        return send(res, 403, {
          error: { code: "forbidden_role", message: "admin role required" },
        });
      }
      if (tok === "manual-key") {
        return send(res, 200, {
          member: { id: "u2", email: body.email, status: "invited", created: true },
          invite: {
            mode: "manual",
            password: "pw-demo",
            invite_message: `Sign in at https://brain.example — email ${body.email} / password pw-demo`,
          },
          provisioning: [{ tool: "linear", status: "skipped", detail: "not configured" }],
        });
      }
      if (tok === "email-failed-key") {
        return send(res, 200, {
          member: { id: "u3", email: body.email, status: "invited", created: true },
          invite: {
            mode: "magic-link",
            email_delivered: false,
            login_url: "https://brain.example/sign-in/tok-abc123",
          },
          provisioning: [],
        });
      }
      // default: happy path, existing member (re-invite), one entry per tool cascade.
      return send(res, 200, {
        member: { id: "u1", email: body.email, status: "invited", created: false },
        invite: { mode: "magic-link", email_delivered: true },
        provisioning: [
          { tool: "linear", status: "sent", detail: "" },
          {
            tool: "slack",
            status: "link_provided",
            detail: "standing workspace join link",
            invite_link: "https://join.slack.com/t/acme/shared_invite/xyz",
          },
          { tool: "github", status: "failed", detail: "token needs admin:org scope" },
        ],
      });
    });
    return;
  }
  if (route === "/members" && req.method === "GET") {
    return send(res, 200, {
      members: [
        {
          id: "u1",
          email: "riley@example.com",
          display_name: "Riley Chen",
          actor_handle: "riley",
          role: "member",
          tier: "team",
          identities: [{ provider: "slack", externalId: "U1" }],
        },
        {
          id: "u2",
          email: "alex@example.com",
          display_name: "Alex",
          actor_handle: "alex",
          role: "lead",
          tier: "team",
          identities: [],
        },
      ],
    });
  }
  return send(res, 404, { error: { code: "not_found", message: "unknown route" } });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const PORT = server.address().port;
const BRAIN_URL = `http://127.0.0.1:${PORT}`;

const repoDir = mkdtempSync(path.join(tmpdir(), "member-cli-"));
writeFileSync(
  path.join(repoDir, "aios.yaml"),
  [
    "version: 1",
    `brain_url: "${BRAIN_URL}"`,
    'team_id: "acme"',
    "api_key_env: AIOS_API_KEY",
    "sync_tiers:",
    "  - team",
    "context: employee",
    "",
  ].join("\n")
);

after(() => {
  server.close();
  rmSync(repoDir, { recursive: true, force: true });
});

async function runCli(args, apiKey) {
  const env = {
    ...process.env,
    AIOS_BRAIN_URL: BRAIN_URL,
    AIOS_TEAM: "acme",
    AIOS_API_KEY: apiKey,
  };
  try {
    const { stdout } = await execFileP(
      process.execPath,
      [AIOS, "member", ...args, "--repo", repoDir],
      { env, encoding: "utf8", timeout: 30000 }
    );
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

test("invite happy path: correct route + body (role default member, tools default all)", async () => {
  invited.length = 0;
  const r = await runCli(
    ["invite", "riley@example.com", "--name", "Riley Chen", "--handle", "riley"],
    "admin-key"
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.equal(invited.length, 1);
  assert.deepEqual(invited[0].body, {
    email: "riley@example.com",
    display_name: "Riley Chen",
    actor_handle: "riley",
    role: "member",
    tools: "all",
  });
  assert.match(r.stdout, /already existed \(re-invited\)/, "created:false → re-invited wording");
  assert.match(r.stdout, /magic-link sent to riley@example\.com/);
  // one line per provisioning entry
  assert.match(r.stdout, /linear/);
  assert.match(r.stdout, /sent/);
  assert.match(r.stdout, /slack/);
  assert.match(r.stdout, /link_provided|join\.slack\.com/);
  assert.match(r.stdout, /github/);
  assert.match(r.stdout, /failed/);
  assert.match(r.stdout, /admin:org scope/);
});

test("--tools parsing: linear,slack → array; role override passed through", async () => {
  invited.length = 0;
  const r = await runCli(
    [
      "invite",
      "riley@example.com",
      "--name",
      "Riley Chen",
      "--handle",
      "riley",
      "--role",
      "lead",
      "--tools",
      "linear,slack",
    ],
    "admin-key"
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.deepEqual(invited[0].body.tools, ["linear", "slack"]);
  assert.equal(invited[0].body.role, "lead");
});

test("--tools invalid value → usage error, no API call", async () => {
  invited.length = 0;
  const r = await runCli(
    [
      "invite",
      "riley@example.com",
      "--name",
      "Riley Chen",
      "--handle",
      "riley",
      "--tools",
      "carrier-pigeon",
    ],
    "admin-key"
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /unknown --tools value/);
  assert.equal(invited.length, 0, "no request reached the brain");
});

test("missing --name / --handle → usage error, no API call", async () => {
  invited.length = 0;
  const r = await runCli(["invite", "riley@example.com", "--handle", "riley"], "admin-key");
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /--name is required/);
  assert.equal(invited.length, 0);
});

test("invalid email → usage error, no API call", async () => {
  invited.length = 0;
  const r = await runCli(
    ["invite", "not-an-email", "--name", "Riley Chen", "--handle", "riley"],
    "admin-key"
  );
  assert.notEqual(r.code, 0);
  assert.equal(invited.length, 0);
});

test("404 (pre-v1.7 brain) → the documented tolerance message", async () => {
  const r = await runCli(
    ["invite", "riley@example.com", "--name", "Riley Chen", "--handle", "riley"],
    "pre-v17-key"
  );
  assert.notEqual(r.code, 0);
  assert.match(
    r.stdout + r.stderr,
    /this Team Brain predates brain-api v1\.7 member invites — update aios-team-brain, or invite from the dashboard's \/admin\/members page\./
  );
});

test("403 forbidden_role → the admin-required message", async () => {
  const r = await runCli(
    ["invite", "riley@example.com", "--name", "Riley Chen", "--handle", "riley"],
    "non-admin-key"
  );
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /your API key's member must be a team admin to invite members/);
});

test("email delivery failed → login_url printed", async () => {
  const r = await runCli(
    ["invite", "riley@example.com", "--name", "Riley Chen", "--handle", "riley"],
    "email-failed-key"
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /email delivery FAILED/);
  assert.match(r.stdout, /https:\/\/brain\.example\/sign-in\/tok-abc123/);
});

test("manual mode → invite_message printed verbatim", async () => {
  const r = await runCli(
    ["invite", "riley@example.com", "--name", "Riley Chen", "--handle", "riley"],
    "manual-key"
  );
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(
    r.stdout,
    /Sign in at https:\/\/brain\.example — email riley@example\.com \/ password pw-demo/
  );
});

test("member list renders an aligned roster table", async () => {
  const r = await runCli(["list"], "team-key");
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /HANDLE/);
  assert.match(r.stdout, /NAME/);
  assert.match(r.stdout, /EMAIL/);
  assert.match(r.stdout, /ROLE/);
  assert.match(r.stdout, /TIER/);
  assert.match(r.stdout, /riley/);
  assert.match(r.stdout, /Riley Chen/);
  assert.match(r.stdout, /riley@example\.com/);
  assert.match(r.stdout, /alex/);
});

test("no/unknown subcommand → usage block, exit 1", async () => {
  const r = await runCli([], "team-key");
  assert.notEqual(r.code, 0);
  assert.match(r.stdout + r.stderr, /aios member/);
});
