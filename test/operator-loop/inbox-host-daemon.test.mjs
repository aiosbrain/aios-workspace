// Inbox host — coordinator daemon lifecycle + healthz (I-15 / AIO-396, the G6b review follow-up).
//
// Spawns the REAL coordinator daemon (`scripts/inbox-coordinator.mjs`) as a child process and drives
// it end-to-end: healthz is 200 while healthy, flips to 503 within a supervision tick after an
// observed adapter kill, persists the admin-tier host-health state, refuses non-GET / unknown routes,
// enforces the optional bearer token, and shuts down CLEANLY on SIGTERM (exit 0). No Fly, no network
// beyond loopback.
//
// Requires the built loop (`npm run build:loop`) — the daemon loads dist/operator-loop.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DAEMON = path.join(ROOT, "scripts", "inbox-coordinator.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spawn the daemon on an OS-assigned port; resolve once it logs its bound healthz address. */
function startDaemon(root, extraEnv = {}) {
  const child = spawn("node", [DAEMON], {
    cwd: ROOT,
    env: {
      ...process.env,
      AIOS_INBOX_DATA_DIR: root,
      AIOS_HOST_BIND: "127.0.0.1",
      AIOS_HEALTHZ_PORT: "0", // OS-assigned → avoids port collisions across parallel test files
      AIOS_COORDINATOR_INTERVAL_MS: "100",
      ...extraEnv,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (buf) => {
      stderr += buf.toString();
      const m = /healthz on http:\/\/([0-9.]+):(\d+)\//.exec(stderr);
      if (m) {
        child.stderr.off("data", onData);
        resolve({ host: m[1], port: Number(m[2]) });
      }
    };
    child.stderr.on("data", onData);
    child.once("exit", (code) => reject(new Error(`daemon exited early (${code}): ${stderr}`)));
    setTimeout(() => reject(new Error(`daemon did not report ready: ${stderr}`)), 8000);
  });
  return { child, ready, stderrOf: () => stderr };
}

function appendEvent(root, ev) {
  const dir = path.join(root, ".aios", "loop", "inbox");
  mkdirSync(dir, { recursive: true });
  appendFileSync(path.join(dir, "supervisor-events.ndjson"), JSON.stringify(ev) + "\n");
}

async function get(base, pathname, headers = {}) {
  const res = await fetch(`${base}${pathname}`, { headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

function stopDaemon(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(child.exitCode);
    child.once("exit", (code, signal) => resolve(code ?? signal));
    child.kill("SIGTERM");
  });
}

test("daemon: healthz is 200 when healthy, 503 after an observed kill, and persists state", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "inbox-daemon-"));
  const { child, ready } = startDaemon(root);
  try {
    const { host, port } = await ready;
    const base = `http://${host}:${port}`;

    // Healthy (no events yet → 0 adapters → ok).
    const healthy = await get(base, "/healthz");
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body.ok, true);
    // Content-free: only ok/counts/generated_at — no adapter details or secrets.
    assert.deepEqual(Object.keys(healthy.body).sort(), ["counts", "generated_at", "ok"]);
    assert.ok(
      existsSync(path.join(root, ".aios", "loop", "inbox", "host-health.json")),
      "state persisted"
    );

    // Observe a ready adapter then KILL it → the next tick should flip healthz to degraded.
    const now = Date.now();
    appendEvent(root, { adapter: "gmail", kind: "ready", at: now - 1000 });
    appendEvent(root, { adapter: "gmail", kind: "kill", at: now });

    let degraded = null;
    for (let i = 0; i < 40; i++) {
      const r = await get(base, "/healthz");
      if (r.status === 503) {
        degraded = r;
        break;
      }
      await sleep(50);
    }
    assert.ok(degraded, "healthz flipped to 503 within the supervision window");
    assert.equal(degraded.body.ok, false);
    assert.equal(degraded.body.counts.degraded, 1);
  } finally {
    await stopDaemon(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon: rejects non-GET and unknown routes; never exposes another surface", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "inbox-daemon-"));
  const { child, ready } = startDaemon(root);
  try {
    const { host, port } = await ready;
    const base = `http://${host}:${port}`;
    assert.equal((await get(base, "/")).status, 404);
    assert.equal((await get(base, "/read-model")).status, 404);
    const post = await fetch(`${base}/healthz`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await stopDaemon(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon: with AIOS_HEALTHZ_TOKEN set, /healthz requires the bearer token", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "inbox-daemon-"));
  const { child, ready } = startDaemon(root, { AIOS_HEALTHZ_TOKEN: "s3cret-health" });
  try {
    const { host, port } = await ready;
    const base = `http://${host}:${port}`;
    assert.equal((await get(base, "/healthz")).status, 401, "no token → 401");
    assert.equal(
      (await get(base, "/healthz", { authorization: "Bearer wrong" })).status,
      401,
      "wrong token → 401"
    );
    const ok = await get(base, "/healthz", { authorization: "Bearer s3cret-health" });
    assert.equal(ok.status, 200, "correct token → 200");
    assert.equal(ok.body.ok, true);
  } finally {
    await stopDaemon(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon: SIGTERM drains, flushes state, and exits 0", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "inbox-daemon-"));
  const { child, ready } = startDaemon(root);
  try {
    await ready;
    const exit = await stopDaemon(child);
    assert.equal(exit, 0, "clean SIGTERM shutdown exits 0");
    assert.ok(
      existsSync(path.join(root, ".aios", "loop", "inbox", "host-health.json")),
      "state flushed on shutdown"
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
});
