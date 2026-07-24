import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TranscriptCliError } from "./transcripts-runtime.mjs";

const MAX_ACQUIRE_ATTEMPTS = 8;

function busyError() {
  return new TranscriptCliError(
    "transcript push is busy/in-flight for this stage; retry after it completes",
    1
  );
}

function ownerPid(content) {
  const first = String(content).split("\n", 1)[0].trim();
  if (!/^\d+$/.test(first)) return null;
  const pid = Number.parseInt(first, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// Liveness probe that never delivers a real signal (signal 0 is the null signal).
// ESRCH => the recorded owner is gone; EPERM => it exists but is not ours (still
// alive). A null/corrupt owner is treated as dead so a garbage lock self-heals.
function ownerAlive(pid) {
  if (pid === null) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

// Publish the owner id into a scratch file FIRST, then atomically hard-link it
// into place. A concurrent reader therefore never observes a half-written,
// owner-less lock: the lock path only ever appears already containing its owner.
function createOwnedLock(lockPath) {
  const scratch = `${lockPath}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(scratch, `${process.pid}\n`, { mode: 0o600 });
  try {
    linkSync(scratch, lockPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(scratch, { force: true });
  }
}

// Atomically capture a lock we have probed as stale. Rename is exclusive: only
// one racer moves a given file instance and everyone else observes ENOENT, so
// two reclaimers never both "win". We keep the capture only when its bytes still
// match the stale owner we probed AND that owner is still dead; otherwise the
// file changed under us (a fresh, possibly live, owner) so we put it back
// untouched and fail closed rather than risk evicting a live holder.
function reclaimStaleLock(lockPath, probed) {
  const capture = `${lockPath}.steal.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, capture);
  } catch (error) {
    if (error?.code === "ENOENT") return "vanished";
    throw error;
  }
  const captured = readFileSync(capture, "utf8");
  if (captured === probed && !ownerAlive(ownerPid(captured))) {
    rmSync(capture, { force: true });
    return "reclaimed";
  }
  renameSync(capture, lockPath);
  return "busy";
}

export async function withTranscriptPushLock(root, stagePath, action) {
  const lockPath = path.join(
    root,
    ".aios",
    "locks",
    `transcript-push-${path.basename(stagePath)}.lock`
  );
  mkdirSync(path.dirname(lockPath), { recursive: true });

  let held = false;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS && !held; attempt += 1) {
    try {
      if (createOwnedLock(lockPath)) {
        held = true;
        break;
      }
    } catch {
      throw new TranscriptCliError("failed to acquire transcript push lock", 1);
    }
    let probed;
    try {
      probed = readFileSync(lockPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue; // released between our link attempt and read
      throw new TranscriptCliError("failed to inspect transcript push lock", 1);
    }
    if (ownerAlive(ownerPid(probed))) throw busyError();
    let outcome;
    try {
      outcome = reclaimStaleLock(lockPath, probed);
    } catch {
      throw new TranscriptCliError("failed to reclaim transcript push lock", 1);
    }
    if (outcome === "busy") throw busyError();
    // "reclaimed" or "vanished": loop and re-attempt the atomic create.
  }
  if (!held) throw busyError();

  try {
    return await action();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
