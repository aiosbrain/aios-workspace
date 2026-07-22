import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTelegramNotifyCoordinator } from "./inbox-notify-lock.mjs";

export const DEFAULT_NOTIFY_TICK_MS = 60_000;
export const DEFAULT_FAILURE_RETRY_MS = 5 * 60_000;
export const DEFAULT_MAX_SENDS_PER_TICK = 3;
/** Ceiling on the exponential retry backoff — a hard failure (revoked token) must not hot-loop
 *  against the Bot API every 5 minutes forever. */
export const MAX_FAILURE_RETRY_MS = 60 * 60_000;
/** Async (event-loop-yielding) wait for a contended inbox journal before a send. ~1s total. */
const JOURNAL_WAIT_ATTEMPTS = 40;
const JOURNAL_WAIT_STEP_MS = 25;
const MIN_NOTIFY_TICK_MS = 15_000;
const MAX_NOTIFY_TICK_MS = 15 * 60_000;
const MAX_RETRY_ENTRIES = 1_000;

/**
 * The GUI's outbound lane reads ONLY the AIOS-scoped Telegram vars.
 *
 * `loadTelegramConfig` also accepts bare `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, which is right
 * for the CLI but wrong here: this notifier starts automatically with the GUI, and those generic
 * names commonly belong to a DIFFERENT bot in a shared environment (Hermes is the workspace's
 * Telegram gateway). Honouring them would silently push AIOS ask alerts through someone else's bot
 * and chat the first time `npm run gui` ran. Opting in is therefore explicit: name the vars for AIOS.
 */
export function scopedTelegramEnv(env = {}) {
  return {
    AIOS_TELEGRAM_BOT_TOKEN: env.AIOS_TELEGRAM_BOT_TOKEN,
    AIOS_TELEGRAM_CHAT_ID: env.AIOS_TELEGRAM_CHAT_ID,
    AIOS_TELEGRAM_DISABLED: env.AIOS_TELEGRAM_DISABLED,
  };
}

/** True when the lane is dormant only because the credentials use the unscoped names. Lets the
 *  status say WHY instead of looking indistinguishable from "no Telegram configured at all". */
function hasUnscopedTelegramCredentials(env = {}) {
  const present = (v) => typeof v === "string" && v.trim().length > 0;
  return (
    present(env.TELEGRAM_BOT_TOKEN) &&
    present(env.TELEGRAM_CHAT_ID) &&
    !(present(env.AIOS_TELEGRAM_BOT_TOKEN) && present(env.AIOS_TELEGRAM_CHAT_ID))
  );
}
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

