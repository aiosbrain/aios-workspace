import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export const TELEGRAM_NOTIFY_LOCK_BASENAME = path.join(
  ".aios",
  "loop",
  "inbox",
  "telegram-notify.lock"
);
export const DEFAULT_NOTIFY_LOCK_STALE_MS = 5 * 60_000;
/** Slack allowed before a timestamp is treated as "from the future" — see the aging rules below. */
export const FUTURE_SKEW_TOLERANCE_MS = 1_000;

function validOwner(value) {
  return (
    value &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.acquired_at === "string"
  );
}

/**
 * Per-process memo of locks whose timestamps cannot be believed: lockPath -> {raw, at}.
 *
 * Only consulted when neither `acquired_at` nor mtime is usable, where the file itself can no longer
 * tell us how old it is. Measuring instead from OUR first sighting of those exact bytes separates
 * the two indistinguishable causes: a backward clock correction resolves within seconds (the holder
 * finishes and releases, so the window never elapses and we never steal), while a corrupt or
 * restored stamp persists across ticks until the window does elapse and the lane recovers.
 *
 * Keyed on the raw bytes, so a replacement lock restarts the window rather than inheriting it.
 */
const unageableSightings = new Map();

function unageableFor(lockPath, raw, nowMs) {
  const seen = unageableSightings.get(lockPath);
  if (!seen || seen.raw !== raw) {
    unageableSightings.set(lockPath, { raw, at: nowMs });
    return 0;
  }
  // A backward clock jump can put `nowMs` behind the sighting; never report a negative age.
  return Math.max(0, nowMs - seen.at);
}

function readOwner(lockPath) {
  const raw = readFileSync(lockPath, "utf8");
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    return { raw, value: null };
  }
}

/**
 * Acquire the repo-scoped Telegram notify/ack lock.
 *
 * Reclaim rules, in order:
 *   1. A valid owner whose pid is DEAD (probe → ESRCH) is reclaimed immediately.
 *   2. Any owner — valid and live included — is reclaimed once the file is older than `staleMs`.
 *   3. Otherwise the incumbent wins. A malformed/incomplete file is therefore also protected until
 *      the threshold, so another process cannot steal the lock between exclusive create and
 *      metadata flush.
 *
 * Rule 2 exists because liveness alone is not proof of ownership: after an unclean exit the OS may
 * recycle the recorded pid for an unrelated process, and a probe-only policy would then treat the
 * lock as held forever — silently killing every alert and every acknowledgment until a human
 * deleted the file. Every legitimate hold is bounded far below the threshold (the notifier sends at
 * most `maxSendsPerTick` messages, each capped by TELEGRAM_REQUEST_TIMEOUT_MS), so an age-based
 * reclaim cannot preempt a healthy holder. The residual risk if one somehow overruns is a duplicate
 * content-free alert — strictly better than a permanent deadlock.
 *
 * Release re-verifies the exact owner bytes, so a process that lost its lock to rule 2 never
 * unlinks its successor's file.
 */
export function acquireTelegramNotifyLock(
  repo,
  {
    pid = process.pid,
    token = randomUUID(),
    probe = process.kill,
    now = () => new Date(),
    staleMs = DEFAULT_NOTIFY_LOCK_STALE_MS,
  } = {}
) {
  const lockPath = path.join(repo, TELEGRAM_NOTIFY_LOCK_BASENAME);
  const acquiredAt = now();
  const acquiredMs = acquiredAt instanceof Date ? acquiredAt.getTime() : Date.parse(acquiredAt);
  const owner = JSON.stringify({
    pid,
    token,
    acquired_at: new Date(acquiredMs).toISOString(),
  });
  mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, owner, "utf8");
      } finally {
        closeSync(fd);
      }
      // We own it now; any prior unageable sighting describes a file that no longer exists.
      unageableSightings.delete(lockPath);
      return () => {
        try {
          if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath);
        } catch {
          // Best effort. Never unlink when ownership cannot be re-verified.
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;

      let existing;
      let modifiedMs;
      try {
        existing = readOwner(lockPath);
        modifiedMs = statSync(lockPath).mtimeMs;
      } catch {
        return null;
      }

      // Age the lock from the first timestamp we can believe — the owner's own `acquired_at`
      // (written atomically with the record) ahead of mtime (perturbed by copies and restores).
      //
      // A timestamp in the FUTURE is not believable, and BOTH can be: a forward clock jump that was
      // later reset, or a restored file. The tolerance absorbs ordinary jitter — `mtimeMs` carries
      // sub-millisecond precision while `Date.now()` truncates to whole ms, so a lock created
      // microseconds ago can read as marginally "future".
      const believable = (value) =>
        Number.isFinite(value) && value <= acquiredMs + FUTURE_SKEW_TOLERANCE_MS;
      const ownerMs = Date.parse(existing.value?.acquired_at ?? "");
      const bornMs = believable(ownerMs) ? ownerMs : believable(modifiedMs) ? modifiedMs : null;
      // When NEITHER timestamp is believable the file cannot be aged at all. Treating it as instantly
      // reclaimable would let a BACKWARD clock correction (which makes a healthy holder's stamps look
      // future-dated) steal the lock from a process that is mid-send — two notifiers, duplicate
      // alerts. Treating it as never reclaimable restores the permanent deadlock. So fall back to
      // aging it against our OWN continuous observation of it: a clock anomaly resolves in seconds
      // and the window never elapses, while a genuinely corrupt stamp persists and eventually frees.
      const expired =
        bornMs === null
          ? unageableFor(lockPath, existing.raw, acquiredMs) >= staleMs
          : acquiredMs - bornMs >= staleMs;

      // "Alive" means the pid answers OR answers with EPERM — a process owned by another user still
      // exists, so it is a holder, not a corpse. Only ESRCH proves the owner is gone. A malformed
      // record has no pid to probe and is therefore treated as held until it goes stale.
      let ownerAlive = true;
      if (validOwner(existing.value)) {
        try {
          probe(existing.value.pid, 0);
        } catch (probeError) {
          ownerAlive = probeError?.code !== "ESRCH";
        }
      }
      // A dead owner is reclaimed at once; a live one only once the lock is genuinely stale. The age
      // test applies uniformly — an EPERM owner must not be exempt from it, or a hung process under
      // another account wedges the lane forever.
      if (ownerAlive && !expired) return null;

      try {
        if (readFileSync(lockPath, "utf8") === existing.raw) unlinkSync(lockPath);
        else return null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function createTelegramNotifyCoordinator({
  repo,
  acquire = (root) => acquireTelegramNotifyLock(root),
} = {}) {
  if (!repo) throw new Error("repo is required");
  return {
    async runExclusive(operation) {
      const release = acquire(repo);
      if (!release) return { acquired: false };
      try {
        return { acquired: true, value: await operation() };
      } finally {
        release();
      }
    },
  };
}
