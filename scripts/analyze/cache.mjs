/**
 * cache.mjs — per-file parse cache for `aios analyze` (AIO-189).
 *
 * `aios analyze` was stateless: every run re-discovered and re-parsed ~1.5GB of
 * session transcripts. This module caches each transcript's parse so a run only
 * reads bytes that are new since the last run.
 *
 * ── DESIGN: the per-file partial shape ──────────────────────────────────────
 * The cached partial for a file is its full NormalizedEvent[] (the parser
 * output), NOT per-day signal partials. Per-day (or any pre-reduced) partials
 * cannot reproduce the cold pipeline exactly, because the global reduce is not
 * day-separable:
 *   1. The `--since` window boundary is millisecond-precise (now − Nd), so the
 *      boundary day is split mid-day — day-level partials get it wrong.
 *   2. `concurrent_sessions_peak` needs the max distinct session_ids per global
 *      5-min bucket — sessions from different files share buckets, so the
 *      per-file partial would have to be per-(bucket → session set) anyway.
 *   3. `context_switch_rate` / `interrupts_per_hour` need the globally ordered
 *      user-prompt sequence (project + session per prompt); focus blocks /
 *      `active_hours` need the gap structure of EVERY event timestamp across
 *      all files interleaved.
 *   4. Cost needs token sums grouped by model; tool_diversity averages
 *      per-session distinct-tool sets across files.
 * The minimal per-file raw material that keeps ALL of those exact is the
 * NormalizedEvent list itself: it is text-free (structural facts only — see
 * normalize.mjs PRIVACY note) and ~20–50× smaller than the raw transcript. The
 * expensive step being cached is the 1.5GB read + per-line JSON.parse; the
 * global reduce over cached events is cheap and reuses the identical code path,
 * which is what guarantees byte-identical output (exactness beats cleverness).
 *
 * ── Entry format (versioned) ────────────────────────────────────────────────
 * One JSON file per transcript at <cacheDir>/<sha256(abs path)>.json:
 *   { version, path, tool, mtime_ms, size, offset, ctx, events, tail_events }
 *   - offset: byte position just past the LAST newline-terminated line. Events
 *     from [0..offset) are `events` (stable under append); events parsed from
 *     the unterminated remainder [offset..size) are `tail_events` (valid only
 *     while mtime+size match — a later append can complete that line, so the
 *     remainder is re-parsed from `offset` then).
 *   - ctx: the codex carry-forward parser context snapshotted AT `offset`
 *     (session_meta/turn_context state), so a tail parse resumes with exactly
 *     the state a full parse would have there. null for claude (stateless).
 *
 * ── Run semantics ───────────────────────────────────────────────────────────
 *   unchanged (mtime+size match)  → reuse events + tail_events (zero read)
 *   grown (size > cached size)    → read + parse only [offset..size)
 *   shrunk / same-size-new-mtime  → full re-parse (rotated/rewritten)
 *   missing / version ≠ / corrupt → full re-parse (fail-open to correctness)
 * Cache reads/writes never throw into the pipeline: any cache failure silently
 * degrades to the cold full-parse path.
 *
 * Cursor's state.vscdb is EXEMPT (parsed cold every run): it is SQLite with a
 * WAL sidecar, so the main file's mtime/size can stay unchanged while content
 * changes — mtime/size keying would serve stale results.
 *
 * Cache location is machine-global (~/.claude/aios-analyze-cache) because the
 * transcripts are machine-global. Override with $AIOS_ANALYZE_CACHE_DIR (tests).
 * The cache holds admin-tier structural metadata; it never syncs anywhere.
 *
 * Zero dependencies (Node >= 18).
 */

import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeEvent } from "./normalize.mjs";
import { parseClaude, parseJsonl } from "./parse-claude.mjs";
import { recordsToEvents as codexRecordsToEvents, createCtx } from "./parse-codex.mjs";

export const CACHE_VERSION = 1;
const NL = 0x0a;

/** Machine-global cache dir (transcripts are machine-global). Env-overridable. */
export function defaultCacheDir(home = os.homedir()) {
  return process.env.AIOS_ANALYZE_CACHE_DIR || path.join(home, ".claude", "aios-analyze-cache");
}

/** One entry file per transcript, keyed by the hash of its absolute path. */
export function entryPath(dir, file) {
  return path.join(dir, `${createHash("sha256").update(file).digest("hex").slice(0, 40)}.json`);
}

/** Load + validate an entry. Any problem (missing/corrupt/version) → null. */
export function loadEntry(dir, file) {
  let e;
  try {
    e = JSON.parse(readFileSync(entryPath(dir, file), "utf8"));
  } catch {
    return null;
  }
  if (!e || typeof e !== "object" || e.version !== CACHE_VERSION || e.path !== file) return null;
  if (!Array.isArray(e.events) || !Array.isArray(e.tail_events)) return null;
  if (!Number.isFinite(e.mtime_ms) || !Number.isFinite(e.size)) return null;
  if (!Number.isFinite(e.offset) || e.offset < 0 || e.offset > e.size) return null;
  return e;
}

