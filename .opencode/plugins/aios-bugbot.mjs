/**
 * OpenCode adapter for the shared AIOS local Bugbot gate.
 *
 * This tracked adapter lives in the product repo's otherwise machine-local
 * `.opencode/` directory. Claude, Codex, and Cursor use native project Stop-hook
 * configs; OpenCode's available lifecycle point is `session.status = idle`.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const activeSessions = new Set();
const lastIdleCompletedAt = new Map();
const DUPLICATE_IDLE_WINDOW_MS = 2_000;
const GATE_TIMEOUT_MS = 86_400_000;

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

export function isDuplicateIdleResult(previous, result, now = Date.now()) {
  return Boolean(
    (previous?.status === "skipped" ||
      (previous?.status === "clear" && previous?.verified === true)) &&
    previous?.fingerprint &&
    result?.fingerprint &&
    previous.fingerprint === result.fingerprint &&
    now - previous.completedAt < DUPLICATE_IDLE_WINDOW_MS
  );
}

export async function enqueueContinuation(client, sessionID, reason) {
  if (typeof client?.session?.promptAsync !== "function") {
    throw new Error("OpenCode client does not expose session.promptAsync");
  }
  const response = await client.session.promptAsync({
    path: { id: sessionID },
    body: { parts: [{ type: "text", text: reason }] },
  });
  if (response?.error) {
    const detail = response.error.message || response.error.data || response.error;
    throw new Error(`OpenCode rejected the Bugbot continuation: ${String(detail)}`);
  }
  return response;
}

function isToolkitRepo(directory) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
    return pkg.name === "aios-workspace";
  } catch {
    return false;
  }
}

async function runGate(directory, { probe = false } = {}) {
  const gate = path.join(directory, "hooks", "local-bugbot-gate.mjs");
  if (!existsSync(gate)) return { status: "error", reason: "required gate script missing" };
  const { stdout } = await execFileAsync(
    process.execPath,
    [gate, "--runtime", "opencode", "--json", ...(probe ? ["--probe"] : [])],
    {
      cwd: directory,
      maxBuffer: 10 * 1024 * 1024,
      timeout: GATE_TIMEOUT_MS,
      killSignal: "SIGTERM",
      env: hardenedGateEnv(),
    }
  );
  return JSON.parse(stdout);
}

export const AIOSBugbot = async ({ directory, client }) => {
  if (!isToolkitRepo(directory)) return {};

  const claimIdle = (sessionID) => {
    if (!sessionID || activeSessions.has(sessionID)) return;
    // This claim is synchronous: both OpenCode event APIs share it before either can await.
    activeSessions.add(sessionID);
    return true;
  };

  const handleIdle = async (sessionID) => {
    if (!claimIdle(sessionID)) return;

    let result;
    try {
      const previous = lastIdleCompletedAt.get(sessionID);
      if (previous && Date.now() - previous.completedAt < DUPLICATE_IDLE_WINDOW_MS) {
        const probe = await runGate(directory, { probe: true });
        if (isDuplicateIdleResult(previous, probe)) return;
      }
      result = await runGate(directory);
    } catch (error) {
      result = {
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      activeSessions.delete(sessionID);
    }

    const completedAt = Date.now();
    lastIdleCompletedAt.set(sessionID, {
      completedAt,
      fingerprint: result.fingerprint,
      status: result.status,
      verified: result.verified === true,
    });

    if (["clear", "skipped"].includes(result.status)) return;

    const reason =
      result.reason ||
      [
        "Required local Bugbot review failed. Fix it before completing or merging.",
        result.output && `\nBugbot evidence:\n${result.output}`,
      ]
        .filter(Boolean)
        .join("\n");
    console.error(`[aios-bugbot] ${reason}`);

    // OpenCode's async endpoint acknowledges the enqueue without waiting for the
    // next agent turn. Await that acknowledgement so delivery errors propagate out
    // of the idle hook instead of becoming an unobserved completed session.
    try {
      await enqueueContinuation(client, sessionID, reason);
    } catch (error) {
      console.error(`[aios-bugbot] continuation failed: ${error.message}`);
      throw error;
    }
  };

  const handleStatus = async (sessionID, status) => {
    if (!sessionID) return;
    if (status === "idle") {
      await handleIdle(sessionID);
      return;
    }
    lastIdleCompletedAt.delete(sessionID);
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
