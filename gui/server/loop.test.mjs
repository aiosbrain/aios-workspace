import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  validateCadence,
  validateWindow,
  buildWeeklyCloseoutPayload,
  loopResponse,
} from "./loop.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "index.mjs");

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
  await fn({ base, token });
}

test("GET /api/loop/daily: 401 without token, 200 with token", async (t) => {
  await withServer(t, async ({ base, token }) => {
    assert.equal((await fetch(`${base}/api/loop/daily`)).status, 401);
    const ok = await fetch(`${base}/api/loop/daily?token=${token}`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(typeof body.member === "string", "daily payload should carry a member");
    assert.ok(Array.isArray(body.changed), "daily payload should carry sections");
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