/** Persist an entry. Cache write failure must never break the run. */
export function saveEntry(dir, file, entry) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      entryPath(dir, file),
      JSON.stringify({ version: CACHE_VERSION, path: file, ...entry })
    );
  } catch {
    /* fail-open */
  }
}

/** Compact events for storage: drop null/false fields (rebuilt by makeEvent). */
export function compactEvents(events) {
  return events.map((ev) => {
    const out = {};
    for (const [k, v] of Object.entries(ev)) {
      if (v === null || v === false) continue;
      out[k] = v;
    }
    return out;
  });
}

/** Stored → canonical NormalizedEvent (throws on garbage → treated as a miss). */
export function rehydrateEvents(list) {
  return list.map((e) => makeEvent(e));
}

function parseChunk(tool, text, fallbackId, ctx) {
  if (tool === "codex") return codexRecordsToEvents(parseJsonl(text), fallbackId, ctx);
  return parseClaude(text, fallbackId);
}

/** Read exactly [start .. start+length) bytes of a file. */
function readBytes(file, start, length) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = readSync(fd, buf, got, length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/**
 * Parse a byte chunk whose start is line-aligned. The chunk is split at its
 * LAST newline: the head (stable under append) and the unterminated remainder
 * (parsed too — matching cold semantics on current content — but stored
 * separately so a later append re-parses it). `ctx` (codex) is mutated by the
 * head parse and snapshotted before the remainder parse: that snapshot is the
 * parser state at the new offset.
 */
function parseSplit(tool, buf, fallbackId, ctx) {
  const nl = buf.lastIndexOf(NL);
  const headBuf = nl >= 0 ? buf.subarray(0, nl + 1) : buf.subarray(0, 0);
  const tailBuf = nl >= 0 ? buf.subarray(nl + 1) : buf;
  const headEvents = headBuf.length
    ? parseChunk(tool, headBuf.toString("utf8"), fallbackId, ctx)
    : [];
  const ctxAtOffset = ctx ? { ...ctx } : null;
  const tailEvents = tailBuf.length
    ? parseChunk(tool, tailBuf.toString("utf8"), fallbackId, ctx)
    : [];
  return { headEvents, tailEvents, headBytes: headBuf.length, ctxAtOffset };
}

/**
 * Parse one claude/codex JSONL transcript through the cache.
 * Returns the SAME NormalizedEvent[] a cold `parse(readFileSync(file))` would.
 * File-read errors propagate (caller skips the file, as the cold path does);
 * cache-level problems never do.
 *
 * @param {{dir:string, tool:"claude"|"codex", file:string,
 *          st:{size:number, mtime_ms:number}, fallbackId:string,
 *          stats?:{hits:number, appends:number, misses:number}}} opts
 * @returns {import("./normalize.mjs").NormalizedEvent[]}
 */
export function cachedParseFile({ dir, tool, file, st, fallbackId, stats }) {
  const entry = loadEntry(dir, file);
  const usable = entry && entry.tool === tool;

  // Unchanged → reuse the stored partial (no file read at all).
  if (usable && entry.mtime_ms === st.mtime_ms && entry.size === st.size) {
    try {
      const evs = rehydrateEvents(entry.events).concat(rehydrateEvents(entry.tail_events));
      if (stats) stats.hits += 1;
      return evs;
    } catch {
      /* corrupt stored events → fall through to full re-parse */
    }
  }

  // Grown (append-only log) → parse only the new bytes from the stored offset.
  if (usable && st.size > entry.size) {
    try {
      const base = rehydrateEvents(entry.events);
      const chunk = readBytes(file, entry.offset, st.size - entry.offset);
      const ctx = tool === "codex" ? { ...createCtx(fallbackId), ...entry.ctx } : null;
      const { headEvents, tailEvents, headBytes, ctxAtOffset } = parseSplit(
        tool,
        chunk,
        fallbackId,
        ctx
      );
      saveEntry(dir, file, {
        tool,
        mtime_ms: st.mtime_ms,
        size: st.size,
        offset: entry.offset + headBytes,
        ctx: ctxAtOffset,
        events: entry.events.concat(compactEvents(headEvents)),
        tail_events: compactEvents(tailEvents),
      });
      if (stats) stats.appends += 1;
      return base.concat(headEvents, tailEvents);
    } catch {
      /* corrupt cached prefix → fall through to full re-parse */
    }
  }

  // Miss / shrunk / rotated / version mismatch / corrupt → full re-parse.
  const buf = readFileSync(file);
  const ctx = tool === "codex" ? createCtx(fallbackId) : null;
  const { headEvents, tailEvents, headBytes, ctxAtOffset } = parseSplit(tool, buf, fallbackId, ctx);
  saveEntry(dir, file, {
    tool,
    mtime_ms: st.mtime_ms,
    size: st.size,
    offset: headBytes,
    ctx: ctxAtOffset,
    events: compactEvents(headEvents),
    tail_events: compactEvents(tailEvents),
  });
  if (stats) stats.misses += 1;
  return headEvents.concat(tailEvents);
}
