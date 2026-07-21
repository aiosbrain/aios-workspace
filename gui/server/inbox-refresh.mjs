import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  resolveSlackToken,
  SLACK_MPIM_UNAVAILABLE_MARKER,
} from "../../scaffold/.claude/descriptors/skills/slack-personal/slack-activity-pull.mjs";

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
export const TRUSTED_SLACK_ADAPTER = path.resolve(
  SCRIPT_DIR,
  "../../scaffold/.claude/descriptors/skills/slack-personal/slack-activity-pull.mjs"
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

/** Presence is an installation/opt-in marker only. Its bytes are never loaded or executed. */
export function slackRefreshOptInPath(repo) {
  return path.join(
    repo,
    ".claude",
    "descriptors",
    "skills",
    "slack-personal",
    "slack-activity-pull.mjs"
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

export function slackConnectorEnvironment(
  source = process.env,
  slackToken = source.SLACK_USER_TOKEN
) {
  const env = connectorEnvironment(source);
  if (typeof slackToken === "string" && slackToken) env.SLACK_USER_TOKEN = slackToken;
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

/** Run the reviewed Slack puller with only Slack-specific credentials crossing the child boundary. */
export async function runTrustedSlackAdapter(
  repo,
  {
    spawnProcess = spawn,
    env = process.env,
    resolveToken = resolveSlackToken,
    fetchImpl = fetch,
    timeoutMs = REFRESH_TIMEOUT_MS,
    termGraceMs = TERM_GRACE_MS,
    signal,
    isEnabled = (root) => existsSync(slackRefreshOptInPath(root)),
    platform = process.platform,
    killProcess = process.kill,
  } = {}
) {
  if (!existsSync(TRUSTED_SLACK_ADAPTER) || !isEnabled(repo)) {
    return { kind: "unavailable", slack: "unavailable" };
  }
  if (signal?.aborted) return { kind: "failed", slack: "failed" };

  let slackToken;
  try {
    // Brain credentials stay in the GUI process. The reviewed child gets the resolved Slack token
    // and the generic connector allowlist, but no AIOS API key or Brain routing metadata.
    slackToken = await resolveToken({ env, fetchImpl });
  } catch {
    return { kind: "failed", slack: "failed" };
  }

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
      child = spawnProcess(process.execPath, [TRUSTED_SLACK_ADAPTER, "--repo", repo], {
        cwd: path.dirname(TRUSTED_SLACK_ADAPTER),
        env: slackConnectorEnvironment(env, slackToken),
        stdio: ["ignore", "ignore", "pipe"],
        detached: platform !== "win32",
      });
    } catch {
      resolve({ kind: "failed", slack: "failed" });
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
      resolve({ kind: "failed", slack: "failed" });
    });
    child.once("close", (code) => {
      clearTimers();
      signal?.removeEventListener("abort", onAbort);
      if (timedOut || stopping || code !== 0) {
        resolve({ kind: "failed", slack: "failed" });
        return;
      }
      if (diagnostics.includes(SLACK_MPIM_UNAVAILABLE_MARKER)) {
        resolve({ kind: "degraded", slack: "degraded" });
        return;
      }
      resolve({ kind: "ready", slack: "ready" });
    });

    if (signal?.aborted) terminate(false);
    else signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => terminate(true), timeoutMs);
  });
}

export async function runInboxAdapters(repo, { signal } = {}) {
  const [gog, slack] = await Promise.all([
    runTrustedGogAdapter(repo, { signal }),
    runTrustedSlackAdapter(repo, { signal }),
  ]);
  const sources = {
    gmail: gog.gmail ?? (gog.kind === "unavailable" ? "unavailable" : "failed"),
    calendar: gog.calendar ?? (gog.kind === "unavailable" ? "unavailable" : "failed"),
    slack: slack.slack ?? (slack.kind === "unavailable" ? "unavailable" : "failed"),
  };
  const values = Object.values(sources);
  const successes = values.filter((status) => status === "ready").length;
  const failures = values.filter((status) => status === "failed").length;
  const kind =
    successes === values.length
      ? "ready"
      : successes > 0
        ? "degraded"
        : failures > 0
          ? "failed"
          : "unavailable";
  return { kind, ...sources };
}

export function createInboxRefresher({
  repo,
  run = ({ signal }) => runInboxAdapters(repo, { signal }),
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
    sources: {
      gmail: "unknown",
      calendar: "unknown",
      slack: "unknown",
      telegram: "outbound_only",
    },
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
        if (result.gmail) state.sources.gmail = result.gmail;
        if (result.calendar) state.sources.calendar = result.calendar;
        if (result.slack) state.sources.slack = result.slack;
        if (result.kind === "unavailable") {
          state.status = "unavailable";
          state.error = "Inbox connectors are not installed.";
          if (!result.gmail) state.sources.gmail = "unavailable";
          if (!result.calendar) state.sources.calendar = "unavailable";
          return snapshot();
        }
        if (result.kind === "failed") {
          state.status = "failed";
          state.error = "Inbox refresh failed.";
          if (!result.gmail) state.sources.gmail = "failed";
          if (!result.calendar) state.sources.calendar = "failed";
          return snapshot();
        }
        state.status = result.kind;
        state.sources.gmail = result.gmail ?? "ready";
        state.sources.calendar = result.calendar ?? "ready";
        // Freshness is honest: last_success_at advances only when at least one source succeeded.
        if (
          state.sources.gmail === "ready" ||
          state.sources.calendar === "ready" ||
          state.sources.slack === "ready"
        ) {
          state.last_success_at = now().toISOString();
        }
        state.error = result.kind === "degraded" ? "Some inbox sources could not refresh." : null;
        return snapshot();
      })
      .catch(() => {
        state.status = "failed";
        state.error = "Inbox refresh failed.";
        state.sources.gmail = "failed";
        state.sources.calendar = "failed";
        state.sources.slack = "failed";
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

/**
 * Install once: stop background components before the localhost server accepts process shutdown.
 * `stoppables` is the single, authoritative list — one component named in one place, so a caller
 * cannot half-update the set and leave a background loop running past shutdown.
 */
export function installInboxRefreshShutdown({
  stoppables = [],
  server,
  webSocketServer,
  processRef = process,
}) {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      // Each component is isolated: one that throws or hangs must not strand the rest, nor keep the
      // server accepting connections after a shutdown signal.
      for (const component of stoppables) {
        try {
          await component?.stop?.();
        } catch (error) {
          // A failed stop must not block the remaining shutdown sequence — but swallowing it
          // silently hides a component that may have left a timer or child process running.
          console.error(`[shutdown] component stop failed: ${error?.message ?? error}`);
        }
      }
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
