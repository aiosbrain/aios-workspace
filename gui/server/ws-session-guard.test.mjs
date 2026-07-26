// Integration tests for the WS session layer: the latest-wins single-writer guard
// (close 4001 on takeover — two adapters must never interleave one transcript) and
// the friendly EADDRINUSE exit. Boots the real server against a throwaway workspace.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs");
const PORT = 18000 + Math.floor(Math.random() * 2000);

let repo;
let child;
let token;

function startServer(port, repoDir) {
  return spawn(process.execPath, [SERVER, "--repo", repoDir, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ANTHROPIC_API_KEY: "" }, // adapter idles; no model calls in this test
  });
}

function waitForToken(proc, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let out = "";
    const t = setTimeout(() => reject(new Error(`server did not start:\n${out}`)), timeoutMs);
    proc.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/token=([a-f0-9]+)/);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => reject(new Error(`server exited ${code} before ready:\n${out}`)));
  });
}

function connect(port, tok, session) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${tok}${session ? `&session=${session}` : ""}`
    );
    const closed = new Promise((res) => ws.on("close", (code) => res(code)));
    const t = setTimeout(() => reject(new Error("no hello within 5s")), 5000);
    ws.on("message", (buf) => {
      try {
        const ev = JSON.parse(buf.toString());
        if (ev.type === "hello") {
          clearTimeout(t);
          resolve({ ws, sessionId: ev.sessionId, closed });
        }
      } catch {}
    });
    ws.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

before(async () => {
  repo = mkdtempSync(path.join(tmpdir(), "aios-ws-guard-"));
  writeFileSync(path.join(repo, "aios.yaml"), "version: 1\nworkspace:\n  owner: test\n");
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  child = startServer(PORT, repo);
  token = await waitForToken(child);
});

after(() => {
  child?.kill("SIGTERM");
  rmSync(repo, { recursive: true, force: true });
});

test("second connection on the same session id supersedes the first (close 4001)", async () => {
  const a = await connect(PORT, token);
  // The session must have a transcript on disk before it is resumable; the hello
  // append creates it, so B can attach by id immediately.
  const b = await connect(PORT, token, a.sessionId);
  assert.equal(b.sessionId, a.sessionId, "B resumed A's session");
  const aCode = await Promise.race([
    a.closed,
    new Promise((_, rej) => setTimeout(() => rej(new Error("A was not closed within 3s")), 3000)),
  ]);
  assert.equal(aCode, 4001, "old connection closed with the app-level SUPERSEDED code");
  assert.equal(b.ws.readyState, WebSocket.OPEN, "new connection stays open");
  b.ws.close();
});

test("distinct sessions do not interfere", async () => {
  const a = await connect(PORT, token);
  const b = await connect(PORT, token);
  assert.notEqual(a.sessionId, b.sessionId);
  // Give any (wrong) takeover a moment to fire, then assert both are still open.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(a.ws.readyState, WebSocket.OPEN);
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  a.ws.close();
  b.ws.close();
});

test("takeover does not wait on the old peer's close handshake (dead-peer window)", async () => {
  // The motivating scenario: the old connection's peer is unresponsive (laptop asleep).
  // A graceful close() against it stalls ~30s on ws's closeTimeout — the takeover path
  // must abort the old run and admit the new connection IMMEDIATELY, not after that.
  const a = await connect(PORT, token);
  a.ws._socket.pause(); // wedge A's TCP socket: it can no longer ack a close handshake
  const t0 = Date.now();
  const b = await connect(PORT, token, a.sessionId);
  const elapsed = Date.now() - t0;
  assert.equal(b.sessionId, a.sessionId, "B resumed A's session");
  assert.ok(
    elapsed < 3000,
    `B's takeover must complete immediately even with a wedged predecessor (took ${elapsed}ms)`
  );
  assert.equal(b.ws.readyState, WebSocket.OPEN);
  a.ws.terminate(); // hard-drop the wedged socket so the test doesn't leak it
  b.ws.close();
});

test("EADDRINUSE exits 1 with an actionable message, not a stack trace", async () => {
  const dup = startServer(PORT, repo);
  let err = "";
  dup.stderr.on("data", (d) => (err += d.toString()));
  const code = await new Promise((resolve) => dup.on("exit", resolve));
  assert.equal(code, 1);
  assert.match(err, /already in use/);
  assert.match(err, /--port/);
  assert.doesNotMatch(err, /at Server\.setupListenHandle/, "no raw stack trace");
});
