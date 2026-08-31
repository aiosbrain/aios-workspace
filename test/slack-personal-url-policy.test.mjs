/**
 * slack-personal-url-policy.test.mjs — the outbound destination policy (AIO-1017, Bandit B310).
 *
 * slack.py has five outbound call sites — Slack Web API, brain token fetch, brain member
 * resolve, brain token store, and the file-upload URL — all routed through ONE validator +
 * opener (`_urlopen_checked`). These tests prove, by request capture against live loopback
 * listeners, that every forbidden destination is refused with ZERO requests observed — so zero
 * Authorization headers and zero token-bearing bodies ever leave — and that the two accepted
 * cases (loopback http under the explicit test flag; a same-origin redirect) still work, which
 * is the positive control proving the capture mechanism itself.
 *
 * No live network, no real credentials: the brain key and Slack token here are fabricated, the
 * only listeners are in this process, and forbidden-destination cases are refused BEFORE any
 * connection is attempted (which is why a TEST-NET address can be used without a timeout).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { CLI, MOCK_TOKEN, cliPointedAt } from "./slack-personal-upload-fixtures.mjs";

// Fabricated at runtime so no credential-shaped literal ever sits on disk (same reasoning as
// MOCK_TOKEN in the shared fixtures).
const BRAIN_KEY = ["aios", "mock", "brain", "key"].join("-");
const FLAG = "AIOS_SLACK_ALLOW_LOOPBACK_HTTP";

/** agent-context.json pointing the CLI's brain config at `url`. AGENT_CONTEXT is checked first
 * by the CLI, so this isolates the test from any real ~/.claude/agent-context.json. */
function brainContext(url) {
  const dir = mkdtempSync(path.join(tmpdir(), "slack-url-policy-"));
  const f = path.join(dir, "agent-context.json");
  writeFileSync(f, JSON.stringify({ brain: { url } }));
  return f;
}

/** Run the CLI with a MINIMAL env: no inherited AIOS_BRAIN_URL / SLACK_USER_TOKEN / HERMES_HOME
 * can leak in and make a "refused with zero egress" assertion accidentally true or false. */
function runCli({ args, brainUrl, cli = CLI, env = {} }) {
  const base = {
    PATH: process.env.PATH,
    AGENT_CONTEXT: brainContext(brainUrl ?? "https://brain.invalid"),
    AIOS_API_KEY: BRAIN_KEY,
  };
  return new Promise((resolve) => {
    execFile(
      "python3",
      [cli, ...args],
      { encoding: "utf8", env: { ...base, ...env } },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
  });
}

/** Loopback capture server. Records every request (path, headers, body); responds per `plan`,
 * defaulting to a valid brain-shaped JSON 200. */
async function withCapture(plan, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      const custom = plan.respond && plan.respond(req, res, seen.length);
      if (custom) return; // handler wrote the response itself
      const payload = Buffer.from(JSON.stringify(plan.json ?? { connected: false }));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(payload.length),
        connection: "close",
      });
      res.end(payload);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    return await fn({ url: `http://127.0.0.1:${port}`, port, seen });
  } finally {
    server.close();
  }
}

function assertNoCredentialEcho(r) {
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(BRAIN_KEY), "never echo the brain key");
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(MOCK_TOKEN), "never echo the Slack token");
}

// ── forbidden destinations: refused with zero egress ────────────────────────────────────────

test("a malformed brain URL is refused before any request is constructed", async () => {
  for (const bad of ["not-a-url", "http://"]) {
    const r = await runCli({ args: ["status"], brainUrl: bad });
    assert.equal(r.status, 5, `'${bad}' must be refused: ${r.stderr}`);
    assert.match(r.stderr, /non-https URL/);
    assertNoCredentialEcho(r);
  }
});

test("a file: brain URL is refused — urlopen would happily open it", async () => {
  const r = await runCli({ args: ["status"], brainUrl: "file:///etc/hosts" });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /non-https URL \(scheme 'file'\)/);
  assertNoCredentialEcho(r);
});

test("a foreign-host http brain URL is refused even WITH the loopback test flag", async () => {
  // The flag unlocks loopback only; a non-loopback plaintext host stays forbidden. TEST-NET
  // address + discard port: if the CLI ever tried to connect, this test would hang, so a fast
  // exit 5 is itself evidence the refusal happens pre-connection.
  const r = await runCli({
    args: ["status"],
    brainUrl: "http://192.0.2.1:9/collect",
    env: { [FLAG]: "1" },
  });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /non-https URL/);
  assertNoCredentialEcho(r);
});

test("non-loopback http is refused without the flag (default posture)", async () => {
  const r = await runCli({ args: ["status"], brainUrl: "http://evil.example.com/collect" });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /non-https URL/);
  assert.doesNotMatch(r.stderr, /evil\.example\.com/, "never echo the URL");
  assertNoCredentialEcho(r);
});

