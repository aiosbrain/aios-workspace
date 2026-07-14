// Unified inbox — the SQLite read model + deterministic projection rebuild (I-02 / AIO-383).
//
// D5 ruling (I-01 domain spec): the read model is `better-sqlite3` (a native dep — WAL-proven,
// synchronous API), rebuilt DETERMINISTICALLY from the union of three inputs:
//     asks.ndjson  ∪  activity.jsonl  ∪  inbox-events.ndjson
// The `inbox-events.ndjson` journal is CANONICAL for the new lifecycle — asks rows and activity
// records are advisory join inputs only, so the rebuild survives the asks store's 7-day GC
// unchanged (journal events, not asks rows, own the lifecycle — I-02 spec §Implementation notes).
//
// Tauri-packaging note (D5 fallback): `better-sqlite3` is a native addon. If a future Tauri build
// cannot bundle the native `.node` for the target platform, the domain spec's named fallback is a
// subprocess CLI over the bundled `sqlite3` binary (same SQL, spawned instead of linked). We do NOT
// solve Tauri here (I-15) — this module links better-sqlite3 directly; the fallback is a documented
// swap behind the same `rebuildReadModel` surface.
//
// "Byte-equivalent SQLite projections" is enforced at the CANONICAL-CONTENT level: `readModelDigest`
// hashes the four projected STATE tables (items + tombstones + receipts + audit-links), ordered by
// primary key. The raw SQLite container carries non-deterministic internal counters (the header
// change-counter, freelist ordering), so a byte-for-byte file hash is not a stable invariant across
// independent builds; the projected-state digest IS, and it is exactly what "identical inputs →
// identical projection" means. Every replay guarantee (identical inputs, post-GC, post-truncation,
// post-compaction) is asserted on this digest.
//
// Same-domain imports only (journal.js + state-machines.js); NO cross-domain value imports — the
// loop composes through src/operator-loop/index.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  INBOX_DIR_REL,
  INBOX_SCHEMA_VERSION,
  appendInboxEvent, // re-export convenience below
  listSegments,
  readJournalSegments,
  readSnapshot,
  rewriteSegments,
  withInboxLock,
  writeSnapshot,
  type InboxEvent,
  type InboxEventKind,
} from "./journal.js";
import {
  ACTION_INITIAL,
  ATTENTION_INITIAL,
  SOURCE_INITIAL,
  applyTransition,
  type ActionState,
  type AttentionState,
  type MachineName,
  type MachineValue,
  type SourceState,
} from "./state-machines.js";

export const READ_MODEL_VERSION = 1;
export const READ_MODEL_DB_BASENAME = "read-model.db";

// Kinds whose effect is a state transition (prunable in compaction — their result is captured by
// the compaction snapshot). The complement (RETAINED_KINDS) carry NO state effect and are never
// compacted within retention (consumed-tombstones + receipts + audit links).
const TRANSITION_KINDS: ReadonlySet<InboxEventKind> = new Set([
  "observation-correlation",
  "user-intent",
  "pdp-decision",
  "action-attempt",
  "outcome",
]);
const RETAINED_KINDS: ReadonlySet<InboxEventKind> = new Set([
  "capability-consumption",
  "native-receipt",
  "audit-checkpoint-link",
]);

// ── projected state shapes ─────────────────────────────────────────────────────────────────────────

export interface ItemState {
  correlation_id: string;
  source: string | null;
  native_id: string | null;
  thread_id: string | null;
  attention: MachineValue;
  action: MachineValue;
  source_state: MachineValue;
  first_seq: number;
  last_seq: number;
}
export interface Tombstone {
  capability_id: string;
  operation: string | null;
  request_digest: string | null;
  correlation_id: string | null;
  consumed_seq: number;
  consumed_ts: string;
}
export interface Receipt {
  receipt_id: string;
  correlation_id: string | null;
  native_ref: string | null;
  seq: number;
  ts: string;
}
export interface AuditLink {
  checkpoint_id: string;
  correlation_id: string | null;
  digest: string | null;
  ref: string | null;
  seq: number;
  ts: string;
}
export interface FoldWarning {
  seq: number;
  reason: string;
}
export interface ReadModelState {
  items: Map<string, ItemState>;
  tombstones: Map<string, Tombstone>;
  receipts: Map<string, Receipt>;
  auditLinks: Map<string, AuditLink>;
  warnings: FoldWarning[];
  maxSeq: number;
}

