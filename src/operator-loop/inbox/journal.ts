// Unified inbox — the append-only `inbox-events.ndjson` journal (I-02 / AIO-383).
//
// This is the durable canonical substrate the whole inbox lifecycle rides on. The shipped logs
// cannot host it: `asks.ndjson` supports only create|resolve|orphan and GC-deletes resolved rows
// after 7 days; `activity.jsonl` records observations, not intents / verdicts / consumptions /
// receipts. This journal is a NEW, never-GC'd, versioned event log.
//
// Invariants (mirrors the asks store — src/operator-loop/asks/store.ts — deliberately):
//   • Writer-honored lockfile (O_EXCL `wx`, pid+token+ts, bounded retries, 30s stale-reclaim,
//     ownership re-verify before any rewrite/rename). Every append honors the lock, so no line is
//     lost during a compaction rewrite — there is no optimistic compare-and-swap to race.
//   • Every line carries `schema_version`; the reader NEVER silently drops a non-empty line —
//     malformed / unknown-version / unknown-kind lines surface as warnings.
//   • Total per-journal ordering via a monotonic `seq`, assigned under the lock.
//   • Crash-safe append (single O_APPEND write). A torn tail line (partial write / truncation) is
//     recovered as at-most-one dropped tail, never a corrupt fold.
//   • 64 MiB segment rotation: segments are `inbox-events.<seq>.ndjson` with a monotonic file index;
//     rotated segments stay readable rebuild inputs (deletion is I-16's concern, never rotation's).
//
// Tier: admin-tier local state under `.aios/loop/inbox/` — NEVER added to `sync_include`, never
// pushed to the Team Brain, no comms plaintext ever leaves the machine.
//
// The event VOCABULARY + state derivation live here (schema) and in read-model.ts (projection);
// no cross-domain value imports — the loop composes through src/operator-loop/index.ts.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── paths + constants ─────────────────────────────────────────────────────────────────────────────

export const INBOX_DIR_REL = ".aios/loop/inbox";
export const INBOX_SEGMENT_PREFIX = "inbox-events";
export const INBOX_SNAPSHOT_BASENAME = "inbox-events.snapshot.json";
/** Current line schema. Legacy `schema_version: 1` lines (no `causation_id`) still rebuild. */
export const INBOX_SCHEMA_VERSION = 2;
export const KNOWN_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1, 2]);
/** Rotate to a new segment when the active one would exceed this. Overridable per-append (tests). */
export const SEGMENT_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB

export const INBOX_EVENT_KINDS = [
  "observation-correlation",
  "user-intent",
  "pdp-decision",
  "capability-consumption",
  "action-attempt",
  "outcome",
  "native-receipt",
  "audit-checkpoint-link",
  // I-05 (AIO-386) notify-lane events — the interrupt lane's two honest ack states. Named per this
  // journal's hyphenated `kind` convention (the domain spec's prose form is `delivery_attempted` /
  // `human_ack`). Content-free by construction (payload carries ids/labels only, never bodies). The
  // read-model fold assigns them no ItemState effect, so they are RETAINED (never compacted) — they
  // ARE the recovery-view evidence that an interrupt was attempted but not acknowledged.
  "delivery-attempted",
  "human-ack",
] as const;
export type InboxEventKind = (typeof INBOX_EVENT_KINDS)[number];
const KIND_SET: ReadonlySet<string> = new Set(INBOX_EVENT_KINDS);

// Lock tuning — identical discipline to the asks store.
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40;
const LOCK_DELAY_MS = 25;
const TAIL_READ_BYTES = 64 * 1024; // enough to always contain the last (small) event line

// ── types ────────────────────────────────────────────────────────────────────────────────────────

export interface InboxEvent {
  schema_version: number;
  id: string;
  seq: number;
  ts: string;
  kind: InboxEventKind;
  correlation_id: string;
  causation_id: string | null;
  payload: Record<string, unknown>;
}

/** Shape a caller passes to `appendInboxEvent`; `id`/`seq`/`ts`/`schema_version` are stamped. */
export interface AppendEventInput {
  kind: InboxEventKind;
  correlation_id: string;
  causation_id?: string | null;
  payload?: Record<string, unknown>;
  id?: string;
  ts?: string;
}

