// Unified inbox — tamper-evident audit log + D6 checkpoint anchoring (I-16 / AIO-397).
//
// This is the `audit_log` the domain spec's D6 ruling calls for: a log **distinct from the agent-
// event journal** (`inbox-events.ndjson`). The journal records what the loop did; this log records
// the AUTHENTICATED GOVERNANCE trail — who authorized what, which PDP verdict allowed it, which
// runtime/transport receipt bound it — as an append-only hash chain that a control plane
// INDEPENDENT of the inbox host periodically anchors, so tampering with the local log is detectable
// after a crash/restore.
//
// Content-free by construction: a record carries a `payload_digest` (sha256 of the decision
// payload), NEVER the payload itself — no message bodies, subjects, or participant plaintext. This
// is what reconciles tamper-evidence retention with the deletion obligations in retention.ts:
// deleting a user's content leaves the digest intact, so `verifyChain` still passes after deletion.
//
// D6 anchor ruling (unified-inbox.md §8): the Team Brain checkpoint endpoint, **digests only**,
// tier-reviewed in docs/brain-api.md before first live use. This module does NOT push to the brain
// — anchoring is expressed against the `AnchorSink` interface; the live Team Brain adapter is a
// separate, tier-reviewed integration. `createLocalAnchorSink` is the host-independent file sink
// used by tests (and as the signed-ref fallback substrate): it lives OUTSIDE the inbox store, so a
// wipe/restore of the inbox never erases the anchors the restored log is verified against.
//
// Tier: admin-tier local state under `.aios/loop/inbox/` — NEVER added to `sync_include`.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { INBOX_DIR_REL, withInboxLock } from "./journal.js";

// ── paths + constants ─────────────────────────────────────────────────────────────────────────────

export const AUDIT_LOG_BASENAME = "audit-log.ndjson";
export const AUDIT_ANCHORS_BASENAME = "audit-anchors.ndjson";
export const AUDIT_SCHEMA_VERSION = 1;
/** Hash-chain root sentinel — the `prev_hash` of the first record. */
export const AUDIT_GENESIS = "sha256:genesis";

/**
 * Immutable governance event vocabulary. Distinct from the inbox journal's `InboxEventKind`: these
 * are authenticated audit facts, not loop-state transitions. New members append only (never rename
 * — a rename would break historical hashes).
 */
export const AUDIT_EVENTS = [
  "capability.issued",
  "capability.consumed",
  "pdp.decision",
  "action.attempt",
  "action.outcome",
  "retention.deletion",
  "anchor.checkpoint",
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];
const EVENT_SET: ReadonlySet<string> = new Set(AUDIT_EVENTS);

// ── types ────────────────────────────────────────────────────────────────────────────────────────

export interface AuditRecord {
  schema_version: number;
  /** Monotonic, contiguous from 1 — total order of the audit log. */
  seq: number;
  /** Authenticated actor identity (e.g. `owner:alex`, `runtime:claude-code`). Never anonymous. */
  actor: string;
  event: AuditEvent;
  correlation_id: string | null;
  causation_id: string | null;
  /** Client-supplied event time (may be untrusted). */
  client_ts: string;
  /** Coordinator-stamped receive time (authoritative ordering clock). */
  server_ts: string;
  /** sha256 of the decision payload — bodies excluded where a hash suffices. */
  payload_digest: string;
  /** Transport/runtime receipt binding (runtime tombstone id, native provider id) or null. */
  receipt: string | null;
  /** Hash of the previous record (AUDIT_GENESIS at the chain root). */
  prev_hash: string;
  /** sha256 over every field above, including prev_hash. Excludes itself. */
  hash: string;
}

