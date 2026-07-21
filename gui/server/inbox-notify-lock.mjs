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
 * A valid live owner always wins, regardless of age. A malformed/incomplete file is reclaimable
 * only after the stale threshold so another process cannot steal the lock between exclusive create
 * and metadata flush. Release re-verifies the exact owner bytes.
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

      if (validOwner(existing.value)) {
        try {
          probe(existing.value.pid, 0);
          return null;
        } catch (probeError) {
          if (probeError?.code !== "ESRCH") return null;
        }
      } else if (acquiredMs - modifiedMs < staleMs) {
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
