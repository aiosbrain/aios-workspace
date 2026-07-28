import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  validateCadence,
  validateWindow,
  validateAskId,
  buildWeeklyCloseoutPayload,
  loopResponse,
} from "./loop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "index.mjs");
const AIOS_CLI = path.join(HERE, "..", "..", "scripts", "aios.mjs");

/* ───────────────────────── pure helpers ───────────────────────── */

test("validateCadence accepts daily|weekly, rejects everything else", () => {
  assert.equal(validateCadence("daily"), "daily");
  assert.equal(validateCadence("weekly"), "weekly");
  // Crafted / empty / flag-injection values must throw a 400 — NEVER default to a value that
  // would be spliced into `--<cadence>` as an arbitrary flag.
  for (const bad of ["--all", "", "monthly", "DAILY", null, undefined, 7]) {
    assert.throws(
      () => validateCadence(bad),
      (e) => e.statusCode === 400,
      `expected 400 for cadence=${JSON.stringify(bad)}`
    );
  }
});

test("validateWindow: absent → null, positive int → n, else 400", () => {
  assert.equal(validateWindow(null), null);
  assert.equal(validateWindow(undefined), null);
  assert.equal(validateWindow(""), null);
  assert.equal(validateWindow("7"), 7);
  assert.equal(validateWindow("30"), 30);
  for (const bad of ["--all", "0", "-1", "1.5", "abc", "7d"]) {
    assert.throws(
      () => validateWindow(bad),
      (e) => e.statusCode === 400,
      `expected 400 for window=${JSON.stringify(bad)}`
    );
  }
});

test("validateAskId: hex ids and prefixes pass, flag-shaped and stray values 400", () => {
  // Both shapes the CLI itself accepts: the short prefix `asks list` prints, and a full UUID.
  assert.equal(validateAskId("3fea973d"), "3fea973d");
  assert.equal(
    validateAskId("3fea973d-1c2b-4a5e-9f80-0b1c2d3e4f50"),
    "3fea973d-1c2b-4a5e-9f80-0b1c2d3e4f50"
  );
  assert.equal(validateAskId("3FEA973D"), "3FEA973D", "case-insensitive hex");
  for (const bad of [
    "--json", // flag injection: the id is spliced straight into argv
    "-3fea973d", // leading dash — the reason the pattern demands a leading hex char
    "3fea973", // too short to be an id prefix
    "3fea973d; rm -rf /",
    "3fea973d ok",
    "zzzzzzzz", // non-hex
    "",
    null,
    undefined,
    123,
  ]) {
    assert.throws(
      () => validateAskId(bad),
      (e) => e.statusCode === 400,
      `expected 400 for id=${JSON.stringify(bad)}`
    );
  }
});

function closeoutFixture({ brief = "# Weekly brief\n\nAll good.", actions = ["ship it"] } = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "loop-weekly-"));
  const stamp = "2026-07-10T00-00-00-000Z";
  const dir = path.join(repo, ".aios", "loop", "closeouts", stamp);
  mkdirSync(dir, { recursive: true });
  if (brief != null) writeFileSync(path.join(dir, "brief.md"), brief);
  if (actions != null)
    writeFileSync(path.join(dir, "next-week-actions.json"), JSON.stringify(actions));
  const relBrief =
    brief != null ? path.join(".aios", "loop", "closeouts", stamp, "brief.md") : null;
  const stdout = JSON.stringify({
    runStamp: stamp,
    cadence: "weekly",
    briefPath: relBrief,
    audiences: [
      {
        audience: "team",
        status: "pass",
        shippable: true,
        digestPath: "x.md",
        unshippablePath: null,
      },
    ],
  });
  return { repo, stamp, stdout };
}

