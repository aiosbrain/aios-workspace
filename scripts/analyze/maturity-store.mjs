/**
 * maturity-store.mjs — shared fold/read/write helpers for the maturity-loop NDJSON stores
 * under `.aios/loop/maturity/`: the AM1 per-session signals store (AIO-227) and the AM4a
 * correction-observations store (AIO-229).
 *
 * `sessions.ndjson` is append-only NDJSON of v1 `{"v":1,"op":"put","session":{...}}` lines.
 * State is the in-order fold: `op:"put"` is LAST-WINS per `session_id` (a resumed / post-/clear
 * re-fire with more events supersedes the earlier snapshot).
 *
 * `observations.ndjson` is append-only NDJSON of v1 `{"v":1,"op":"create","obs":{...}}` lines,
 * one per detected correction turn; dedupe key is `sha256(session_id|prior_hash)`.
 *
 * Both stores skip malformed / unknown-version lines (counted, never fatal — forward-compat:
 * readers ignore what they don't know) and share the lockfile protocol of
 * hooks/asks-capture.mjs verbatim (30s stale reclaim + ~1s bounded retries; dedup + cap
 * enforced INSIDE the lock). Writers NEVER throw — a busy lock or fs error means "skip",
 * because disturbing a session is never acceptable but a missed capture is.
 *
 * Both stores are admin-tier and local-only (`.aios/` is gitignored). Zero dependencies
 * (Node >= 18).
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const STORE_REL = ".aios/loop/maturity/sessions.ndjson";
export const OBS_STORE_REL = ".aios/loop/maturity/observations.ndjson";
export const SCHEMA_VERSION = 1;
const HARD_LINE_CAP = 20_000;
const OBS_HARD_LINE_CAP = 20_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40; // ~1s bounded retries; a missed capture is acceptable
const LOCK_DELAY_MS = 25;

export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export function storePath(root) {
  return path.join(root, STORE_REL);
}

export function obsStorePath(root) {
  return path.join(root, OBS_STORE_REL);
}

/**
 * Fold NDJSON store text → the latest session snapshot per session_id.
 * @returns {{sessions: Map<string, object>, warnings: number}}
 */
export function foldSessions(ndjsonText) {
  const sessions = new Map();
  let warnings = 0;
  if (!ndjsonText) return { sessions, warnings };
  for (const line of ndjsonText.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      warnings += 1;
      continue;
    }
    if (
      !o ||
      typeof o !== "object" ||
      o.v !== SCHEMA_VERSION ||
      o.op !== "put" ||
      !o.session ||
      typeof o.session.session_id !== "string"
    ) {
      warnings += 1;
      continue;
    }
    // Last-wins: a later put for the same session supersedes the earlier one.
    // Deleting first keeps Map order = order of the winning (latest) put.
    sessions.delete(o.session.session_id);
    sessions.set(o.session.session_id, o.session);
  }
  return { sessions, warnings };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Acquire the store lock, returning an fd or null (never throws — a busy lock means skip).
function acquireLock(lockPath) {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      return openSync(lockPath, "wx");
    } catch (e) {
      if (e?.code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* lost the reclaim race */
          }
          continue;
        }
      } catch {
        /* lock vanished — retry */
      }
      if (attempt < LOCK_RETRIES) sleepSync(LOCK_DELAY_MS);
    }
  }
  return null;
}

