import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTelegramNotifyCoordinator } from "./inbox-notify-lock.mjs";

export const DEFAULT_NOTIFY_TICK_MS = 60_000;
export const DEFAULT_FAILURE_RETRY_MS = 5 * 60_000;
export const DEFAULT_MAX_SENDS_PER_TICK = 3;
const MIN_NOTIFY_TICK_MS = 15_000;
const MAX_NOTIFY_TICK_MS = 15 * 60_000;
const MAX_RETRY_ENTRIES = 1_000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOOP_DIST = path.join(SCRIPT_DIR, "..", "..", "dist", "operator-loop", "index.js");

async function loadCompiledLoop() {
  try {
    return await import(pathToFileURL(LOOP_DIST).href);
  } catch {
    return null;
  }
}

function boundedInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_NOTIFY_TICK_MS;
  return Math.min(MAX_NOTIFY_TICK_MS, Math.max(MIN_NOTIFY_TICK_MS, Math.floor(parsed)));
}

function boundedPositive(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(parsed)));
}

function itemTime(item) {
  const value = Date.parse(item?.ask?.createdAt || item?.ts || "");
  return Number.isFinite(value) ? value : 0;
}

export function isBlockingInboxItem(item) {
  return Boolean(
    item &&
      item.origin === "agent-event" &&
      item.ask?.status === "open" &&
      (item.bucket === "needs-you" || item.protected === true)
  );
}

function pruneRetryMap(retryAfter, eligibleIds) {
  for (const id of retryAfter.keys()) {
    if (!eligibleIds.has(id)) retryAfter.delete(id);
  }
  while (retryAfter.size > MAX_RETRY_ENTRIES) {
    retryAfter.delete(retryAfter.keys().next().value);
  }
}

function loopAvailable(loop) {
  return Boolean(
    loop &&
      typeof loop.buildInbox === "function" &&
      typeof loop.readJournalSegments === "function" &&
      typeof loop.foldNotificationState === "function" &&
      typeof loop.loadTelegramConfig === "function" &&
      typeof loop.projectNotification === "function" &&
      typeof loop.sendNotification === "function" &&
      typeof loop.createDurableNotifyJournal === "function"
  );
}

export function createTelegramNotifier({
  repo,
  loadLoop = loadCompiledLoop,
  env = process.env,
  now = () => new Date(),
  transport,
  intervalMs,
  failureRetryMs = DEFAULT_FAILURE_RETRY_MS,
  maxSendsPerTick = DEFAULT_MAX_SENDS_PER_TICK,
  schedule = setInterval,
  cancelSchedule = clearInterval,
  notifyCoordinator = createTelegramNotifyCoordinator({ repo }),
} = {}) {
  if (!repo) throw new Error("repo is required");

  const tickMs = boundedInterval(intervalMs ?? env.AIOS_NOTIFY_TICK_MS);
  const retryMs = boundedPositive(failureRetryMs, DEFAULT_FAILURE_RETRY_MS);
  const sendLimit = boundedPositive(maxSendsPerTick, DEFAULT_MAX_SENDS_PER_TICK, 10);
  const retryAfter = new Map();
  let timer = null;
  let inFlight = null;
  const state = {
    status: "unavailable",
    last_attempt_at: null,
    last_delivery_at: null,
    last_error: null,
  };

  const snapshot = () => ({ ...state });

  const runTick = async () => {
    const loop = await loadLoop();
    if (!loopAvailable(loop)) {
      state.status = "unavailable";
      state.last_error = "operator loop unavailable";
      return snapshot();
    }

    const cfg = loop.loadTelegramConfig(env);
    if (!cfg?.enabled || !cfg.token || !cfg.chatId) {
      state.status = "disabled";
      state.last_error = null;
      return snapshot();
    }
    if (state.status === "disabled" || state.status === "unavailable") {
      state.status = "configured";
      state.last_error = null;
    }

    const guarded = await notifyCoordinator.runExclusive(async () => {
      const view = loop.buildInbox(repo);
      const eligible = view.items.filter(isBlockingInboxItem);
      const eligibleIds = new Set(eligible.map((item) => item.id));
      pruneRetryMap(retryAfter, eligibleIds);

      const journal = loop.readJournalSegments(repo);
      const delivered = loop.foldNotificationState(journal.events);
      const atMs = now().getTime();
      const candidates = eligible
        .filter((item) => (delivered.get(item.id)?.delivery_attempts ?? 0) === 0)
        .filter((item) => (retryAfter.get(item.id) ?? 0) <= atMs)
        .sort((a, b) => itemTime(a) - itemTime(b) || a.id.localeCompare(b.id))
        .slice(0, sendLimit);

      if (candidates.length === 0) return;
      const appendEvent = loop.createDurableNotifyJournal(repo);
      for (const item of candidates) {
        const attemptedAt = now();
        state.last_attempt_at = attemptedAt.toISOString();
        try {
          const projection = loop.projectNotification({
            ask_id: item.id,
            count: 1,
            repo_label: path.basename(repo),
          });
          const result = await loop.sendNotification(projection, cfg, {
            appendEvent,
            now: attemptedAt,
            ...(transport ? { transport } : {}),
          });
          if (result.status === "delivery_attempted") {
            delivered.set(item.id, {
              ask_id: item.id,
              delivery_attempts: 1,
              last_delivery_at: attemptedAt.toISOString(),
              acked: false,
              last_ack_at: null,
            });
            retryAfter.delete(item.id);
            state.status = "delivery_ok";
            state.last_delivery_at = attemptedAt.toISOString();
            state.last_error = null;
          } else if (result.status === "disabled") {
            state.status = "disabled";
            state.last_error = null;
            break;
          } else {
            retryAfter.set(item.id, attemptedAt.getTime() + retryMs);
            state.status = "failed";
            state.last_error = "telegram delivery failed";
          }
        } catch {
          retryAfter.set(item.id, attemptedAt.getTime() + retryMs);
          state.status = "failed";
          state.last_error = "telegram delivery failed";
        }
      }
    });

    // Busy means another healthy process owns send/ack coordination. It is not a lane failure.
    if (!guarded.acquired) return snapshot();
    return snapshot();
  };

  const tick = () => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(runTick)
      .catch(() => {
        state.status = "failed";
        state.last_error = "telegram notifier failed";
        return snapshot();
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const start = () => {
    if (timer) return;
    void tick();
    timer = schedule(() => void tick(), tickMs);
    timer?.unref?.();
  };

  const stop = async () => {
    if (timer) {
      cancelSchedule(timer);
      timer = null;
    }
    if (inFlight) await inFlight;
  };

  return { tick, start, stop, snapshot };
}
