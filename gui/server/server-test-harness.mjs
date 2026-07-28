// Shared boot harness for the GUI-server integration tests.
//
// Both `ws-session-guard.test.mjs` (session lifecycle) and
// `config-models-runtime.test.mjs` (runtime-aware catalogs) spawn the REAL server
// against a throwaway workspace, so the spawn + "wait for the startup banner" pair
// lives here once instead of drifting in two copies.
//
// NOT named *.test.mjs on purpose — `node --test gui/server/*.test.mjs` must not
// try to run this file as a suite.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs");

/** Spawn the real GUI server over `repoDir` on `port`. Caller owns killing it. */
export function startServer(port, repoDir, env = {}) {
  return spawn(process.execPath, [SERVER, "--repo", repoDir, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    // The adapter idles in these tests; no model call is ever made.
    env: { ...process.env, ANTHROPIC_API_KEY: "", ...env },
  });
}

/**
 * Resolve once the server prints its startup banner
 * ("open: http://127.0.0.1:PORT/?token=…") → { token, port }. Rejects with the
 * captured output if it exits first, so a boot failure is readable.
 */
export function waitForBanner(proc, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(
      () => reject(new Error(`server did not start in ${timeoutMs}ms:\n${out}\n${err}`)),
      timeoutMs
    );
    proc.stderr?.on("data", (d) => (err += d.toString()));
    proc.stdout.on("data", (d) => {
      out += d.toString();
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([a-f0-9]+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ port: Number(m[1]), token: m[2] });
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code} before ready:\n${out}\n${err}`));
    });
  });
}

/** Back-compat alias: the token alone, which is all the session-guard suite needs. */
export async function waitForToken(proc, timeoutMs = 30000) {
  return (await waitForBanner(proc, timeoutMs)).token;
}

/** Reserve a free TCP port by binding :0 and immediately releasing it. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Minimal but real workspace root: aios.yaml is what marks a dir as a workspace. */
export function makeWorkspace(extraYaml = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-gui-test-"));
  writeFileSync(
    path.join(dir, "aios.yaml"),
    ["version: 1", 'brain_url: ""', 'team_id: ""', extraYaml].filter(Boolean).join("\n") + "\n"
  );
  return dir;
}

/**
 * Boot the server on its own free port over its own throwaway workspace and return
 * a handle with a token-gated `get`/`post` and a `stop()`. For suites that need a
 * DIFFERENT aios.yaml per case (one shared server can't vary its config).
 */
export async function bootServer(repo) {
  const port = await freePort();
  const child = startServer(port, repo);
  const { token } = await waitForBanner(child);
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    token,
    wsUrl: `ws://127.0.0.1:${port}`,
    async get(p) {
      const res = await fetch(`${base}${p}${p.includes("?") ? "&" : "?"}token=${token}`);
      return { status: res.status, body: await res.json() };
    },
    async post(p, payload) {
      const res = await fetch(`${base}${p}?token=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
    stop() {
      child.kill("SIGKILL");
    },
  };
}

/** Run `fn` against a freshly booted server over a throwaway workspace, then clean up. */
export async function withServer(extraYaml, fn) {
  const repo = makeWorkspace(extraYaml);
  const srv = await bootServer(repo);
  try {
    await fn(srv, repo);
  } finally {
    srv.stop();
    rmSync(repo, { recursive: true, force: true });
  }
}