/** Caller shape for `appendAuditRecord` — seq/server_ts/prev_hash/hash are stamped. */
export interface AppendAuditInput {
  actor: string;
  event: AuditEvent;
  correlation_id?: string | null;
  causation_id?: string | null;
  client_ts?: string;
  /** The decision payload to digest (bodies allowed here — only the DIGEST is stored). */
  payload?: unknown;
  /** A precomputed digest, used instead of `payload` when the caller already hashed. */
  payload_digest?: string;
  receipt?: string | null;
  /** Override the server clock (tests). Defaults to now. */
  server_ts?: string;
}

export interface Anchor {
  through_seq: number;
  count: number;
  /** Hash of the last record covered by this anchor. */
  chain_head: string;
  /** sha256 over the ordered record hashes through `through_seq` (digests only). */
  digest: string;
  /** Opaque id returned by the control plane. */
  anchor_ref: string;
  /** Control-plane-stamped time — host-independent, survives an inbox restore. */
  anchored_at: string;
  /** Signing-key / control-plane signature over (through_seq, chain_head, digest), or null. */
  signature: string | null;
}

/**
 * The host-independent control plane the audit chain is anchored to. Production = the Team Brain
 * checkpoint endpoint (digests only, tier-reviewed). Tests + the signed-ref fallback use
 * `createLocalAnchorSink`. Only digests/heads cross this boundary — never records or payloads.
 */
export interface AnchorSink {
  submit(input: {
    through_seq: number;
    count: number;
    chain_head: string;
    digest: string;
    at: string;
  }): Anchor;
  list(): Anchor[];
}

export interface AuditReadResult {
  records: AuditRecord[];
  warnings: Array<{ line: number; reason: string }>;
  /** True iff the last physical line was a partial/torn write recovery dropped. */
  tornTail: boolean;
}

export interface VerifyFailure {
  seq: number | null;
  reason: string;
}
export interface VerifyResult {
  ok: boolean;
  records: number;
  checkedThrough: number;
  anchorsChecked: number;
  failures: VerifyFailure[];
}

export class AuditValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`audit record: ${message}`);
    this.name = "AuditValidationError";
    this.field = field;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────