function pruneRetryMap(retryAfter, failures, eligibleIds) {
  for (const id of retryAfter.keys()) {
    if (!eligibleIds.has(id)) retryAfter.delete(id);
  }
  while (retryAfter.size > MAX_RETRY_ENTRIES) {
    retryAfter.delete(retryAfter.keys().next().value);
  }
  // The failure counter only exists to shape the backoff of a pending retry; drop it in lockstep so
  // a long-lived process cannot accumulate counters for asks that are long gone.
  for (const id of failures.keys()) {
    if (!retryAfter.has(id)) failures.delete(id);
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
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  notifyCoordinator = createTelegramNotifyCoordinator({ repo }),
} = {}) {
  if (!repo) throw new Error("repo is required");

  const tickMs = boundedInterval(intervalMs ?? env.AIOS_NOTIFY_TICK_MS);
  const retryMs = boundedPositive(failureRetryMs, DEFAULT_FAILURE_RETRY_MS);
  const sendLimit = boundedPositive(maxSendsPerTick, DEFAULT_MAX_SENDS_PER_TICK, 10);
  const retryAfter = new Map();
  const failures = new Map();
  let timer = null;
  let inFlight = null;
  const state = {
    status: "unavailable",
    last_attempt_at: null,
    last_delivery_at: null,
    last_error: null,
  };

  const snapshot = () => ({ ...state });

  /** Exponential, capped backoff. Without it a permanently rejected send (revoked token) retries
   *  every ask on a flat 5-minute cadence for the life of the process. */
  const scheduleRetry = (id, atMs) => {
    const attempt = (failures.get(id) ?? 0) + 1;
    failures.set(id, attempt);
    retryAfter.set(id, atMs + Math.min(MAX_FAILURE_RETRY_MS, retryMs * 2 ** (attempt - 1)));
  };

  const clearRetry = (id) => {
    retryAfter.delete(id);
    failures.delete(id);
  };

  /**
   * Yield (asynchronously) until no live writer holds the inbox journal lock.
   *
   * Deliberately NOT the journal's own retry: that backs off with `sleepSync` (Atomics.wait), which
   * parks the entire thread. This runs on the GUI server's event loop, so it must give the loop back
   * between probes. Returns false if the budget is exhausted while still contended.
   */
  const waitForJournalIdle = async (loop) => {
    if (typeof loop.inboxJournalLockHeld !== "function") return true; // older loop build — proceed
    for (let attempt = 0; attempt <= JOURNAL_WAIT_ATTEMPTS; attempt++) {
      if (!loop.inboxJournalLockHeld(repo)) return true;
      if (attempt < JOURNAL_WAIT_ATTEMPTS) await delay(JOURNAL_WAIT_STEP_MS);
    }
    return !loop.inboxJournalLockHeld(repo);
  };

  /** The lane is only "failed" while something is actually waiting to go out. Once every failed ask
   *  has been answered or archived there is nothing outstanding, so a latched failure would report a
   *  broken lane forever — and train the operator to ignore the one indicator that matters. */
  const settleIdleStatus = () => {
    if (retryAfter.size > 0) return;
    if (state.status !== "failed" && state.status !== "degraded") return;
    state.status = state.last_delivery_at ? "delivery_ok" : "configured";
    state.last_error = null;
  };

  const runTick = async () => {
    const loop = await loadLoop();
    if (!loopAvailable(loop)) {
      state.status = "unavailable";
      state.last_error = "operator loop unavailable";
      return snapshot();
    }

    const cfg = loop.loadTelegramConfig(scopedTelegramEnv(env));
    if (!cfg?.enabled || !cfg.token || !cfg.chatId) {
      state.status = "disabled";
      // Content-free: names the env vars to set, never a token, chat id, or ask detail.
      state.last_error = hasUnscopedTelegramCredentials(env)
        ? "set AIOS_TELEGRAM_BOT_TOKEN and AIOS_TELEGRAM_CHAT_ID to enable the AIOS alert lane"
        : null;
      return snapshot();
    }
    if (state.status === "disabled" || state.status === "unavailable") {
      state.status = "configured";
      state.last_error = null;
    }

    // A failure to acquire means another healthy process owns send/ack coordination this tick. That
    // is contention, not a lane failure, so there is deliberately nothing to branch on: the status
    // is left exactly as the last tick that DID run left it.
    await notifyCoordinator.runExclusive(async () => {
      const view = loop.buildInbox(repo);
      const eligible = view.items.filter(isBlockingInboxItem);
      const eligibleIds = new Set(eligible.map((item) => item.id));
      pruneRetryMap(retryAfter, failures, eligibleIds);

      const journal = loop.readJournalSegments(repo);
      const delivered = loop.foldNotificationState(journal.events);
      const atMs = now().getTime();
      const candidates = eligible
        .filter((item) => (delivered.get(item.id)?.delivery_attempts ?? 0) === 0)
        .filter((item) => (retryAfter.get(item.id) ?? 0) <= atMs)
        .sort((a, b) => itemTime(a) - itemTime(b) || a.id.localeCompare(b.id))
        .slice(0, sendLimit);

      if (candidates.length === 0) {
        settleIdleStatus();
        return;
      }
      // `lockRetries: 0` keeps the append OFF the blocking path. The journal lock is shared with the
      // CLI, connector ingestion and compaction, and its default backoff is `sleepSync`
      // (Atomics.wait) — on this single-threaded server that would stall every HTTP request and
      // WebSocket agent stream, while this tick also holds the cross-process notify coordinator.
      const appendEvent = loop.createDurableNotifyJournal(repo, { lockRetries: 0 });
      let deliveredThisTick = false;
      let failedThisTick = false;
      let disabledThisTick = false;
      let deferredThisTick = false;
      for (const item of candidates) {
        const attemptedAt = now();
        try {
          const current = loop.buildInbox(repo).items.find((row) => row.id === item.id);
          if (!isBlockingInboxItem(current)) {
            clearRetry(item.id);
            continue;
          }
          // Wait for the journal BEFORE the wire call, never after. `sendNotification` appends its
          // `delivery-attempted` record synchronously once Telegram accepts, so a contended journal
          // at that moment would either park the whole server thread (the blocking default) or lose
          // the record and re-alert later (a duplicate). Yielding here is async — the event loop
          // keeps serving — and it leaves the append overwhelmingly likely to succeed first try.
          if (!(await waitForJournalIdle(loop))) {
            // Still contended after the budget: defer this ask rather than send-and-maybe-not-record.
            scheduleRetry(item.id, attemptedAt.getTime());
            deferredThisTick = true;
            continue;
          }
          state.last_attempt_at = attemptedAt.toISOString();
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
            clearRetry(item.id);
            deliveredThisTick = true;
            state.last_delivery_at = attemptedAt.toISOString();
          } else if (result.status === "disabled") {
            disabledThisTick = true;
            break;
          } else {
            scheduleRetry(item.id, attemptedAt.getTime());
            failedThisTick = true;
          }
        } catch {
          scheduleRetry(item.id, attemptedAt.getTime());
          failedThisTick = true;
        }
      }
      if (disabledThisTick) {
        state.status = "disabled";
        state.last_error = null;
      } else if (deliveredThisTick && failedThisTick) {
        state.status = "degraded";
        state.last_error = "some telegram deliveries failed";
      } else if (failedThisTick) {
        state.status = "failed";
        state.last_error = "telegram delivery failed";
      } else if (deferredThisTick) {
        // An alert that could not be journalled was NOT sent. Reporting the lane as ready here would
        // read as "armed" while nothing goes out — the operator's only signal that outbound alerting
        // has stalled. Content-free: names the contended resource, never an ask or a credential.
        state.status = "degraded";
        state.last_error = "inbox journal busy — alerts deferred";
      } else if (deliveredThisTick) {
        state.status = "delivery_ok";
        state.last_error = null;
      } else {
        // Every candidate was skipped — each had already stopped being a blocking ask, so there is
        // genuinely nothing outstanding and a latched failure may clear.
        settleIdleStatus();
      }
    });

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
