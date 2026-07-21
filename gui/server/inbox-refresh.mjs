import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

export const DEFAULT_INBOX_REFRESH_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;
const MAX_REFRESH_MS = 30 * 60_000;
const REFRESH_TIMEOUT_MS = 45_000;
const TERM_GRACE_MS = 1_000;
const MAX_DIAGNOSTIC_BYTES = 16_384;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SAFE_EXEC_PATH = [
  ...new Set([
    path.dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ]),
].join(path.delimiter);

/** Fixed toolkit-owned adapter. Selected workspaces provide data/config, never executable code. */
export const TRUSTED_GOG_ADAPTER = path.resolve(
  SCRIPT_DIR,
  "../../scaffold/.claude/descriptors/skills/gog-activity/gog-activity-pull.mjs"
);

/** Presence is an installation/opt-in marker only. Its bytes are never loaded or executed. */
export function gogRefreshOptInPath(repo) {
  return path.join(
    repo,
    ".claude",
    "descriptors",
    "skills",
    "gog-activity",
    "gog-activity-pull.mjs"
  );
}

const CHILD_ENV_KEYS = Object.freeze([
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "GOG_ACCOUNT",
]);

export function connectorEnvironment(source = process.env) {
  const env = { PATH: SAFE_EXEC_PATH };
  for (const key of CHILD_ENV_KEYS) {
    if (typeof source[key] === "string" && source[key]) env[key] = source[key];
  }
  return env;
}

function signalConnector(child, signal, { platform, killProcess }) {
  if (platform !== "win32" && Number.isSafeInteger(child.pid) && child.pid > 0) {
    try {
      killProcess(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child if group signalling is unavailable.
    }
  }
  child.kill(signal);
}

function boundedInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INBOX_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.floor(parsed)));
}

/**
 * Run only the reviewed toolkit adapter. Timeout and cancellation both wait for the child to really
 * exit: TERM, a bounded grace, then KILL. The returned promise cannot clear the refresher's in-flight
 * guard while an old connector process is still alive.
 */
export function runTrustedGogAdapter(
  repo,
  {
    spawnProcess = spawn,
    env = process.env,
    timeoutMs = REFRESH_TIMEOUT_MS,
    termGraceMs = TERM_GRACE_MS,
    signal,
    isEnabled = (root) => existsSync(gogRefreshOptInPath(root)),
    platform = process.platform,
    killProcess = process.kill,
  } = {}
) {
  if (!existsSync(TRUSTED_GOG_ADAPTER) || !isEnabled(repo)) {
    return Promise.resolve({ kind: "unavailable" });
  }
  if (signal?.aborted) return Promise.resolve({ kind: "failed" });

  return new Promise((resolve) => {
    let child;
    let diagnostics = "";
    let stopping = false;
    let timedOut = false;
    let timeout;
    let killTimer;

    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
    };
    const terminate = (fromTimeout = false) => {
      if (stopping) return;
      stopping = true;
      timedOut ||= fromTimeout;
      try {
        signalConnector(child, "SIGTERM", { platform, killProcess });
      } catch {
        // A close/error event owns settlement.
      }
      killTimer = setTimeout(() => {
        try {
          signalConnector(child, "SIGKILL", { platform, killProcess });
        } catch {
          // A close/error event owns settlement.
        }
      }, termGraceMs);
    };
    const onAbort = () => terminate(false);

    try {
      child = spawnProcess(process.execPath, [TRUSTED_GOG_ADAPTER, "--repo", repo], {
        cwd: path.dirname(TRUSTED_GOG_ADAPTER),
        env: connectorEnvironment(env),
        stdio: ["ignore", "ignore", "pipe"],
        detached: platform !== "win32",
      });
    } catch {
      resolve({ kind: "failed" });
      return;
    }

    child.stderr?.on("data", (chunk) => {
      if (diagnostics.length < MAX_DIAGNOSTIC_BYTES) {
        diagnostics += String(chunk).slice(0, MAX_DIAGNOSTIC_BYTES - diagnostics.length);
      }
    });
    child.once("error", () => {
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      resolve({ kind: "failed" });
    });
    child.once("close", (code) => {
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      if (timedOut || stopping || code !== 0) {
        resolve({ kind: "failed" });
        return;
      }
      const gmailFailed = diagnostics.includes("gmail fetch failed");
      const calendarFailed = diagnostics.includes("calendar fetch failed");
      if (gmailFailed && calendarFailed) {
        // Total ingestion failure: NOTHING refreshed. Reporting "degraded" here would let the
        // refresher stamp last_success_at for a run in which no source succeeded.
        resolve({ kind: "failed", gmail: "failed", calendar: "failed" });
        return;
      }
      resolve({
        kind: gmailFailed || calendarFailed ? "degraded" : "ready",
        gmail: gmailFailed ? "failed" : "ready",
        calendar: calendarFailed ? "failed" : "ready",
      });
    });

    if (signal?.aborted) terminate(false);
    else signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => terminate(true), timeoutMs);
  });
}

