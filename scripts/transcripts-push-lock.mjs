import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { TranscriptCliError } from "./transcripts-runtime.mjs";

const MAX_ACQUIRE_ATTEMPTS = 8;
// The reclaim guard only ever wraps a few synchronous syscalls (no await, no I/O
// wait), so any guard older than this is definitively abandoned by a dead process.
const RECLAIM_GUARD_STALE_MS = 5000;

function busyError() {
  return new TranscriptCliError(
    "transcript push is busy/in-flight for this stage; retry after it completes",
    1
  );
}

function acquireError(reason, cause) {
  const code = cause?.code ? ` (${cause.code})` : "";
  return new TranscriptCliError(`${reason}${code}`, 1);
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
// owner-less lock: the target path only ever appears already containing its owner.
// Returns true if this process created the file, false if it already existed.
function createOwned(targetPath) {
  const scratch = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(scratch, `${process.pid}\n`, { mode: 0o600 });
  try {
    linkSync(scratch, targetPath);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(scratch, { force: true });
  }
}

// Serialize every reclaim of a given lock behind this guard so the "is the
// recorded owner dead?" probe and the removal of the stale lock cannot interleave
// with another reclaimer — the interleaving that could otherwise leave the lock
// momentarily free while a fresh live owner exists (a fail-open window). A leaked
// guard (holder SIGKILLed inside the microsecond guarded section) is stolen
// atomically via rename, so exactly one waiter recovers it.
function acquireReclaimGuard(guardPath) {
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    if (createOwned(guardPath)) return true;
    let info;
    try {
      info = statSync(guardPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue; // released between our create and stat
      return false;
    }
    if (Date.now() - info.mtimeMs < RECLAIM_GUARD_STALE_MS) return false; // active holder
    // Guard is provably abandoned. Steal it atomically — only one racer wins the
    // rename; everyone else observes ENOENT and retries the create.
    const captured = `${guardPath}.dead.${process.pid}.${randomUUID()}`;
    try {
      renameSync(guardPath, captured);
      rmSync(captured, { force: true });
    } catch {
      // lost the steal race (ENOENT) or a transient error — retry the loop.
    }
  }
  return false;
}

// Reclaim an abandoned lock. MUST run only while holding the reclaim guard.
// Under the guard the probe→remove is atomic w.r.t. every other actor: another
// reclaimer is excluded by the guard, and a non-reclaimer cannot create a lock at
// an already-occupied path (createOwned's link fails EEXIST). We therefore remove
// the lock only when its recorded owner is dead and leave a live owner untouched.
function reclaimUnderGuard(lockPath) {
  let probed;
  try {
    probed = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "gone"; // already released — just retry create
    throw error;
  }
  if (ownerAlive(ownerPid(probed))) return "busy"; // live (or reused) owner — fail closed
  rmSync(lockPath, { force: true });
  return "reclaimed";
}

// Best-effort removal of abandoned guard/scratch artifacts (a SIGKILL between
// scratch creation and its cleanup, or inside the guarded section, can strand a
// `.tmp.*`/`.dead.*`/`.reclaim` file). Only artifacts older than the guard-stale
// threshold are swept, so an in-flight acquisition is never disturbed. Live
// `.lock` files are left to the liveness-checked reclaim path above.
function sweepStaleArtifacts(directory) {
  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!/^transcript-push-.*(\.reclaim$|\.tmp\.|\.dead\.)/.test(name)) continue;
    const artifact = path.join(directory, name);
    try {
      if (now - statSync(artifact).mtimeMs > RECLAIM_GUARD_STALE_MS) {
        rmSync(artifact, { force: true });
      }
    } catch {
      // racing cleanup or permission issue — ignore.
    }
  }
}

export async function withTranscriptPushLock(root, stagePath, action) {
  const directory = path.join(root, ".aios", "locks");
  const lockPath = path.join(directory, `transcript-push-${path.basename(stagePath)}.lock`);
  const guardPath = `${lockPath}.reclaim`;
  mkdirSync(directory, { recursive: true });
  sweepStaleArtifacts(directory);

  let held = false;
  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS && !held; attempt += 1) {
    let created;
    try {
      created = createOwned(lockPath);
    } catch (error) {
      throw acquireError("failed to acquire transcript push lock", error);
    }
    if (created) {
      held = true;
      break;
    }
    let probed;
    try {
      probed = readFileSync(lockPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue; // released between our link attempt and read
      throw acquireError("failed to inspect transcript push lock", error);
    }
    if (ownerAlive(ownerPid(probed))) throw busyError();
    // Suspected stale. Reclaim under the guard so the probe→remove cannot race.
    if (!acquireReclaimGuard(guardPath)) continue; // another reclaimer is active — retry
    let outcome;
    try {
      outcome = reclaimUnderGuard(lockPath);
    } catch (error) {
      rmSync(guardPath, { force: true });
      throw acquireError("failed to reclaim transcript push lock", error);
    }
    rmSync(guardPath, { force: true });
    if (outcome === "busy") throw busyError(); // owner is alive / a fresh owner exists
    // "reclaimed" or "gone": loop and re-attempt the atomic create.
  }
  if (!held) throw busyError();

  try {
    return await action();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
