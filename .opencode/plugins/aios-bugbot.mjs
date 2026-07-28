/**
 * OpenCode adapter for the shared AIOS local Bugbot gate — ADVISORY ONLY (AIO-567).
 *
 * This tracked adapter lives in the product repo's otherwise machine-local
 * `.opencode/` directory. Claude, Codex, and Cursor use native project Stop-hook
 * configs; OpenCode's available lifecycle point is `session.status = idle`.
 *
 * On idle it runs the shared gate's plain (advisory) invocation — a cheap probe, never a
 * spawned review — and logs the advisory once per changeset. It NEVER re-prompts the
 * session and never blocks: blocking verdicts live at merge time (`aios build --merge` /
 * `aios ship`) and at the PR gates (cloud Bugbot, CodeRabbit, CI).
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const activeSessions = new Set();
// One advisory per unchanged changeset per session — an unchanged nudge on every idle is
// noise, and noise is how advisories get ignored.
const lastAdvisoryFingerprint = new Map();
// The advisory probe is local git work plus one canonical ls-remote; this cap only guards
// against a wedged child, not a 15-minute review (the Stop path never runs one).
const GATE_TIMEOUT_MS = 600_000;

export function hardenedGateEnv(source = process.env) {
  const env = { ...source };
  for (const key of [
    "AIOS_BUGBOT_MODEL",
    "AIOS_BUGBOT_HOOK_NONCE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "BASH_ENV",
    "ENV",
    "CDPATH",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_") ||
      /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key) ||
      key === "SSL_CERT_FILE" ||
      key === "SSL_CERT_DIR"
    ) {
      delete env[key];
    }
  }
  return env;
}

function isToolkitRepo(directory) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    return pkg.name === "aios-workspace";
  } catch {
    return false;
  }
}

async function runAdvisoryGate(directory) {
  const gate = path.join(directory, "hooks", "local-bugbot-gate.mjs");
  if (!existsSync(gate)) {
    return {
      status: "advisory",
      advisory:
        "[local-bugbot advisory] required gate script missing (hooks/local-bugbot-gate.mjs)",
    };
  }
  // Plain invocation = the gate's advisory mode. Never pass --json/--check-exit here:
  // those flags select the full (blocking-capable) review sweep for manual/CI use.
  const { stdout } = await execFileAsync(process.execPath, [gate, "--runtime", "opencode"], {
    cwd: directory,
    maxBuffer: 10 * 1024 * 1024,
    timeout: GATE_TIMEOUT_MS,
    killSignal: "SIGTERM",
    env: hardenedGateEnv(),
  });
  return JSON.parse(stdout);
}

export const AIOSBugbot = async ({ directory }) => {
  if (!isToolkitRepo(directory)) return {};

  const handleIdle = async (sessionID) => {
    if (!sessionID || activeSessions.has(sessionID)) return;
    // This claim is synchronous: both OpenCode event APIs share it before either can await.
    activeSessions.add(sessionID);
    try {
      const result = await runAdvisoryGate(directory);
      if (!result?.advisory) return;
      if (result.fingerprint && lastAdvisoryFingerprint.get(sessionID) === result.fingerprint) {
        return;
      }
      if (result.fingerprint) lastAdvisoryFingerprint.set(sessionID, result.fingerprint);
      console.error(`[aios-bugbot] ${result.advisory}`);
    } catch (error) {
      // Advisory only: a failed probe is logged, never escalated into a block or a
      // session continuation (that synchronous, session-freezing behavior is the six
      // incidents AIO-567 removed).
      console.error(
        `[aios-bugbot] advisory probe failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      activeSessions.delete(sessionID);
    }
  };

  const handleStatus = async (sessionID, status) => {
    if (!sessionID) return;
    if (status === "idle") {
      await handleIdle(sessionID);
      return;
    }
    lastAdvisoryFingerprint.delete(sessionID);
  };

  return {
    // Pinned OpenCode releases expose the direct event hook. Accept both the legacy
    // string status and the current `{ type: "idle" }` status object.
    "session.status": async (input) => {
      const status = typeof input?.status === "string" ? input.status : input?.status?.type;
      await handleStatus(input?.sessionID, status);
    },
    // Current OpenCode publishes the explicit `session.idle` event through `event`.
    event: async ({ event }) => {
      if (event?.type === "session.idle") await handleIdle(event.properties?.sessionID);
      if (event?.type === "session.status") {
        const status =
          typeof event.properties?.status === "string"
            ? event.properties.status
            : event.properties?.status?.type;
        await handleStatus(event.properties?.sessionID, status);
      }
    },
  };
};

export default AIOSBugbot;