function inboxDir(root: string): string {
  return path.join(root, INBOX_DIR_REL);
}
export function auditLogPath(root: string): string {
  return path.join(inboxDir(root), AUDIT_LOG_BASENAME);
}
export function auditAnchorsPath(root: string): string {
  return path.join(inboxDir(root), AUDIT_ANCHORS_BASENAME);
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Deterministic JSON: object keys sorted recursively so identical values hash identically. */
function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  const rec = v as Record<string, unknown>;
  const keys = Object.keys(rec).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(",")}}`;
}

/** sha256 digest of an arbitrary payload (bodies allowed in → only the digest comes out). */
export function digestPayload(payload: unknown): string {
  return `sha256:${sha256Hex(canonicalize(payload))}`;
}

/** The canonical bytes a record's `hash` covers — every field except `hash`, in fixed key order. */
function hashableBody(r: Omit<AuditRecord, "hash">): string {
  return canonicalize({
    schema_version: r.schema_version,
    seq: r.seq,
    actor: r.actor,
    event: r.event,
    correlation_id: r.correlation_id,
    causation_id: r.causation_id,
    client_ts: r.client_ts,
    server_ts: r.server_ts,
    payload_digest: r.payload_digest,
    receipt: r.receipt,
    prev_hash: r.prev_hash,
  });
}

/** Recompute the hash a record MUST carry given its other fields. */
export function computeRecordHash(r: Omit<AuditRecord, "hash">): string {
  return `sha256:${sha256Hex(hashableBody(r))}`;
}

function serializeRecord(r: AuditRecord): string {
  return JSON.stringify({
    schema_version: r.schema_version,
    seq: r.seq,
    actor: r.actor,
    event: r.event,
    correlation_id: r.correlation_id,
    causation_id: r.causation_id,
    client_ts: r.client_ts,
    server_ts: r.server_ts,
    payload_digest: r.payload_digest,
    receipt: r.receipt,
    prev_hash: r.prev_hash,
    hash: r.hash,
  });
}

function isRecordObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Parse one physical line → a record or a rejection reason (never throws). */
export function parseAuditLine(text: string): { record: AuditRecord } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "malformed-json" };
  }
  if (!isRecordObj(parsed)) return { reason: "not-an-object" };
  const sv = parsed.schema_version;
  if (typeof sv !== "number") return { reason: "missing-schema-version" };
  const seq = parsed.seq;
  if (typeof seq !== "number" || !Number.isFinite(seq)) return { reason: "missing-seq" };
  const actor = asStr(parsed.actor);
  if (!actor) return { reason: "missing-actor" };
  const event = asStr(parsed.event);
  if (!event || !EVENT_SET.has(event)) return { reason: "unknown-event" };
  const payload_digest = asStr(parsed.payload_digest);
  if (!payload_digest) return { reason: "missing-payload-digest" };
  const prev_hash = asStr(parsed.prev_hash);
  if (!prev_hash) return { reason: "missing-prev-hash" };
  const hash = asStr(parsed.hash);
  if (!hash) return { reason: "missing-hash" };
  return {
    record: {
      schema_version: sv,
      seq,
      actor,
      event: event as AuditEvent,
      correlation_id: asStr(parsed.correlation_id) ?? null,
      causation_id: asStr(parsed.causation_id) ?? null,
      client_ts: asStr(parsed.client_ts) ?? "",
      server_ts: asStr(parsed.server_ts) ?? "",
      payload_digest,
      receipt: asStr(parsed.receipt) ?? null,
      prev_hash,
      hash,
    },
  };
}

// ── read (torn-tail-safe) ─────────────────────────────────────────────────────────────────────────

/**
 * Read + parse the whole audit log. A partial/torn LAST line (crash mid-append) is dropped as
 * `tornTail` — at most one line lost, never a corrupt fold. Interior malformed lines are warnings,
 * never silently absorbed. Records are returned in file order (== seq order for a single writer).
 */
export function readAuditLog(root: string): AuditReadResult {
  const p = auditLogPath(root);
  const out: AuditReadResult = { records: [], warnings: [], tornTail: false };
  if (!existsSync(p)) return out;
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    out.warnings.push({ line: 0, reason: "unreadable" });
    return out;
  }
  if (raw === "") return out;
  const endsWithNl = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  parts.forEach((text, li) => {
    if (!text.trim()) return;
    const isLast = li === parts.length - 1;
    const res = parseAuditLine(text);
    if ("record" in res) {
      out.records.push(res.record);
      return;
    }
    if (isLast && !endsWithNl) {
      out.tornTail = true;
      return;
    }
    out.warnings.push({ line: li + 1, reason: res.reason });
  });
  return out;
}

// ── append (crash-safe, lock-protected) ────────────────────────────────────────────────────────────

function validateAppend(input: AppendAuditInput): void {
  if (!input || typeof input !== "object") throw new AuditValidationError("input", "not an object");
  if (typeof input.actor !== "string" || !input.actor.trim())
    throw new AuditValidationError("actor", "actor must be a non-empty authenticated identity");
  if (!EVENT_SET.has(input.event))
    throw new AuditValidationError(
      "event",
      `unknown event "${String(input.event)}" (expected one of ${AUDIT_EVENTS.join("|")})`
    );
  if (input.payload === undefined && input.payload_digest === undefined)
    throw new AuditValidationError("payload", "provide payload or payload_digest");
}

/**
 * Append one audit record under the inbox lock (same discipline as the journal writer — no line is
 * lost during a concurrent op). The record's `prev_hash` links to the current tail; its `hash`
 * seals the record. Returns the stamped record.
 */
export function appendAuditRecord(root: string, input: AppendAuditInput): AuditRecord {
  validateAppend(input);
  mkdirSync(inboxDir(root), { recursive: true });
  return withInboxLock(root, () => {
    const { records } = readAuditLog(root);
    const prev = records.length ? (records[records.length - 1] as AuditRecord) : null;
    const now = new Date().toISOString();
    const body: Omit<AuditRecord, "hash"> = {
      schema_version: AUDIT_SCHEMA_VERSION,
      seq: prev ? prev.seq + 1 : 1,
      actor: input.actor,
      event: input.event,
      correlation_id: input.correlation_id ?? null,
      causation_id: input.causation_id ?? null,
      client_ts: input.client_ts ?? now,
      server_ts: input.server_ts ?? now,
      payload_digest:
        input.payload_digest ?? digestPayload(input.payload === undefined ? {} : input.payload),
      receipt: input.receipt ?? null,
      prev_hash: prev ? prev.hash : AUDIT_GENESIS,
    };
    const record: AuditRecord = { ...body, hash: computeRecordHash(body) };
    appendFileSync(auditLogPath(root), serializeRecord(record) + "\n");
    return record;
  });
}

// ── chain digest + checkpoint anchoring ─────────────────────────────────────────────────────────────

/** Ordered digest over the record hashes covered (through `throughSeq`). Digests only. */
export function chainDigest(records: readonly AuditRecord[], throughSeq: number): string {
  const covered = records.filter((r) => r.seq <= throughSeq);
  return `sha256:${sha256Hex(covered.map((r) => r.hash).join("\n"))}`;
}

/**
 * A file-backed, host-independent anchor sink. Anchors persist under `dir` (kept OUTSIDE the inbox
 * store so a wipe/restore of the inbox never erases them). Doubles as the signed-ref-fallback
 * substrate. `signer` optionally seals each anchor; absent → `signature: null` (never a false claim
 * of a signature). Only digests/heads are ever written here.
 */
export function createLocalAnchorSink(
  dir: string,
  opts: { signer?: (material: string) => string } = {}
): AnchorSink {
  const file = path.join(dir, AUDIT_ANCHORS_BASENAME);
  const readAll = (): Anchor[] => {
    if (!existsSync(file)) return [];
    const anchors: Anchor[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const a = JSON.parse(line) as Anchor;
        if (typeof a.through_seq === "number" && typeof a.chain_head === "string") anchors.push(a);
      } catch {
        /* skip a torn/garbage anchor line — verify still checks the survivors */
      }
    }
    return anchors;
  };
  return {
    submit(input) {
      mkdirSync(dir, { recursive: true });
      const material = canonicalize({
        through_seq: input.through_seq,
        chain_head: input.chain_head,
        digest: input.digest,
      });
      const anchor: Anchor = {
        through_seq: input.through_seq,
        count: input.count,
        chain_head: input.chain_head,
        digest: input.digest,
        anchor_ref: `anchor:${randomUUID()}`,
        anchored_at: input.at,
        signature: opts.signer ? opts.signer(material) : null,
      };
      appendFileSync(file, JSON.stringify(anchor) + "\n");
      return anchor;
    },
    list: readAll,
  };
}

export interface CheckpointResult {
  anchor: Anchor;
  /** The `anchor.checkpoint` audit record appended after anchoring, or null if the log was empty. */
  record: AuditRecord | null;
}

/**
 * Emit a checkpoint: compute the chain head + digest through `throughSeq` (default = tail), submit
 * them to the sink, then append an `anchor.checkpoint` audit record binding the anchor_ref+digest
 * (so the anchoring itself is audited). Only digests/heads cross to the sink — never records.
 */
export function checkpoint(
  root: string,
  sink: AnchorSink,
  opts: { throughSeq?: number; actor?: string; at?: string } = {}
): CheckpointResult {
  const { records } = readAuditLog(root);
  if (records.length === 0) {
    throw new AuditValidationError("log", "cannot checkpoint an empty audit log");
  }
  const tail = records[records.length - 1] as AuditRecord;
  const throughSeq = opts.throughSeq ?? tail.seq;
  const covered = records.filter((r) => r.seq <= throughSeq);
  if (covered.length === 0) {
    throw new AuditValidationError("throughSeq", `no records at/under seq ${throughSeq}`);
  }
  const head = covered[covered.length - 1] as AuditRecord;
  const at = opts.at ?? new Date().toISOString();
  const anchor = sink.submit({
    through_seq: throughSeq,
    count: covered.length,
    chain_head: head.hash,
    digest: chainDigest(records, throughSeq),
    at,
  });
  const record = appendAuditRecord(root, {
    actor: opts.actor ?? "coordinator:audit",
    event: "anchor.checkpoint",
    payload_digest: anchor.digest,
    receipt: anchor.anchor_ref,
    server_ts: at,
    client_ts: at,
  });
  return { anchor, record };
}

// ── cadence driver ──────────────────────────────────────────────────────────────────────────────────

/** True iff a checkpoint is due: no anchors yet, or `now - lastAnchor >= cadenceMs`. */
export function checkpointDue(
  anchors: readonly Anchor[],
  opts: { cadenceMs: number; now: number }
): boolean {
  if (anchors.length === 0) return true;
  const last = anchors.reduce((a, b) => (a.through_seq >= b.through_seq ? a : b));
  const lastMs = Date.parse(last.anchored_at);
  if (!Number.isFinite(lastMs)) return true;
  return opts.now - lastMs >= opts.cadenceMs;
}

export interface CadenceResult {
  emitted: boolean;
  anchor: Anchor | null;
  reason: "emitted" | "not-due" | "no-new-records";
}

/**
 * Emit a checkpoint iff the cadence elapsed AND there are unanchored records. `now` is injectable so
 * a time-faked run drives the cadence deterministically. Never emits a redundant anchor over an
 * already-anchored tail (idempotent within a cadence window).
 */
export function runCheckpointCadence(
  root: string,
  sink: AnchorSink,
  opts: { cadenceMs: number; now: number; actor?: string }
): CadenceResult {
  const { records } = readAuditLog(root);
  if (records.length === 0) return { emitted: false, anchor: null, reason: "no-new-records" };
  const anchors = sink.list();
  const lastThrough = anchors.reduce((m, a) => (a.through_seq > m ? a.through_seq : m), 0);
  const tailSeq = (records[records.length - 1] as AuditRecord).seq;
  // Only REAL governance activity triggers a checkpoint. Each checkpoint appends its own
  // `anchor.checkpoint` record; ignoring those as a trigger avoids a perpetual self-heartbeat while
  // still anchoring them (the checkpoint covers the whole tail, including prior checkpoint records).
  const unanchoredReal = records.some(
    (r) => r.seq > lastThrough && r.event !== "anchor.checkpoint"
  );
  if (!unanchoredReal) return { emitted: false, anchor: null, reason: "no-new-records" };
  if (!checkpointDue(anchors, { cadenceMs: opts.cadenceMs, now: opts.now }))
    return { emitted: false, anchor: null, reason: "not-due" };
  const at = new Date(opts.now).toISOString();
  const { anchor } = checkpoint(root, sink, { throughSeq: tailSeq, actor: opts.actor, at });
  return { emitted: true, anchor, reason: "emitted" };
}

// ── verification (explicit pass/fail — no adjective proof claims) ─────────────────────────────────────

/**
 * Verify the hash chain, and (if `anchors` given) that each anchored prefix still matches. Returns
 * an explicit pass/fail with per-seq failure reasons — the caller decides; this function never
 * asserts a record is "trustworthy", only whether the recomputed hashes and anchors agree.
 *
 * Detects: a mutated field (recomputed hash ≠ stored hash), a broken link (prev_hash ≠ prior hash),
 * a non-contiguous seq, a re-hashed tail that an anchor no longer covers, and an anchor digest/head
 * that no longer matches its prefix (the value of host-independent anchoring after a restore).
 */
export function verifyChain(
  records: readonly AuditRecord[],
  anchors: readonly Anchor[] = []
): VerifyResult {
  const failures: VerifyFailure[] = [];
  let prevHash = AUDIT_GENESIS;
  let expectedSeq = 1;
  let checkedThrough = 0;
  for (const r of records) {
    if (r.seq !== expectedSeq) {
      failures.push({ seq: r.seq, reason: `non-contiguous seq (expected ${expectedSeq})` });
    }
    if (r.prev_hash !== prevHash) {
      failures.push({ seq: r.seq, reason: "prev_hash does not link to prior record" });
    }
    const { hash, ...body } = r;
    const recomputed = computeRecordHash(body);
    if (recomputed !== hash) {
      failures.push({ seq: r.seq, reason: "record hash mismatch (content mutated)" });
    }
    prevHash = r.hash;
    expectedSeq = r.seq + 1;
    checkedThrough = r.seq;
  }

  let anchorsChecked = 0;
  for (const a of anchors) {
    const covered = records.filter((rec) => rec.seq <= a.through_seq);
    if (covered.length !== a.count) {
      failures.push({
        seq: a.through_seq,
        reason: `anchor count mismatch (log has ${covered.length}, anchor claims ${a.count})`,
      });
    }
    const head = covered.length ? (covered[covered.length - 1] as AuditRecord).hash : AUDIT_GENESIS;
    if (head !== a.chain_head) {
      failures.push({ seq: a.through_seq, reason: "anchor chain_head mismatch (prefix tampered)" });
    }
    if (chainDigest(records, a.through_seq) !== a.digest) {
      failures.push({ seq: a.through_seq, reason: "anchor digest mismatch (prefix tampered)" });
    }
    anchorsChecked++;
  }

  return {
    ok: failures.length === 0,
    records: records.length,
    checkedThrough,
    anchorsChecked,
    failures,
  };
}

/** Convenience: read the log + anchors from disk and verify. */
export function verifyAuditStore(root: string, sink?: AnchorSink): VerifyResult {
  const { records, tornTail, warnings } = readAuditLog(root);
  const base = verifyChain(records, sink ? sink.list() : []);
  if (tornTail) {
    base.failures.push({ seq: null, reason: "torn tail line dropped on read (crash recovery)" });
  }
  for (const w of warnings) {
    base.failures.push({ seq: null, reason: `line ${w.line}: ${w.reason}` });
  }
  base.ok = base.failures.length === 0;
  return base;
}

/**
 * Copy the audit log + anchors mirror into `backupDir` (a plain byte copy). The deterministic
 * backup half of the retention package; restore is the inverse (see retention.ts). Anchors held by
 * an independent sink are NOT part of this backup — that independence is the point.
 */
export function backupAuditStore(root: string, backupDir: string): { files: string[] } {
  mkdirSync(backupDir, { recursive: true });
  const files: string[] = [];
  for (const base of [AUDIT_LOG_BASENAME, AUDIT_ANCHORS_BASENAME]) {
    const src = path.join(inboxDir(root), base);
    if (!existsSync(src)) continue;
    const dest = path.join(backupDir, base);
    writeFileSync(dest, readFileSync(src));
    files.push(dest);
  }
  return { files };
}

/** Restore the audit log from a backup dir into the inbox store (inverse of `backupAuditStore`). */
export function restoreAuditStore(root: string, backupDir: string): { files: string[] } {
  mkdirSync(inboxDir(root), { recursive: true });
  const files: string[] = [];
  for (const base of [AUDIT_LOG_BASENAME, AUDIT_ANCHORS_BASENAME]) {
    const src = path.join(backupDir, base);
    if (!existsSync(src)) continue;
    const dest = path.join(inboxDir(root), base);
    writeFileSync(dest, readFileSync(src));
    files.push(dest);
  }
  return { files };
}
