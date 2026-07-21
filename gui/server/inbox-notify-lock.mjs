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

      // Age from the owner's OWN recorded timestamp when it has one — it is written atomically with
      // the rest of the owner record, where mtime can be perturbed by copies, restores, and clock
      // skew. A malformed record has no timestamp to trust, so it falls back to mtime.
      //
      // A record stamped in the FUTURE (forward clock jump, restored backup, hand-edited file) is
      // not trustworthy and must not be honoured: its age would never reach the threshold,
      // resurrecting exactly the permanent deadlock rule 2 exists to prevent. Fall back to mtime,
      // which the filesystem stamps on this machine's clock.
      const ownerMs = Date.parse(existing.value?.acquired_at ?? "");
      const trustworthy = Number.isFinite(ownerMs) && ownerMs <= acquiredMs;
      const bornMs = trustworthy ? ownerMs : modifiedMs;
      const expired = acquiredMs - bornMs >= staleMs;
      if (validOwner(existing.value)) {
        try {
          probe(existing.value.pid, 0);
          // The pid answers. Yield unless the file has outlived any legitimate hold — see rule 2.
          if (!expired) return null;
        } catch (probeError) {
          if (probeError?.code !== "ESRCH") return null;
        }
      } else if (!expired) {
        return null;
      }

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