test("loopback http WITHOUT the flag: all four brain call sites refuse, capture sees nothing", async () => {
  // The listener is real and reachable — zero requests observed is the whole point.
  await withCapture({}, async ({ url, seen }) => {
    // token store (POST /api/v1/me/slack-token — body would carry the Slack token)
    let r = await runCli({ args: ["connect", MOCK_TOKEN], brainUrl: url });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /non-https URL/);
    // token fetch (GET /api/v1/me/slack-token via `whoami` with no SLACK_USER_TOKEN)
    r = await runCli({ args: ["whoami"], brainUrl: url });
    assert.equal(r.status, 5, r.stderr);
    // member resolution (GET /api/v1/identities/resolve) — must fail LOUDLY, not degrade to
    // "no brain match"
    r = await runCli({ args: ["resolve", "--member", "alice"], brainUrl: url });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /non-https URL/);
    // status (plain _brain_request GET)
    r = await runCli({ args: ["status"], brainUrl: url });
    assert.equal(r.status, 5, r.stderr);
    assertNoCredentialEcho(r);
    assert.equal(seen.length, 0, "ZERO requests may reach the listener without the flag");
  });
});

test("the Slack provider path refuses a loopback-http API base without the flag", async () => {
  await withCapture({}, async ({ url, seen }) => {
    const patched = cliPointedAt(`${url}/api/`);
    const r = await runCli({
      args: ["whoami"],
      cli: patched,
      env: { SLACK_USER_TOKEN: MOCK_TOKEN },
    });
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /non-https URL/);
    assert.equal(seen.length, 0, "the bearer token never left the process");
  });
});

// ── accepted cases: the positive controls ───────────────────────────────────────────────────

test("loopback http WITH the flag is accepted — proving the capture mechanism works", async () => {
  await withCapture({ json: { connected: false } }, async ({ url, seen }) => {
    const r = await runCli({ args: ["status"], brainUrl: url, env: { [FLAG]: "1" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not connected/);
    assert.equal(seen.length, 1, "exactly one request reaches the mock brain");
    assert.equal(seen[0].headers.authorization, `Bearer ${BRAIN_KEY}`);
  });
});

test("a same-origin redirect is followed, credentials intact", async () => {
  await withCapture(
    {
      respond(req, res, n) {
        if (n === 1) {
          res.writeHead(302, {
            location: "/redirected",
            "content-length": "0",
            connection: "close",
          });
          res.end();
          return true;
        }
        return false; // default JSON 200 for the follow-up
      },
      json: { connected: true, slack_user_id: "U0MOCK", workspace: "mock" },
    },
    async ({ url, seen }) => {
      const r = await runCli({ args: ["status"], brainUrl: url, env: { [FLAG]: "1" } });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /connected as U0MOCK/);
      assert.equal(seen.length, 2, "the redirect is followed within the origin");
      assert.equal(seen[1].path, "/redirected");
      assert.equal(seen[1].headers.authorization, `Bearer ${BRAIN_KEY}`);
    }
  );
});

test("a cross-origin redirect is refused — zero requests, zero auth reach the second origin", async () => {
  // Both listeners are loopback and the flag is set, so the SCHEME passes on both — what
  // differs is the origin ('localhost' vs '127.0.0.1' is already a different host). This
  // isolates the origin check itself.
  await withCapture({}, async ({ port: stealPort, seen: stolen }) => {
    await withCapture(
      {
        respond(req, res) {
          res.writeHead(302, {
            location: `http://localhost:${stealPort}/steal`,
            "content-length": "0",
            connection: "close",
          });
          res.end();
          return true;
        },
      },
      async ({ url, seen }) => {
        const r = await runCli({ args: ["status"], brainUrl: url, env: { [FLAG]: "1" } });
        assert.equal(r.status, 5, r.stderr);
        assert.match(r.stderr, /cross-origin redirect/);
        assert.doesNotMatch(r.stderr, /steal/, "the redirect target is never echoed");
        assert.equal(seen.length, 1, "the original origin was contacted once");
        assert.equal(stolen.length, 0, "ZERO requests reach the redirect target");
        const authSeen = stolen.filter((q) => q.headers.authorization);
        assert.equal(authSeen.length, 0, "ZERO auth headers reach the redirect target");
      }
    );
  });
});

test("a redirect to a non-loopback plaintext destination is refused mid-flight too", async () => {
  // (urllib itself already refuses redirects to non-http(s) schemes like file: — that surfaces
  // as an HTTPError, still zero egress. This case is one urllib WOULD follow, so it isolates
  // our handler's revalidation: http passes urllib's own scheme check, and the flag is set, but
  // the target is not loopback.)
  await withCapture(
    {
      respond(req, res) {
        res.writeHead(302, {
          location: "http://192.0.2.1:9/steal",
          "content-length": "0",
          connection: "close",
        });
        res.end();
        return true;
      },
    },
    async ({ url, seen }) => {
      const r = await runCli({ args: ["status"], brainUrl: url, env: { [FLAG]: "1" } });
      assert.equal(r.status, 5, r.stderr);
      assert.match(r.stderr, /non-https URL/);
      assert.equal(seen.length, 1);
    }
  );
});