export interface AppendResult {
  id: string;
  seq: number;
  segment: number;
  path: string;
}

/** Thrown as `error.code` when the journal lock could not be taken within the allowed retries. */
export const JOURNAL_LOCK_BUSY = "INBOX_JOURNAL_LOCK_BUSY";

export interface AppendOptions {
  segmentMaxBytes?: number;
  /** Lock acquisition retries. `0` makes the append non-blocking: it throws `JOURNAL_LOCK_BUSY`
   *  immediately rather than parking the thread on `Atomics.wait`. Required for any caller running
   *  on a server event loop, where a synchronous retry stalls every other request. */
  lockRetries?: number;
}

export interface JournalWarning {
  segment: number;
  line: number;
  reason: string;
}

export interface JournalReadResult {
  events: InboxEvent[];
  warnings: JournalWarning[];
  /** True iff the last physical line was a partial/torn write that recovery dropped. */
  tornTail: boolean;
  segments: number[];
}

export class InboxValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`inbox event: ${message}`);
    this.name = "InboxValidationError";
    this.field = field;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────

function inboxDir(root: string): string {
  return path.join(root, INBOX_DIR_REL);
}
function lockPathOf(root: string): string {
  return path.join(inboxDir(root), `${INBOX_SEGMENT_PREFIX}.lock`);
}
export function snapshotPath(root: string): string {
  return path.join(inboxDir(root), INBOX_SNAPSHOT_BASENAME);
}
function segmentPath(root: string, index: number): string {
  return path.join(inboxDir(root), `${INBOX_SEGMENT_PREFIX}.${index}.ndjson`);
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

const SEGMENT_RE = new RegExp(`^${INBOX_SEGMENT_PREFIX}\\.(\\d+)\\.ndjson$`);

/** All journal segments, sorted by ascending file index. Missing dir → []. */
export function listSegments(root: string): Array<{ index: number; path: string }> {
  const dir = inboxDir(root);
  if (!existsSync(dir)) return [];
  const out: Array<{ index: number; path: string }> = [];
  for (const entry of readdirSync(dir)) {
    const m = SEGMENT_RE.exec(entry);
    if (m && m[1] !== undefined) out.push({ index: Number(m[1]), path: path.join(dir, entry) });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ── lock (asks-store discipline, inbox-scoped) ─────────────────────────────────────────────────────

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * True iff a live (non-stale) writer currently holds the journal lock.
 *
 * Advisory only — a caller must still handle `JOURNAL_LOCK_BUSY`, because the lock can be taken
 * between this probe and the append. Its purpose is to let an ASYNC caller yield to its event loop
 * and re-check, instead of taking the synchronous `sleepSync` backoff that would park the thread.
 */
export function inboxJournalLockHeld(root: string): boolean {
  try {
    return Date.now() - statSync(lockPathOf(root)).mtimeMs <= LOCK_STALE_MS;
  } catch {
    return false; // no lockfile (or unreadable) — nothing is holding it
  }
}

/**
 * Run `fn` while holding an exclusive lockfile in the inbox dir. Bounded retries; a stale lock
 * (mtime older than LOCK_STALE_MS) is reclaimed. `fn` receives `ownsLock()` — true iff the lockfile
 * still carries this holder's fresh token. Any rewrite (compaction) must re-verify ownership before
 * its rename and abort if reclaimed, so a reclaimer's appends are never overwritten. The lock is
 * always released while the token still matches (never delete a reclaimer's lock).
 */
export function withInboxLock<T>(
  root: string,
  fn: (ownsLock: () => boolean) => T,
  opts: { retries?: number } = {}
): T {
  const lockPath = lockPathOf(root);
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const maxRetries = Math.max(0, opts.retries ?? LOCK_RETRIES);
  let fd: number | null = null;
  for (let attempt = 0; attempt <= maxRetries && fd === null; attempt++) {
    try {
      fd = openSync(lockPath, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* lost the reclaim race — retry */
        }
        continue;
      }
      // `sleepSync` is `Atomics.wait` — it parks the whole thread. A caller on a server event loop
      // must pass `retries: 0` and handle JOURNAL_LOCK_BUSY rather than stall every other request.
      if (attempt < maxRetries) sleepSync(LOCK_DELAY_MS);
    }
  }
  if (fd === null) {
    throw Object.assign(new Error(`inbox: could not acquire journal lock (${lockPath})`), {
      code: JOURNAL_LOCK_BUSY,
    });
  }
  const ownsLock = (): boolean => {
    try {
      if (!readFileSync(lockPath, "utf8").includes(token)) return false;
      return Date.now() - statSync(lockPath).mtimeMs <= LOCK_STALE_MS;
    } catch {
      return false;
    }
  };
  const tokenMatches = (): boolean => {
    try {
      return readFileSync(lockPath, "utf8").includes(token);
    } catch {
      return false;
    }
  };
  try {
    try {
      writeFileSync(fd, `${process.pid} ${token} ${new Date().toISOString()}\n`);
    } catch {
      /* stamp failed — ownsLock() reports false so rewrites abort conservatively */
    }
    closeSync(fd);
    return fn(ownsLock);
  } finally {
    try {
      if (tokenMatches()) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

// ── validation + line (de)serialization ────────────────────────────────────────────────────────────

/** Validate + normalize an append input into a storable event body (no seq/id/ts stamping yet). */
export function validateEventInput(input: AppendEventInput): {
  kind: InboxEventKind;
  correlation_id: string;
  causation_id: string | null;
  payload: Record<string, unknown>;
} {
  if (!input || typeof input !== "object") throw new InboxValidationError("event", "not an object");
  if (!KIND_SET.has(input.kind)) {
    throw new InboxValidationError(
      "kind",
      `unknown kind "${String(input.kind)}" (expected one of ${INBOX_EVENT_KINDS.join("|")})`
    );
  }
  const cid = input.correlation_id;
  if (typeof cid !== "string" || !cid.trim()) {
    throw new InboxValidationError("correlation_id", "correlation_id must be a non-empty string");
  }
  if (input.payload !== undefined && !isRecord(input.payload)) {
    throw new InboxValidationError("payload", "payload must be an object when present");
  }
  const caid = input.causation_id;
  if (caid !== undefined && caid !== null && typeof caid !== "string") {
    throw new InboxValidationError("causation_id", "causation_id must be a string or null");
  }
  return {
    kind: input.kind,
    correlation_id: cid,
    causation_id: caid ?? null,
    payload: input.payload ?? {},
  };
}

function serializeEvent(ev: InboxEvent): string {
  // Fixed key order → stable line bytes for identical events.
  return JSON.stringify({
    schema_version: ev.schema_version,
    id: ev.id,
    seq: ev.seq,
    ts: ev.ts,
    kind: ev.kind,
    correlation_id: ev.correlation_id,
    causation_id: ev.causation_id,
    payload: ev.payload,
  });
}

/** Parse+validate one physical line → an event, or a rejection reason (never throws). */
export function parseEventLine(text: string): { event: InboxEvent } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "malformed-json" };
  }
  if (!isRecord(parsed)) return { reason: "not-an-object" };
  const sv = parsed.schema_version;
  if (typeof sv !== "number" || !KNOWN_SCHEMA_VERSIONS.has(sv))
    return { reason: "unknown-schema-version" };
  const kind = asStr(parsed.kind);
  if (!kind || !KIND_SET.has(kind)) return { reason: "unknown-kind" };
  const id = asStr(parsed.id);
  if (!id) return { reason: "missing-id" };
  const seq = parsed.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return { reason: "missing-seq" };
  const cid = asStr(parsed.correlation_id);
  if (!cid) return { reason: "missing-correlation-id" };
  const ts = asStr(parsed.ts) ?? "";
  // Legacy v1 lines may omit causation_id / payload — default them (readable-without-loss).
  const caidRaw = parsed.causation_id;
  const causation_id = typeof caidRaw === "string" ? caidRaw : null;
  const payload = isRecord(parsed.payload) ? parsed.payload : {};
  return {
    event: {
      schema_version: sv,
      id,
      seq,
      ts,
      kind: kind as InboxEventKind,
      correlation_id: cid,
      causation_id,
      payload,
    },
  };
}

// ── read (tolerant, torn-tail-safe) ──────────────────────────────────────────────────────────────

/**
 * Read + parse every segment in seq order. A partial/torn LAST physical line of the LAST segment
 * (a crash mid-append, or a truncation landing mid-line) is dropped as `tornTail` — at most one
 * line lost, never a corrupt fold. Interior malformed lines are warnings, never silently dropped.
 * Events are returned sorted by their monotonic `seq` (total per-journal order).
 */
export function readJournalSegments(root: string): JournalReadResult {
  const segs = listSegments(root);
  const events: InboxEvent[] = [];
  const warnings: JournalWarning[] = [];
  let tornTail = false;

  segs.forEach((seg, si) => {
    let raw: string;
    try {
      raw = readFileSync(seg.path, "utf8");
    } catch {
      warnings.push({ segment: seg.index, line: 0, reason: "unreadable" });
      return;
    }
    if (raw === "") return;
    const endsWithNl = raw.endsWith("\n");
    const parts = raw.split("\n");
    if (parts[parts.length - 1] === "") parts.pop(); // trailing "" from a terminating newline
    parts.forEach((text, li) => {
      const isLastPhysical = si === segs.length - 1 && li === parts.length - 1;
      const unterminated = isLastPhysical && !endsWithNl;
      if (!text.trim()) return; // blank line → ignore
      const res = parseEventLine(text);
      if ("event" in res) {
        events.push(res.event);
        return;
      }
      if (unterminated) {
        tornTail = true; // torn tail — drop, no warning (recovery, not corruption)
        return;
      }
      warnings.push({ segment: seg.index, line: li + 1, reason: res.reason });
    });
  });

  events.sort((a, b) => a.seq - b.seq);
  return { events, warnings, tornTail, segments: segs.map((s) => s.index) };
}

// ── seq assignment ──────────────────────────────────────────────────────────────────────────────

/** Max `seq` seen in a segment's tail (cheap — reads only the last window). 0 if none. */
function tailSeqOf(file: string): number {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return 0;
  }
  if (size === 0) return 0;
  const start = Math.max(0, size - TAIL_READ_BYTES);
  const buf = Buffer.alloc(size - start);
  try {
    const fd = openSync(file, "r");
    try {
      let offset = 0;
      while (offset < buf.length) {
        const read = readSync(fd, buf, offset, buf.length - offset, start + offset);
        if (read <= 0) break;
        offset += read;
      }
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
  // Drop a leading partial line if we started mid-file (window may bisect the first line).
  const text = buf.toString("utf8");
  const lines = (start > 0 ? text.slice(text.indexOf("\n") + 1) : text)
    .split("\n")
    .filter((l) => l.trim());
  let max = 0;
  for (const line of lines) {
    const res = parseEventLine(line);
    if ("event" in res && res.event.seq > max) max = res.event.seq;
  }
  return max;
}

/** The next monotonic seq = 1 + max seq across all segment tails. Call under the lock. */
function nextSeq(root: string): number {
  let max = 0;
  for (const seg of listSegments(root)) {
    const s = tailSeqOf(seg.path);
    if (s > max) max = s;
  }
  return max + 1;
}

// ── append (crash-safe, lock-protected, rotating) ──────────────────────────────────────────────────

/**
 * Validate + stamp (schema_version, id, seq, ts) + append one event under the lock. Rotates to a
 * fresh `inbox-events.<index+1>.ndjson` segment when the active one would exceed `segmentMaxBytes`.
 * Returns the assigned id/seq/segment.
 */
export function appendInboxEvent(
  root: string,
  input: AppendEventInput,
  opts: AppendOptions = {}
): AppendResult {
  const body = validateEventInput(input);
  const segMax = opts.segmentMaxBytes ?? SEGMENT_MAX_BYTES;
  mkdirSync(inboxDir(root), { recursive: true });
  const lockOpts = opts.lockRetries === undefined ? {} : { retries: opts.lockRetries };
  return withInboxLock(
    root,
    () => {
      const seq = nextSeq(root);
      const event: InboxEvent = {
        schema_version: INBOX_SCHEMA_VERSION,
        id: input.id ?? randomUUID(),
        seq,
        ts: input.ts ?? new Date().toISOString(),
        kind: body.kind,
        correlation_id: body.correlation_id,
        causation_id: body.causation_id,
        payload: body.payload,
      };
      const line = serializeEvent(event) + "\n";
      const lineBytes = Buffer.byteLength(line, "utf8");

      const segs = listSegments(root);
      let index = segs.length ? (segs[segs.length - 1] as { index: number }).index : 1;
      if (segs.length) {
        const active = segs[segs.length - 1] as { index: number; path: string };
        let activeSize = 0;
        try {
          activeSize = statSync(active.path).size;
        } catch {
          activeSize = 0;
        }
        // Rotate only when the active segment is non-empty (never leave an empty segment behind).
        if (activeSize > 0 && activeSize + lineBytes > segMax) index = active.index + 1;
      }
      const target = segmentPath(root, index);
      appendFileSync(target, line);
      return { id: event.id, seq, segment: index, path: target };
    },
    lockOpts
  );
}

// ── rewrite (compaction primitive) ─────────────────────────────────────────────────────────────────

/**
 * Atomically replace the journal's segments with `events` (already seq-ordered), re-segmented at
 * `segmentMaxBytes`. Old segments are removed. Ownership is re-verified immediately before the
 * swap and the rewrite is SKIPPED (returns { skipped: true }) if the lock was stale-reclaimed while
 * we worked, so a reclaimer's fresh appends are never lost. Caller must already hold the lock.
 */
export function rewriteSegments(
  root: string,
  events: readonly InboxEvent[],
  ownsLock: () => boolean,
  segMax: number = SEGMENT_MAX_BYTES
): { skipped: boolean; segments: number[] } {
  const dir = inboxDir(root);
  mkdirSync(dir, { recursive: true });
  // Build the new segment contents in memory (local journals are bounded; compaction is rare).
  const chunks: string[][] = [[]];
  const sizes: number[] = [0];
  for (const ev of events) {
    const line = serializeEvent(ev) + "\n";
    const bytes = Buffer.byteLength(line, "utf8");
    let ci = chunks.length - 1;
    const curSize = sizes[ci] as number;
    if (curSize > 0 && curSize + bytes > segMax) {
      chunks.push([]);
      sizes.push(0);
      ci = chunks.length - 1;
    }
    (chunks[ci] as string[]).push(line);
    sizes[ci] = (sizes[ci] as number) + bytes;
  }
  // Write temp segments first.
  const tmpPaths: string[] = [];
  chunks.forEach((lines, i) => {
    const tmp = segmentPath(root, i + 1) + `.tmp-${process.pid}`;
    writeFileSync(tmp, lines.join(""));
    tmpPaths.push(tmp);
  });
  if (!ownsLock()) {
    for (const t of tmpPaths) {
      try {
        unlinkSync(t);
      } catch {
        /* best-effort */
      }
    }
    return { skipped: true, segments: [] };
  }
  // Remove old segments, then rename temps into place (index 1..N).
  for (const seg of listSegments(root)) {
    try {
      unlinkSync(seg.path);
    } catch {
      /* best-effort */
    }
  }
  const finalIndexes: number[] = [];
  tmpPaths.forEach((tmp, i) => {
    const dest = segmentPath(root, i + 1);
    renameSync(tmp, dest);
    finalIndexes.push(i + 1);
  });
  return { skipped: false, segments: finalIndexes };
}

// ── snapshot IO (compaction baseline; shape defined by read-model.ts) ────────────────────────────

/** Atomically write the compaction snapshot (item-state baseline). */
export function writeSnapshot(root: string, snapshot: unknown): void {
  mkdirSync(inboxDir(root), { recursive: true });
  const dest = snapshotPath(root);
  const tmp = dest + `.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, dest);
}

/** Read the compaction snapshot, or null if absent/unreadable. */
export function readSnapshot(root: string): unknown | null {
  const p = snapshotPath(root);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