// ── fold (pure: events → state, via the orthogonal machines) ─────────────────────────────────────

function newItem(correlation_id: string, seq: number): ItemState {
  return {
    correlation_id,
    source: null,
    native_id: null,
    thread_id: null,
    attention: { state: ATTENTION_INITIAL, version: 0 },
    action: { state: ACTION_INITIAL, version: 0 },
    source_state: { state: SOURCE_INITIAL, version: 0 },
    first_seq: seq,
    last_seq: seq,
  };
}

function machineRef(item: ItemState, machine: MachineName): MachineValue {
  return machine === "attention_state"
    ? item.attention
    : machine === "action_state"
      ? item.action
      : item.source_state;
}
function setMachine(item: ItemState, machine: MachineName, v: MachineValue): void {
  if (machine === "attention_state") item.attention = v;
  else if (machine === "action_state") item.action = v;
  else item.source_state = v;
}

const INTENT_TO_ATTENTION: Readonly<Record<string, AttentionState>> = {
  surface: "surfaced",
  reopen: "surfaced",
  acknowledge: "acknowledged",
  snooze: "snoozed",
  resolve: "resolved",
  archive: "archived",
};
const INTENT_TO_ACTION: Readonly<Record<string, ActionState>> = {
  propose: "proposed",
  submit: "awaiting_approval",
  withdraw: "none",
};
const DECISION_TO_ACTION: Readonly<Record<string, ActionState>> = {
  approve: "approved",
  deny: "denied",
  expire: "expired",
};
const OUTCOME_TO_ACTION: Readonly<Record<string, ActionState>> = {
  succeeded: "succeeded",
  failed: "failed",
  outcome_unknown: "outcome_unknown",
};

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function expectedVersionOf(payload: Record<string, unknown>): number | undefined {
  const v = payload.expected_version;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Fold events (seq-ordered) into read-model state, optionally on top of a compaction `baseline`.
 * Illegal/optimistic transitions become fold WARNINGS (never silently dropped, never thrown here —
 * direct callers get typed errors from state-machines.applyTransition). RETAINED_KINDS carry no
 * state effect; they only populate the tombstone/receipt/audit tables (making compaction sound).
 */
export function foldEvents(
  events: readonly InboxEvent[],
  baseline?: Map<string, ItemState>
): ReadModelState {
  const items = new Map<string, ItemState>();
  if (baseline) for (const [k, v] of baseline) items.set(k, cloneItem(v));
  const tombstones = new Map<string, Tombstone>();
  const receipts = new Map<string, Receipt>();
  const auditLinks = new Map<string, AuditLink>();
  const warnings: FoldWarning[] = [];
  let maxSeq = 0;

  const ensureItem = (cid: string, seq: number): ItemState => {
    let it = items.get(cid);
    if (!it) {
      it = newItem(cid, seq);
      items.set(cid, it);
    }
    if (seq < it.first_seq) it.first_seq = seq;
    if (seq > it.last_seq) it.last_seq = seq;
    return it;
  };
  const transition = (
    item: ItemState,
    machine: MachineName,
    to: string,
    seq: number,
    payload: Record<string, unknown>
  ): void => {
    const ev = expectedVersionOf(payload);
    try {
      const next = applyTransition(
        machine,
        machineRef(item, machine),
        to,
        ev !== undefined ? { expectedVersion: ev } : {}
      );
      setMachine(item, machine, next);
    } catch (e) {
      warnings.push({ seq, reason: `${machine}: ${(e as Error).message}` });
    }
  };

  for (const ev of events) {
    if (ev.seq > maxSeq) maxSeq = ev.seq;
    const p = ev.payload;
    const item = ensureItem(ev.correlation_id, ev.seq);

    switch (ev.kind) {
      case "observation-correlation": {
        const source = asStr(p.source);
        const nativeId = asStr(p.native_id);
        const threadId = asStr(p.thread_id);
        if (source !== null) item.source = source;
        if (nativeId !== null) item.native_id = nativeId;
        if (threadId !== null) item.thread_id = threadId;
        const st = asStr(p.source_transition);
        if (st !== null) transition(item, "source_state", st, ev.seq, p);
        break;
      }
      case "user-intent": {
        const intent = asStr(p.intent) ?? "";
        if (intent in INTENT_TO_ATTENTION) {
          transition(item, "attention_state", INTENT_TO_ATTENTION[intent] as string, ev.seq, p);
        } else if (intent in INTENT_TO_ACTION) {
          transition(item, "action_state", INTENT_TO_ACTION[intent] as string, ev.seq, p);
        } else {
          warnings.push({ seq: ev.seq, reason: `user-intent: unknown intent "${intent}"` });
        }
        break;
      }
      case "pdp-decision": {
        const decision = asStr(p.decision) ?? "";
        if (decision in DECISION_TO_ACTION) {
          transition(item, "action_state", DECISION_TO_ACTION[decision] as string, ev.seq, p);
        } else {
          warnings.push({ seq: ev.seq, reason: `pdp-decision: unknown decision "${decision}"` });
        }
        break;
      }
      case "action-attempt": {
        transition(item, "action_state", "executing", ev.seq, p);
        break;
      }
      case "outcome": {
        const result = asStr(p.result) ?? "";
        if (result in OUTCOME_TO_ACTION) {
          transition(item, "action_state", OUTCOME_TO_ACTION[result] as string, ev.seq, p);
        } else {
          warnings.push({ seq: ev.seq, reason: `outcome: unknown result "${result}"` });
        }
        break;
      }
      case "capability-consumption": {
        const capId = asStr(p.capability_id);
        if (!capId) {
          warnings.push({ seq: ev.seq, reason: "capability-consumption: missing capability_id" });
          break;
        }
        if (tombstones.has(capId)) {
          // Compare-and-consume: a second consumption of the same handle is a replay; keep the
          // first tombstone (idempotent), surface a warning — never double-consume.
          warnings.push({ seq: ev.seq, reason: `capability-consumption: replay of ${capId}` });
          break;
        }
        tombstones.set(capId, {
          capability_id: capId,
          operation: asStr(p.operation),
          request_digest: asStr(p.request_digest),
          correlation_id: ev.correlation_id,
          consumed_seq: ev.seq,
          consumed_ts: ev.ts,
        });
        break;
      }
      case "native-receipt": {
        const rid = asStr(p.receipt_id);
        if (!rid) {
          warnings.push({ seq: ev.seq, reason: "native-receipt: missing receipt_id" });
          break;
        }
        if (!receipts.has(rid)) {
          receipts.set(rid, {
            receipt_id: rid,
            correlation_id: ev.correlation_id,
            native_ref: asStr(p.native_ref),
            seq: ev.seq,
            ts: ev.ts,
          });
        }
        break;
      }
      case "audit-checkpoint-link": {
        const ckId = asStr(p.checkpoint_id);
        if (!ckId) {
          warnings.push({ seq: ev.seq, reason: "audit-checkpoint-link: missing checkpoint_id" });
          break;
        }
        if (!auditLinks.has(ckId)) {
          auditLinks.set(ckId, {
            checkpoint_id: ckId,
            correlation_id: ev.correlation_id,
            digest: asStr(p.digest),
            ref: asStr(p.ref),
            seq: ev.seq,
            ts: ev.ts,
          });
        }
        break;
      }
    }
  }

  return { items, tombstones, receipts, auditLinks, warnings, maxSeq };
}

function cloneItem(v: ItemState): ItemState {
  return {
    correlation_id: v.correlation_id,
    source: v.source,
    native_id: v.native_id,
    thread_id: v.thread_id,
    attention: { ...v.attention },
    action: { ...v.action },
    source_state: { ...v.source_state },
    first_seq: v.first_seq,
    last_seq: v.last_seq,
  };
}

// ── compaction snapshot (de)serialization ─────────────────────────────────────────────────────────

interface SnapshotShape {
  schema_version: number;
  read_model_version: number;
  boundary_seq: number;
  items: Array<{
    correlation_id: string;
    source: string | null;
    native_id: string | null;
    thread_id: string | null;
    attention_state: string;
    attention_version: number;
    action_state: string;
    action_version: number;
    source_state: string;
    source_version: number;
    first_seq: number;
    last_seq: number;
  }>;
}

function serializeBaseline(items: Map<string, ItemState>, boundarySeq: number): SnapshotShape {
  const rows = [...items.values()]
    .sort((a, b) => a.correlation_id.localeCompare(b.correlation_id))
    .map((it) => ({
      correlation_id: it.correlation_id,
      source: it.source,
      native_id: it.native_id,
      thread_id: it.thread_id,
      attention_state: it.attention.state,
      attention_version: it.attention.version,
      action_state: it.action.state,
      action_version: it.action.version,
      source_state: it.source_state.state,
      source_version: it.source_state.version,
      first_seq: it.first_seq,
      last_seq: it.last_seq,
    }));
  return {
    schema_version: INBOX_SCHEMA_VERSION,
    read_model_version: READ_MODEL_VERSION,
    boundary_seq: boundarySeq,
    items: rows,
  };
}

function parseBaseline(raw: unknown): Map<string, ItemState> | null {
  if (!raw || typeof raw !== "object") return null;
  const snap = raw as Partial<SnapshotShape>;
  if (!Array.isArray(snap.items)) return null;
  const items = new Map<string, ItemState>();
  for (const r of snap.items) {
    if (!r || typeof r.correlation_id !== "string") continue;
    items.set(r.correlation_id, {
      correlation_id: r.correlation_id,
      source: r.source ?? null,
      native_id: r.native_id ?? null,
      thread_id: r.thread_id ?? null,
      attention: { state: r.attention_state, version: r.attention_version },
      action: { state: r.action_state, version: r.action_version },
      source_state: { state: r.source_state, version: r.source_version },
      first_seq: r.first_seq,
      last_seq: r.last_seq,
    });
  }
  return items;
}

// ── SQLite projection ────────────────────────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE inbox_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE inbox_items (
  correlation_id   TEXT PRIMARY KEY,
  source           TEXT,
  native_id        TEXT,
  thread_id        TEXT,
  attention_state  TEXT NOT NULL,
  attention_version INTEGER NOT NULL,
  action_state     TEXT NOT NULL,
  action_version   INTEGER NOT NULL,
  source_state     TEXT NOT NULL,
  source_version   INTEGER NOT NULL,
  first_seq        INTEGER NOT NULL,
  last_seq         INTEGER NOT NULL
);
CREATE TABLE inbox_tombstones (
  capability_id  TEXT PRIMARY KEY,
  operation      TEXT,
  request_digest TEXT,
  correlation_id TEXT,
  consumed_seq   INTEGER NOT NULL,
  consumed_ts    TEXT NOT NULL
);
CREATE TABLE inbox_receipts (
  receipt_id     TEXT PRIMARY KEY,
  correlation_id TEXT,
  native_ref     TEXT,
  seq            INTEGER NOT NULL,
  ts             TEXT NOT NULL
);
CREATE TABLE inbox_audit_links (
  checkpoint_id  TEXT PRIMARY KEY,
  correlation_id TEXT,
  digest         TEXT,
  ref            TEXT,
  seq            INTEGER NOT NULL,
  ts             TEXT NOT NULL
);
`;

function writeProjection(dbPath: string, state: ReadModelState, builtFromSnapshot: boolean): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const f = dbPath + suffix;
    if (existsSync(f)) {
      try {
        unlinkSync(f);
      } catch {
        /* best-effort fresh build */
      }
    }
  }
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.pragma("synchronous = NORMAL");
    db.exec(SCHEMA_SQL);

    const insertMeta = db.prepare("INSERT INTO inbox_meta(key, value) VALUES (?, ?)");
    const insertItem = db.prepare(
      `INSERT INTO inbox_items
        (correlation_id, source, native_id, thread_id, attention_state, attention_version,
         action_state, action_version, source_state, source_version, first_seq, last_seq)
       VALUES (@correlation_id, @source, @native_id, @thread_id, @attention_state, @attention_version,
         @action_state, @action_version, @source_state, @source_version, @first_seq, @last_seq)`
    );
    const insertTomb = db.prepare(
      `INSERT INTO inbox_tombstones
        (capability_id, operation, request_digest, correlation_id, consumed_seq, consumed_ts)
       VALUES (@capability_id, @operation, @request_digest, @correlation_id, @consumed_seq, @consumed_ts)`
    );
    const insertReceipt = db.prepare(
      `INSERT INTO inbox_receipts (receipt_id, correlation_id, native_ref, seq, ts)
       VALUES (@receipt_id, @correlation_id, @native_ref, @seq, @ts)`
    );
    const insertAudit = db.prepare(
      `INSERT INTO inbox_audit_links (checkpoint_id, correlation_id, digest, ref, seq, ts)
       VALUES (@checkpoint_id, @correlation_id, @digest, @ref, @seq, @ts)`
    );

    const build = db.transaction(() => {
      // Meta is NOT part of the canonical digest (it carries journal-shape facts that legitimately
      // differ pre/post compaction). Insert for observability only.
      insertMeta.run("read_model_version", String(READ_MODEL_VERSION));
      insertMeta.run("schema_version", String(INBOX_SCHEMA_VERSION));
      insertMeta.run("max_seq", String(state.maxSeq));
      insertMeta.run("built_from_snapshot", builtFromSnapshot ? "1" : "0");

      for (const it of [...state.items.values()].sort((a, b) =>
        a.correlation_id.localeCompare(b.correlation_id)
      )) {
        insertItem.run({
          correlation_id: it.correlation_id,
          source: it.source,
          native_id: it.native_id,
          thread_id: it.thread_id,
          attention_state: it.attention.state,
          attention_version: it.attention.version,
          action_state: it.action.state,
          action_version: it.action.version,
          source_state: it.source_state.state,
          source_version: it.source_state.version,
          first_seq: it.first_seq,
          last_seq: it.last_seq,
        });
      }
      for (const t of [...state.tombstones.values()].sort((a, b) =>
        a.capability_id.localeCompare(b.capability_id)
      )) {
        insertTomb.run(t);
      }
      for (const r of [...state.receipts.values()].sort((a, b) =>
        a.receipt_id.localeCompare(b.receipt_id)
      )) {
        insertReceipt.run(r);
      }
      for (const a of [...state.auditLinks.values()].sort((x, y) =>
        x.checkpoint_id.localeCompare(y.checkpoint_id)
      )) {
        insertAudit.run(a);
      }
    });
    build();
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/**
 * Canonical content digest of the PROJECTED STATE (items + tombstones + receipts + audit-links),
 * ordered by primary key. This — not the raw SQLite file bytes — is the "byte-equivalent projection"
 * invariant: identical inputs (before OR after asks GC, journal truncation, or compaction) yield an
 * identical digest.
 */
export function readModelDigest(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const h = createHash("sha256");
    const dump = (table: string, cols: readonly string[], orderBy: string): void => {
      h.update(`\n#${table}\n`);
      const rows = db.prepare(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY ${orderBy}`).all();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        h.update(JSON.stringify(cols.map((c) => r[c] ?? null)));
        h.update("\n");
      }
    };
    dump(
      "inbox_items",
      [
        "correlation_id",
        "source",
        "native_id",
        "thread_id",
        "attention_state",
        "attention_version",
        "action_state",
        "action_version",
        "source_state",
        "source_version",
        "first_seq",
        "last_seq",
      ],
      "correlation_id"
    );
    dump(
      "inbox_tombstones",
      [
        "capability_id",
        "operation",
        "request_digest",
        "correlation_id",
        "consumed_seq",
        "consumed_ts",
      ],
      "capability_id"
    );
    dump(
      "inbox_receipts",
      ["receipt_id", "correlation_id", "native_ref", "seq", "ts"],
      "receipt_id"
    );
    dump(
      "inbox_audit_links",
      ["checkpoint_id", "correlation_id", "digest", "ref", "seq", "ts"],
      "checkpoint_id"
    );
    return h.digest("hex");
  } finally {
    db.close();
  }
}

// ── advisory source reads (the join inputs; do NOT affect canonical bytes) ─────────────────────────

const ASKS_STORE_REL_ADVISORY = ".aios/loop/asks/asks.ndjson"; // mirrors the asks store contract (read-only)

export interface SourceRead {
  path: string;
  kind: "journal" | "asks" | "activity";
  present: boolean;
  records: number;
}

function countNdjson(file: string): { present: boolean; records: number; ids: Set<string> } {
  const ids = new Set<string>();
  if (!existsSync(file)) return { present: false, records: 0, ids };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { present: false, records: 0, ids };
  }
  let records = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    records++;
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const ask = o.ask as Record<string, unknown> | undefined;
      const id =
        typeof o.id === "string" ? o.id : ask && typeof ask.id === "string" ? ask.id : null;
      if (id) ids.add(id);
    } catch {
      /* advisory only — malformed advisory lines are not our concern here */
    }
  }
  return { present: true, records, ids };
}

// ── rebuild ─────────────────────────────────────────────────────────────────────────────────────

export interface RebuildOptions {
  dbPath?: string;
  asksPath?: string;
  activityPaths?: string[];
}
export interface RebuildReport {
  dbPath: string;
  digest: string;
  counts: {
    events: number;
    items: number;
    tombstones: number;
    receipts: number;
    auditLinks: number;
  };
  maxSeq: number;
  tornTail: boolean;
  builtFromSnapshot: boolean;
  warnings: string[];
  sourcesRead: SourceRead[];
}

/**
 * Deterministically rebuild the SQLite read model from asks.ndjson ∪ activity.jsonl ∪
 * inbox-events.ndjson. Idempotent: a fresh db is written each call; identical inputs → identical
 * `digest`. Journal is canonical; asks/activity are advisory join inputs (so the rebuild is
 * invariant to the asks 7-day GC).
 */
export function rebuildReadModel(root: string, opts: RebuildOptions = {}): RebuildReport {
  const dir = path.join(root, INBOX_DIR_REL);
  mkdirSync(dir, { recursive: true });
  const dbPath = opts.dbPath ?? path.join(dir, READ_MODEL_DB_BASENAME);

  const baselineRaw = readSnapshot(root);
  const baseline = baselineRaw ? parseBaseline(baselineRaw) : null;
  const { events, warnings: jw, tornTail } = readJournalSegments(root);
  const state = foldEvents(events, baseline ?? undefined);

  const warnings: string[] = [
    ...jw.map((w) => `journal seg${w.segment}:${w.line} ${w.reason}`),
    ...state.warnings.map((w) => `fold seq${w.seq}: ${w.reason}`),
  ];

  // Advisory join inputs — read but never persisted into canonical bytes.
  const asksPath = opts.asksPath ?? path.join(root, ASKS_STORE_REL_ADVISORY);
  const activityPaths = opts.activityPaths ?? [
    path.join(root, "1-inbox", "comms", "activity.jsonl"),
    path.join(root, ".aios", "loop", "comms", "activity.jsonl"),
  ];
  const asks = countNdjson(asksPath);
  const sourcesRead: SourceRead[] = [
    {
      path: dbPath,
      kind: "journal",
      present: listSegments(root).length > 0,
      records: events.length,
    },
    { path: asksPath, kind: "asks", present: asks.present, records: asks.records },
  ];
  for (const ap of activityPaths) {
    const a = countNdjson(ap);
    if (a.present)
      sourcesRead.push({ path: ap, kind: "activity", present: true, records: a.records });
  }
  // Correlation cross-check (advisory): flag an observation that references an ask no longer live
  // (e.g. GC'd) — informational only, never changes the projection bytes.
  if (asks.present) {
    for (const ev of events) {
      if (ev.kind !== "observation-correlation") continue;
      const askId = asStr(ev.payload.ask_id);
      if (askId && !asks.ids.has(askId)) {
        warnings.push(
          `advisory seq${ev.seq}: correlated ask ${askId} not present in asks store (GC?)`
        );
      }
    }
  }

  writeProjection(dbPath, state, Boolean(baseline));
  const digest = readModelDigest(dbPath);

  return {
    dbPath,
    digest,
    counts: {
      events: events.length,
      items: state.items.size,
      tombstones: state.tombstones.size,
      receipts: state.receipts.size,
      auditLinks: state.auditLinks.size,
    },
    maxSeq: state.maxSeq,
    tornTail,
    builtFromSnapshot: Boolean(baseline),
    warnings,
    sourcesRead,
  };
}

// ── compaction ─────────────────────────────────────────────────────────────────────────────────────

export interface CompactOptions {
  /** Prune TRANSITION_KIND events with seq ≤ this into the snapshot baseline. Default: max seq. */
  boundarySeq?: number;
  segmentMaxBytes?: number;
}
export interface CompactReport {
  skipped: boolean;
  boundarySeq: number;
  prunedEvents: number;
  retainedEvents: number;
  tombstones: number;
  receipts: number;
  auditLinks: number;
}

/**
 * Compact the journal: fold TRANSITION_KIND events with seq ≤ boundary into a snapshot baseline and
 * drop them, KEEPING every capability-consumption / native-receipt / audit-checkpoint-link event
 * verbatim (never compacted within retention — deletion is I-16's concern) plus every event past the
 * boundary. Because RETAINED_KINDS carry no state effect, snapshot(baseline) + fold(retained) is
 * provably identical to fold(all) — so a rebuild after `compact` is byte-equivalent. Held under the
 * lock; the segment rewrite re-verifies ownership and aborts (skipped) if the lock was reclaimed.
 */
export function compact(root: string, opts: CompactOptions = {}): CompactReport {
  const segMax = opts.segmentMaxBytes;
  return withInboxLock(root, (ownsLock) => {
    const { events } = readJournalSegments(root);
    const oldBaselineRaw = readSnapshot(root);
    const oldBaseline = oldBaselineRaw ? parseBaseline(oldBaselineRaw) : null;
    const maxSeq = events.reduce((m, e) => (e.seq > m ? e.seq : m), 0);
    const boundary = opts.boundarySeq ?? maxSeq;

    // Prune only TRANSITION_KIND events at/under the boundary (their effect is captured by the
    // snapshot). Everything else — RETAINED_KINDS (tombstones/receipts/audit) and all post-boundary
    // events — is kept verbatim. An unclassified kind (shouldn't happen) is kept conservatively.
    const pruned: InboxEvent[] = [];
    const retained: InboxEvent[] = [];
    for (const ev of events) {
      if (ev.seq <= boundary && TRANSITION_KINDS.has(ev.kind)) pruned.push(ev);
      else retained.push(ev);
    }

    const baselineState = foldEvents(pruned, oldBaseline ?? undefined);
    const snapshot = serializeBaseline(baselineState.items, boundary);
    writeSnapshot(root, snapshot);

    const rewrite = rewriteSegments(root, retained, ownsLock, segMax);
    if (rewrite.skipped) {
      return {
        skipped: true,
        boundarySeq: boundary,
        prunedEvents: pruned.length,
        retainedEvents: retained.length,
        tombstones: 0,
        receipts: 0,
        auditLinks: 0,
      };
    }
    let tombstones = 0;
    let receipts = 0;
    let auditLinks = 0;
    for (const ev of retained) {
      if (ev.kind === "capability-consumption") tombstones++;
      else if (ev.kind === "native-receipt") receipts++;
      else if (ev.kind === "audit-checkpoint-link") auditLinks++;
    }
    return {
      skipped: false,
      boundarySeq: boundary,
      prunedEvents: pruned.length,
      retainedEvents: retained.length,
      tombstones,
      receipts,
      auditLinks,
    };
  });
}

// Re-exported convenience so index.ts can surface a single append entry point alongside rebuild.
export { appendInboxEvent };
export type { InboxEvent, InboxEventKind, ActionState, AttentionState, SourceState };