test("buildWeeklyCloseoutPayload reads brief + actions off disk", () => {
  const { repo, stamp, stdout } = closeoutFixture();
  const payload = buildWeeklyCloseoutPayload(stdout, repo);
  assert.equal(payload.runStamp, stamp);
  assert.equal(payload.cadence, "weekly");
  assert.match(payload.briefMarkdown, /Weekly brief/);
  assert.deepEqual(payload.ownerNextWeekActions, ["ship it"]);
  assert.equal(payload.audiences[0].audience, "team");
  assert.equal(payload.audiences[0].shippable, true);
});

test("buildWeeklyCloseoutPayload fails closed when the brief path is absent (dry-run)", () => {
  const { repo, stdout } = closeoutFixture({ brief: null });
  assert.throws(() => buildWeeklyCloseoutPayload(stdout, repo), /no brief written/);
});

test("buildWeeklyCloseoutPayload fails closed when the brief file is missing on disk", () => {
  // briefPath present in stdout but the file was never written.
  const repo = mkdtempSync(path.join(tmpdir(), "loop-weekly-"));
  const stdout = JSON.stringify({
    runStamp: "s",
    cadence: "weekly",
    briefPath: ".aios/loop/closeouts/s/brief.md",
    audiences: [],
  });
  assert.throws(() => buildWeeklyCloseoutPayload(stdout, repo), /brief not found/);
});

test("buildWeeklyCloseoutPayload rejects a briefPath that escapes the workspace", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "loop-weekly-"));
  const stdout = JSON.stringify({
    runStamp: "s",
    cadence: "weekly",
    briefPath: "../../../../etc/passwd",
    audiences: [],
  });
  assert.throws(() => buildWeeklyCloseoutPayload(stdout, repo), /escapes the workspace/);
});

test("loopResponse: pass-through 200 for a clean run", () => {
  const cli = { exitCode: 0, stdout: '{"ok":true}', stderr: "", err: null };
  const { status, json } = loopResponse(cli);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });
  assert.equal(json.cliExitCode, undefined);
});

test("loopResponse: 200 + cliExitCode + reshaped body even when CLI exit is 1", () => {
  // The core of the lenient policy: weekly prints valid JSON then exits 1 (non-shippable audience);
  // the panel must still get the reshaped brief, flagged with cliExitCode.
  const { repo, stdout } = closeoutFixture();
  const cli = { exitCode: 1, stdout, stderr: "", err: { code: 1 } };
  const { status, json } = loopResponse(cli, (s) => buildWeeklyCloseoutPayload(s, repo));
  assert.equal(status, 200);
  assert.equal(json.cliExitCode, 1);
  assert.match(json.briefMarkdown, /Weekly brief/);
});

test("loopResponse: telemetry tier-leak exit 2 → 200 + cliExitCode:2", () => {
  const cli = {
    exitCode: 2,
    stdout: '{"tierLeakCount":{"value":1}}',
    stderr: "",
    err: { code: 2 },
  };
  const { status, json } = loopResponse(cli);
  assert.equal(status, 200);
  assert.equal(json.cliExitCode, 2);
});

test("loopResponse: spawn failure (non-numeric err.code) → 500", () => {
  const cli = {
    exitCode: 0,
    stdout: "",
    stderr: "",
    err: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
  };
  const { status, json } = loopResponse(cli);
  assert.equal(status, 500);
  assert.match(json.error, /ENOENT/);
});

test("loopResponse: empty stdout → 500 with a generic message (stderr not leaked)", () => {
  const cli = {
    exitCode: 1,
    stdout: "  \n",
    stderr: "/private/tmp/secret path boom",
    err: { code: 1 },
  };
  const { status, json } = loopResponse(cli);
  assert.equal(status, 500);
  assert.match(json.error, /no output/);
  // stderr (which may carry internal paths) must NOT reach the client body.
  assert.doesNotMatch(json.error, /boom|secret/);
});

test("loopResponse: unparseable stdout → 500", () => {
  const cli = { exitCode: 0, stdout: "not json", stderr: "", err: null };
  const { status } = loopResponse(cli);
  assert.equal(status, 500);
});