export function createInboxRefresher({
  repo,
  run = ({ signal }) => runTrustedGogAdapter(repo, { signal }),
  now = () => new Date(),
  intervalMs = process.env.AIOS_INBOX_REFRESH_MS,
  schedule = setInterval,
  cancelSchedule = clearInterval,
} = {}) {
  let inFlight = null;
  let controller = null;
  let timer = null;
  const state = {
    status: "idle",
    last_attempt_at: null,
    last_success_at: null,
    error: null,
    sources: { gmail: "unknown", calendar: "unknown", telegram: "outbound_only" },
  };

  const snapshot = () => ({ ...state, sources: { ...state.sources } });

  const refresh = () => {
    if (inFlight) return inFlight;
    controller = new AbortController();
    state.status = "refreshing";
    state.last_attempt_at = now().toISOString();
    state.error = null;
    inFlight = Promise.resolve()
      .then(() => run({ signal: controller.signal }))
      .then((result) => {
        if (result.kind === "unavailable") {
          state.status = "unavailable";
          state.error = "Gmail and Calendar connector is not installed.";
          state.sources.gmail = "unavailable";
          state.sources.calendar = "unavailable";
          return snapshot();
        }
        if (result.kind === "failed") {
          state.status = "failed";
          state.error = "Gmail and Calendar refresh failed.";
          state.sources.gmail = "failed";
          state.sources.calendar = "failed";
          return snapshot();
        }
        state.status = result.kind;
        state.sources.gmail = result.gmail ?? "ready";
        state.sources.calendar = result.calendar ?? "ready";
        // Freshness is honest: last_success_at advances only when at least one source succeeded.
        if (state.sources.gmail === "ready" || state.sources.calendar === "ready") {
          state.last_success_at = now().toISOString();
        }
        state.error = result.kind === "degraded" ? "Some inbox sources could not refresh." : null;
        return snapshot();
      })
      .catch(() => {
        state.status = "failed";
        state.error = "Gmail and Calendar refresh failed.";
        state.sources.gmail = "failed";
        state.sources.calendar = "failed";
        return snapshot();
      })
      .finally(() => {
        inFlight = null;
        controller = null;
      });
    return inFlight;
  };

  const start = () => {
    if (timer) return;
    void refresh();
    timer = schedule(() => void refresh(), boundedInterval(intervalMs));
    timer.unref?.();
  };

  const stop = async () => {
    if (timer) cancelSchedule(timer);
    timer = null;
    controller?.abort();
    await inFlight;
  };

  return { refresh, snapshot, start, stop };
}

/** Install once: stop background components before the localhost server accepts process shutdown. */
export function installInboxRefreshShutdown({
  refresher,
  stoppables = [refresher],
  server,
  webSocketServer,
  processRef = process,
}) {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      for (const component of stoppables) await component?.stop?.();
    } finally {
      for (const client of webSocketServer?.clients ?? []) client.terminate?.();
      webSocketServer?.close?.();
      server.close();
      server.closeAllConnections?.();
    }
  };
  processRef.once("SIGTERM", shutdown);
  processRef.once("SIGINT", shutdown);
  return shutdown;
}