// Run `fn` while holding the store lock. Returns fn's result, or null on any failure (skip
// silently — a missed capture is acceptable, disturbing the session is not).
function withStoreLock(abs, fn) {
  const lockPath = abs + ".lock";
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
  } catch {
    return null;
  }
  const fd = acquireLock(lockPath);
  if (fd === null) return null;
  const token = randomUUID();
  try {
    try {
      writeFileSync(fd, `${process.pid} ${token} ${new Date().toISOString()}\n`);
    } catch {
      /* advisory stamp only */
    }
    closeSync(fd);
    return fn();
  } catch {
    return null;
  } finally {
    // Never delete a reclaimer's lock: only unlink if the file still carries our token.
    try {
      if (readFileSync(lockPath, "utf8").includes(token)) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

function buildPutLine(session) {
  return JSON.stringify({ v: SCHEMA_VERSION, op: "put", session });
}

/**
 * Append one `put` record for a session, under the store lock. The dedup + cap
 * read happens INSIDE the held lock so a concurrent writer cannot slip between
 * the check and the append. Returns true if a record was written (append or
 * compaction rewrite), false if skipped (idempotent re-fire, busy lock, fs error).
 *
 * @param {string} root workspace root (store lives at <root>/.aios/loop/maturity/…)
 * @param {object} session the v1 session object (must carry session_id + event_count)
 * @returns {boolean}
 */
export function appendSession(root, session) {
  const abs = storePath(root);
  const result = withStoreLock(abs, () => {
    let text = "";
    if (existsSync(abs)) {
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        return false;
      }
    }
    const { sessions } = foldSessions(text);

    // Dedup: same session_id at the same event_count is an idempotent re-fire.
    // event_count only grows, so comparing the folded latest snapshot is sufficient.
    const prev = sessions.get(session.session_id);
    const isDup = Boolean(prev && prev.event_count === session.event_count);

    // Cap check BEFORE the dedup early-return: an oversized store must compact
    // even when the triggering write is an idempotent re-fire (otherwise sessions
    // that keep resuming at the same event_count would pin the store oversized).
    const lineCount = text.split(/\r?\n/).filter((l) => l.trim()).length;
    try {
      if (lineCount > HARD_LINE_CAP) {
        // Compact: fold, apply this record (last-wins) if it's new, then rewrite
        // atomically (temp + rename) so a crash mid-write can't corrupt the store.
        // The lock is held across the whole fold → write → rename, so no append
        // can interleave.
        if (!isDup) {
          sessions.delete(session.session_id);
          sessions.set(session.session_id, session);
        }
        const out = [...sessions.values()].map((s) => buildPutLine(s)).join("\n") + "\n";
        const tmp = `${abs}.tmp`;
        writeFileSync(tmp, out);
        renameSync(tmp, abs);
        return !isDup;
      }
      if (isDup) return false;
      appendFileSync(abs, buildPutLine(session) + "\n");
    } catch {
      return false;
    }
    return true;
  });
  return result === true;
}

/**
 * Fold NDJSON observations store text → the set of dedupeKeys already present + line count.
 * Dedupe key is `sha256(session_id|prior_hash)` (AIO-229 / AM4a) — a repeat correction of the
 * same assistant tail in the same session is treated as the same observation.
 * @returns {{dedupeKeys: Set<string>, warnings: number, lineCount: number}}
 */
export function foldObservations(ndjsonText) {
  const dedupeKeys = new Set();
  let warnings = 0;
  let lineCount = 0;
  if (!ndjsonText) return { dedupeKeys, warnings, lineCount };
  for (const line of ndjsonText.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    lineCount += 1;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      warnings += 1;
      continue;
    }
    if (
      !o ||
      typeof o !== "object" ||
      o.v !== SCHEMA_VERSION ||
      o.op !== "create" ||
      !o.obs ||
      typeof o.obs.session_id !== "string" ||
      typeof o.obs.prior_hash !== "string"
    ) {
      warnings += 1;
      continue;
    }
    dedupeKeys.add(sha256(`${o.obs.session_id}|${o.obs.prior_hash}`));
  }
  return { dedupeKeys, warnings, lineCount };
}

function buildCreateObsLine(obs) {
  return JSON.stringify({ v: SCHEMA_VERSION, op: "create", obs });
}

/**
 * Append one `create` observation record, under the store lock. The dedup + cap read happens
 * INSIDE the held lock so a concurrent writer with the same key cannot slip between the check
 * and the append. Returns true if written, false if skipped (dup, busy lock, fs error, or an
 * unmaintained store over the hard cap).
 *
 * @param {string} root workspace root (store lives at <root>/.aios/loop/maturity/…)
 * @param {object} obs the v1 observation object (must carry session_id + prior_hash)
 * @returns {boolean}
 */
export function appendObservation(root, obs) {
  const abs = obsStorePath(root);
  const dedupeKey = sha256(`${obs.session_id}|${obs.prior_hash}`);
  const result = withStoreLock(abs, () => {
    let text = "";
    if (existsSync(abs)) {
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        return false;
      }
    }
    const { dedupeKeys, lineCount } = foldObservations(text);
    if (lineCount > OBS_HARD_LINE_CAP) return false; // unmaintained store — skip rather than pile on
    if (dedupeKeys.has(dedupeKey)) return false;
    try {
      appendFileSync(abs, buildCreateObsLine(obs) + "\n");
    } catch {
      return false;
    }
    return true;
  });
  return result === true;
}