/* ──────────────────── live server (spawned) ──────────────────── */

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "loop-srv-"));
  // Minimal marker so the GUI server recognizes this as an AIOS workspace on boot.
  writeFileSync(path.join(dir, "aios.yaml"), "owner: test\nproject: fixture\n");
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(base, token, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/api/info?token=${token}`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function withServer(t, fn) {
  const repo = workspace();
  const port = await freePort();
  const token = "devtoken";
  const child = spawn(process.execPath, [SERVER, "--repo", repo, "--port", String(port)], {
    env: { ...process.env, AIOS_GUI_TOKEN: token },
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await waitForServer(base, token), "server did not start in time");
  await fn({ base, token, repo });
}

test("GET /api/loop/daily: 401 without token, 200 with token", async (t) => {
  await withServer(t, async ({ base, token }) => {
    assert.equal((await fetch(`${base}/api/loop/daily`)).status, 401);
    const ok = await fetch(`${base}/api/loop/daily?token=${token}`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(typeof body.member === "string", "daily payload should carry a member");
    assert.ok(Array.isArray(body.changed), "daily payload should carry sections");
    assert.ok(Array.isArray(body.calendar), "daily payload should carry calendar");
    assert.ok(Array.isArray(body.commsNeedingReply), "daily payload should carry reply comms");
    assert.equal(typeof body.counts.calendar, "number");
    assert.equal(typeof body.counts.commsNeedingReply, "number");
    assert.equal(typeof body.counts.withheld, "number");
  });
});

test("GET /api/loop/telemetry without ?window → 200 with default 14-day window", async (t) => {
  await withServer(t, async ({ base, token }) => {
    const ok = await fetch(`${base}/api/loop/telemetry?token=${token}`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.window.days, 14, "omitting ?window must apply the CLI 14-day default");
  });
});

test("GET /api/loop/collect: invalid cadence → 400", async (t) => {
  await withServer(t, async ({ base, token }) => {
    const bad = await fetch(`${base}/api/loop/collect?cadence=--all&token=${token}`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/loop/collect?cadence=daily&token=${token}`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.window.cadence, "daily");
  });
});

test("POST /api/loop/weekly → 200 with a reshaped brief read off disk", async (t) => {
  await withServer(t, async ({ base, token }) => {
    const noTok = await fetch(`${base}/api/loop/weekly`, { method: "POST" });
    assert.equal(noTok.status, 401);
    const ok = await fetch(`${base}/api/loop/weekly?token=${token}`, { method: "POST" });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.cadence, "weekly");
    assert.ok(typeof body.briefMarkdown === "string" && body.briefMarkdown.length > 0);
    assert.ok(Array.isArray(body.audiences));
  });
});

/* ── asks routes (the Today console's write path) ── */

