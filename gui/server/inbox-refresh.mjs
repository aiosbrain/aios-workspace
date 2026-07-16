import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export const DEFAULT_INBOX_REFRESH_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;
const MAX_REFRESH_MS = 30 * 60_000;
const REFRESH_TIMEOUT_MS = 45_000;
const MAX_DIAGNOSTIC_BYTES = 16_384;

function boundedInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_INBOX_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.floor(parsed)));
}

function adapterPath(repo) {
  return path.join(
    repo,
    ".claude",
    "descriptors",
    "skills",
    "gog-activity",
    "gog-activity-pull.mjs"
  );
}

function runAdapter(repo, { spawnProcess = spawn, timeoutMs = REFRESH_TIMEOUT_MS } = {}) {
  const file = adapterPath(repo);
  if (!existsSync(file)) return Promise.resolve({ kind: "unavailable" });

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let diagnostics = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    try {
      child = spawnProcess(process.execPath, [file, "--repo", repo], {
        cwd: path.dirname(file),
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      return resolve({ kind: "failed" });
    }

    child.stderr?.on("data", (chunk) => {
      if (diagnostics.length < MAX_DIAGNOSTIC_BYTES) {
        diagnostics += String(chunk).slice(0, MAX_DIAGNOSTIC_BYTES - diagnostics.length);
      }
    });
    child.once("error", () => finish({ kind: "failed" }));
    child.once("close", (code) => {
      if (code !== 0) return finish({ kind: "failed" });
      const gmailFailed = diagnostics.includes("gmail fetch failed");
      const calendarFailed = diagnostics.includes("calendar fetch failed");
      finish({
        kind: gmailFailed || calendarFailed ? "degraded" : "ready",
        gmail: gmailFailed ? "failed" : "ready",
        calendar: calendarFailed ? "failed" : "ready",
      });
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
        child.unref?.();
      } catch {
        // The bounded failure result is authoritative even if the child already exited.
      }
      finish({ kind: "failed" });
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * Owner-local Gmail/Calendar refresh coordinator. It never overlaps pulls, never exposes child output,
 * and reports only fixed, content-free states to the browser. Telegram is honest here too: the shipped
 * Bot API lane sends notifications but has no inbound getUpdates/webhook ingestion contract.
 */
export function createInboxRefresher({
  repo,
  run = () => runAdapter(repo),
  now = () => new Date(),
  intervalMs = process.env.AIOS_INBOX_REFRESH_MS,
  schedule = setInterval,
} = {}) {
  let inFlight = null;
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
    state.status = "refreshing";
    state.last_attempt_at = now().toISOString();
    state.error = null;
    inFlight = Promise.resolve()
      .then(run)
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
        state.last_success_at = now().toISOString();
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
      });
    return inFlight;
  };

  const start = () => {
    if (timer) return;
    void refresh();
    timer = schedule(() => void refresh(), boundedInterval(intervalMs));
    timer.unref?.();
  };

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return { refresh, snapshot, start, stop };
}
