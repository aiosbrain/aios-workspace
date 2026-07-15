import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBrainClient } from "../scripts/brain-client.mjs";

/**
 * Sync EXECUTION smoke test (W2.3a punch #9).
 *
 * test/sync-plan.test.mjs already proves the offline tier-plan gate (buildPlan, via
 * `aios status --json`) fails closed. But the headline `aios push` / `aios pull` code
 * paths — and scripts/brain-client.mjs, the shared HTTP/auth layer both the CLI and the
 * MCP server use — had ZERO execution coverage: nothing ever drove a real network
 * round-trip through them.
 *
 * This spins a minimal in-process HTTP stub implementing just enough of the brain-api
 * v1.5 contract (docs/brain-api.md): `POST/GET /api/v1/items`, `GET /api/v1/tasks`
 * (cmdPull's non-optional writeback call), the `Authorization`/`X-AIOS-Team` auth
 * headers, and a `422 forbidden_tier` on an admin-tier push. It then drives the REAL
 * `aios push`/`aios pull` CLI (child process, exactly as a user runs it) plus
 * brain-client.mjs directly, all against 127.0.0.1 loopback only — hermetic, no real
 * network, no external brain.
 */

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");
const GUI_SERVER = path.join(REPO, "gui", "server", "index.mjs");
const TEST_KEY = "aios_smoketest_secret-value";
const TEST_TEAM = "test-team";
const GUI_TOKEN = "sync-execution-smoke-token";