test("POST /api/asks/resolve: token-gated, validates ids, and closes a real ask", async (t) => {
  await withServer(t, async ({ base, token, repo }) => {
    assert.equal((await fetch(`${base}/api/asks/resolve`, { method: "POST" })).status, 401);

    const post = (body) =>
      fetch(`${base}/api/asks/resolve?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // The id is spliced into argv, so a flag-shaped or malformed value must fail closed.
    for (const bad of [{ id: "--json" }, { id: "-3fea973d" }, { id: "nope" }, { ids: [] }, {}]) {
      const r = await post(bad);
      assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal((await r.json()).ok, false);
    }

    // Round-trip a genuine ask through the same CLI the terminal uses.
    const add = spawn(
      process.execPath,
      [
        AIOS_CLI,
        "asks",
        "add",
        "--kind",
        "test",
        "--severity",
        "blocker",
        "--title",
        "route probe",
        "--json",
        "--repo",
        repo,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    add.stdout.on("data", (d) => (out += d));
    await new Promise((r) => add.on("close", r));
    const id = JSON.parse(out).id;
    assert.ok(id, "fixture ask should have an id");

    const ok = await post({ ids: [id] });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.resolved, [id]);

    // It is genuinely closed in the store, not just reported as closed.
    const listed = await fetch(`${base}/api/loop/daily?token=${token}`);
    const daily = await listed.json();
    assert.ok(
      !daily.attention.some((i) => i.ref.row === id),
      "a resolved ask must leave the daily attention list"
    );
  });
});

test("GET /api/asks/show: token-gated, rejects bad ids, returns the ask body", async (t) => {
  await withServer(t, async ({ base, token, repo }) => {
    assert.equal((await fetch(`${base}/api/asks/show?id=3fea973d`)).status, 401);
    assert.equal((await fetch(`${base}/api/asks/show?id=--json&token=${token}`)).status, 400);
    assert.equal((await fetch(`${base}/api/asks/show?token=${token}`)).status, 400);

    const add = spawn(
      process.execPath,
      [
        AIOS_CLI,
        "asks",
        "add",
        "--kind",
        "decision",
        "--severity",
        "blocker",
        "--title",
        "Reconnect WhatsApp",
        "--body",
        "Pair the device again so ingestion resumes.",
        "--json",
        "--repo",
        repo,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    let out = "";
    add.stdout.on("data", (d) => (out += d));
    await new Promise((r) => add.on("close", r));
    const id = JSON.parse(out).id;

    const ok = await fetch(`${base}/api/asks/show?id=${id}&token=${token}`);
    assert.equal(ok.status, 200);
    const ask = await ok.json();
    // This is the whole point of the route: the operator sees what the ask ASKS FOR,
    // not just an .ndjson evidence path.
    assert.equal(ask.title, "Reconnect WhatsApp");
    assert.equal(ask.body, "Pair the device again so ingestion resumes.");
    assert.equal(ask.severity, "blocker");

    // A well-formed id that does not exist is a 404, never a 200 with an empty shell.
    const missing = await fetch(`${base}/api/asks/show?id=deadbeef&token=${token}`);
    assert.equal(missing.status, 404);
  });
});

test("POST /api/tasks/edit: an explicit path patches THAT file; junk paths 404", async (t) => {
  await withServer(t, async ({ base, token, repo }) => {
    // A tier-split workspace: the row lives in tasks.md while tasks-team.md is what
    // resolveTasksFile would pick. Without an explicit path this edit cannot land.
    const table = (row) =>
      `---\nstatus: living\nowner: alex\naccess: team\n---\n\n# Tasks\n\n| ID | Task | Assignee | Status | Sprint | Due |\n|----|------|----------|--------|--------|-----|\n| ${row} |\n`;
    mkdirSync(path.join(repo, "3-log"), { recursive: true });
    writeFileSync(
      path.join(repo, "3-log", "tasks-team.md"),
      table("TT1 | Team row | John | todo | s | ")
    );
    writeFileSync(
      path.join(repo, "3-log", "tasks.md"),
      table("T19 | Fix the bug | John | todo | s | ")
    );

    const post = (body) =>
      fetch(`${base}/api/tasks/edit?token=${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Without a path the row is looked for in tasks-team.md and is (correctly) not found.
    assert.equal((await post({ row_key: "T19", patch: { status: "done" } })).status, 404);

    const ok = await post({ row_key: "T19", path: "3-log/tasks.md", patch: { status: "done" } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.rel, "3-log/tasks.md");
    assert.match(
      readFileSync(path.join(repo, "3-log", "tasks.md"), "utf8"),
      /\| T19 \| Fix the bug \| John \| done \|/
    );

    // The path arrives from the browser: traversal and unknown files must never resolve.
    for (const bad of ["../../etc/passwd", "3-log/../../../etc/passwd", "3-log/secrets.md"]) {
      const r = await post({ row_key: "T19", path: bad, patch: { status: "done" } });
      assert.equal(r.status, 404, `expected 404 for ${bad}`);
    }
  });
});