function sha256(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

// Minimal brain-api v1.5 stub. `prepulled` seeds the item store so a pull has content
// to fetch; pushes append to it too, so pushedItems + the store both reflect reality.
function startStubBrain(prepulled = [], { rejectPushes = false } = {}) {
  const pushedItems = [];
  const requestsLog = [];
  const itemStore = [...prepulled];

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const url = new URL(req.url, "http://127.0.0.1");
      requestsLog.push({ method: req.method, path: url.pathname });

      const send = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      // Auth: Authorization: Bearer <key> + X-AIOS-Team: <team>, per brain-api.md.
      const auth = req.headers["authorization"] || "";
      const team = req.headers["x-aios-team"] || "";
      if (auth !== `Bearer ${TEST_KEY}` || team !== TEST_TEAM) {
        send(401, { error: { code: "unauthorized", message: "bad auth", request_id: "r-401" } });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/v1/items") {
        const item = JSON.parse(rawBody);
        if (rejectPushes) {
          send(503, {
            error: { code: "unavailable", message: "fixture rejection", request_id: "r-503" },
          });
          return;
        }
        // Server-side fail-closed backstop (brain-api.md §"Server semantics"): admin/
        // private content is rejected 422, independent of any client-side gate.
        if (item.access === "admin") {
          send(422, {
            error: {
              code: "forbidden_tier",
              message: "admin content rejected",
              request_id: "r-422",
            },
          });
          return;
        }
        pushedItems.push(item);
        const id = randomUUID();
        itemStore.push({ ...item, id, updated_at: new Date().toISOString() });
        send(201, { status: "created", id });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/items") {
        send(200, { items: itemStore, next_cursor: null });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/v1/tasks") {
        send(200, { tasks: [], next_cursor: null });
        return;
      }

      // Everything else (incl. /decisions, /projects) 404s — exercising the client's
      // apiOptional forward-compat tolerance for endpoints an older/partial brain lacks.
      send(404, { error: { code: "not_found", message: "no such route", request_id: "r-404" } });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        pushedItems,
        requestsLog,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function fm(fields, title = "x") {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n# ${title}\n`;
}

function makeWorkspace(brainUrl) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-syncexec-"));
  mkdirSync(path.join(dir, "2-work"), { recursive: true });
  // cmdPull picks the legacy `01-intake` spine when `1-inbox` doesn't exist yet
  // (scripts/aios.mjs cmdPull) — create it so pull writes into the current spine.
  mkdirSync(path.join(dir, "1-inbox"), { recursive: true });
  writeFileSync(
    path.join(dir, "aios.yaml"),
    [
      "version: 1",
      `brain_url: "${brainUrl}"`,
      `team_id: "${TEST_TEAM}"`,
      "member: smoke-bot",
      "sync_tiers:",
      "  - team",
      "sync_include:",
      "  - 2-work",
    ].join("\n") + "\n"
  );
  // team-tier: eligible to push. admin-tier (friendly `private`): default-deny, must
  // never even reach the network layer.
  writeFileSync(
    path.join(dir, "2-work", "team-ok.md"),
    fm({ status: "final", owner: "alex", access: "team" }, "team ok")
  );
  writeFileSync(
    path.join(dir, "2-work", "admin-secret.md"),
    fm({ status: "draft", owner: "alex", access: "private" }, "admin secret")
  );
  return dir;
}

// MUST be async (spawn, not spawnSync): the stub brain runs in-process in this same
// event loop, so a synchronous, blocking child-process call would deadlock — the CLI
// child can never get a response from a server whose event loop it has frozen.
function runAios(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [AIOS, ...args], {
      cwd,
      // Pin AIOS_MEMBER explicitly so member resolution is hermetic — otherwise
      // resolveMember() falls back to the *developer's own* toolkit .env / git
      // user.name on a real workstation, making the assertion machine-dependent.
      env: { ...process.env, AIOS_API_KEY: TEST_KEY, AIOS_MEMBER: "smoke-bot" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startGui(repo) {
  const port = await reservePort();
  const child = spawn(process.execPath, [GUI_SERVER, "--repo", repo, "--port", String(port)], {
    cwd: REPO,
    env: {
      ...process.env,
      AIOS_API_KEY: TEST_KEY,
      AIOS_MEMBER: "smoke-bot",
      AIOS_GUI_TOKEN: GUI_TOKEN,
    },
  });
  let stdout = "";
  let stderr = "";
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`GUI start timed out: ${stderr}`)), 10_000);
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      stdout += d;
      if (!stdout.includes(`127.0.0.1:${port}`)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`GUI exited ${code}: ${stderr || stdout}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill("SIGTERM");
      }),
  };
}

test("aios push: team-tier item round-trips to the stub brain; admin tier is never sent (default-deny holds at the network layer)", async () => {
  const stub = await startStubBrain();
  const dir = makeWorkspace(stub.url);
  try {
    const r = await runAios(["push", "--repo", dir], REPO);
    assert.equal(r.code, 0, `push failed: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /pushed 1\/1/);

    // Execution-level proof (sync-plan.test.mjs only proves the offline plan; this proves
    // the real HTTP round-trip matches it): exactly one item reached the stub.
    assert.equal(stub.pushedItems.length, 1);
    assert.equal(stub.pushedItems[0].path, "2-work/team-ok.md");
    assert.equal(stub.pushedItems[0].access, "team");
    // cfg.project defaults to slugify(basename(repo)) when no project.yaml exists
    // (scripts/aios.mjs `slugify`): lowercased, non-alnum runs collapsed to `-`.
    assert.equal(
      stub.pushedItems[0].project,
      path
        .basename(dir)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
    );

    // admin-tier content never left the machine — no POST for it was ever made, not just
    // "rejected if sent". buildPlan blocks it before cmdPush's loop even starts.
    assert.ok(!stub.pushedItems.some((i) => i.access === "admin"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test("aios push: a Brain item rejection exits nonzero so GUI callers cannot report false success", async () => {
  const stub = await startStubBrain([], { rejectPushes: true });
  const dir = makeWorkspace(stub.url);
  try {
    const r = await runAios(["push", "--repo", dir], REPO);
    assert.equal(r.code, 1, `expected a failed exit:\n${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /fixture rejection/);
    assert.match(r.stdout, /pushed 0\/1/);
    assert.equal(stub.pushedItems.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test("GUI Team Brain sync returns ok:false when any Brain item is rejected", async () => {
  const stub = await startStubBrain([], { rejectPushes: true });
  const dir = makeWorkspace(stub.url);
  const gui = await startGui(dir);
  try {
    const response = await fetch(`${gui.url}/api/push?token=${GUI_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["2-work/team-ok.md"], dryRun: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.dryRun, false);
    assert.match(body.output, /fixture rejection/);
    assert.match(body.output, /pushed 0\/1/);
    assert.match(body.error, /Command failed/);
  } finally {
    await gui.close();
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});

test("brain-client.mjs fetchJson surfaces the server's 422 on an admin-tier item (fail closed, not silently swallowed)", async () => {
  // Drives brain-client.mjs directly (bypassing the CLI's own client-side default-deny)
  // to prove the shared HTTP layer itself — used by both the CLI and the MCP server —
  // correctly maps a real 422 response to a thrown Error instead of eating it.
  const stub = await startStubBrain();
  try {
    const client = createBrainClient({
      brain_url: stub.url,
      api_key: TEST_KEY,
      team_id: TEST_TEAM,
    });
    await assert.rejects(
      () =>
        client.fetchJson("POST", "/items", {
          project: "p",
          path: "5-personal/secret.md",
          kind: "deliverable",
          access: "admin",
          actor: "smoke-bot",
          frontmatter: {},
          body: "should never be accepted",
        }),
      /422.*forbidden_tier/
    );
  } finally {
    await stub.close();
  }
});

test("aios pull: a team-tier item round-trips into 1-inbox/from-brain; an unrecognized item kind doesn't break pull (forward-compat)", async () => {
  const knownBody = "# pulled from brain\n\nteam-tier content that must round-trip verbatim.";
  const futureBody = "# content under a kind this client predates — must not crash pull.";
  const nowIso = new Date().toISOString();
  const stub = await startStubBrain([
    {
      id: randomUUID(),
      project: "sync-test-project",
      path: "2-work/from-brain-known.md",
      kind: "deliverable",
      access: "team",
      frontmatter: {},
      body: knownBody,
      content_sha256: sha256(knownBody),
      actor: "jordan",
      updated_at: nowIso,
    },
    {
      id: randomUUID(),
      // brain-api.md §"Item kinds": "clients MUST ignore item kinds they don't recognize
      // (a v1 client that predates `skill` simply skips those items on pull)". This client
      // doesn't kind-switch on pull at all (cmdPull writes every item's body through
      // generically) — so the concrete, testable guarantee is: an unrecognized kind must
      // not throw/abort the pull, and its content still lands (never silently dropped).
      kind: "okf-node-from-a-future-contract-version",
      project: "sync-test-project",
      path: "2-work/from-brain-future-kind.md",
      access: "team",
      frontmatter: {},
      body: futureBody,
      content_sha256: sha256(futureBody),
      actor: "jordan",
      updated_at: nowIso,
    },
  ]);
  const dir = makeWorkspace(stub.url);
  try {
    const r = await runAios(["pull", "--repo", dir], REPO);
    assert.equal(r.code, 0, `pull failed: ${r.stderr}\n${r.stdout}`);
    assert.match(r.stdout, /pulled 2 item\(s\)/);

    const knownDest = path.join(
      dir,
      "1-inbox",
      "from-brain",
      "sync-test-project__2-work__from-brain-known.md"
    );
    const futureDest = path.join(
      dir,
      "1-inbox",
      "from-brain",
      "sync-test-project__2-work__from-brain-future-kind.md"
    );
    assert.ok(existsSync(knownDest), "known-kind item must be written to the inbox");
    assert.ok(existsSync(futureDest), "unrecognized-kind item must still be written, not dropped");
    assert.ok(
      readFileSync(knownDest, "utf8").includes(knownBody),
      "known item body round-trips verbatim"
    );
    assert.ok(
      readFileSync(futureDest, "utf8").includes(futureBody),
      "future-kind item body round-trips verbatim despite the unrecognized kind"
    );

    // The non-optional /tasks writeback call was actually made (not skipped) — proves
    // cmdPull drove the full pull sequence, not just the /items leg.
    assert.ok(stub.requestsLog.some((r2) => r2.method === "GET" && r2.path === "/api/v1/tasks"));
    // /decisions and /projects both 404 on this stub; pull completing with exit 0 proves
    // apiOptional's tolerate-404 forward-compat path held for both.
    assert.ok(stub.requestsLog.some((r2) => r2.path === "/api/v1/decisions"));
    assert.ok(stub.requestsLog.some((r2) => r2.path === "/api/v1/projects"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stub.close();
  }
});
