// Unified inbox — the enriched adapter-observation record (I-06 / AIO-387).
//
// The shipped `CommsActivityRecord` (see src/operator-loop/sources/comms.ts) lacks account/tenant
// identity, object kind, thread id, participants, and edit/delete revisions. Without them:
//   • multi-account dedup is WRONG — two Gmail accounts observing the same forwarded message
//     collapse to one item (they share the same native id), and
//   • the reply PDP (I-10) cannot resolve participant identity.
//
// This module introduces the VERSIONED `EnrichedObservation` record (per the I-01 domain spec,
// section "Enriched adapter-observation record") and the dual-read PROJECTION that folds both the
// enriched log AND the legacy `activity.jsonl` stream into one keyed item set. The gog writer
// (scaffold/.claude/descriptors/skills/gog-activity/gog-activity-pull.mjs) emits BOTH streams; the
// legacy stream stays byte-identical so existing readers (comms.ts, the I-02 read-model advisory
// join) are untouched.
//
// The CORRECTED dedup key is `(connection/account/tenant, object_kind, native_id)` — account/tenant
// are part of the identity, so a native id reused across two accounts yields TWO items, not one.
//
// Transactional cursors: the adapter cursor is carried ON each observation line, so it advances
// exactly with the durable record — there is NO separate cursor file that can race ahead of the
// data (no cursor-ahead-of-a-crash window). On restart the adapter reads the last durable cursor
// from the log and resumes; an overlapping re-pull is deduped by `observationLineKey`, so a crash
// between "write record" and "advance cursor" can never produce duplicate items.
//
// Tier: admin-tier local state under `.aios/loop/inbox/` — NEVER added to `sync_include`, never
// pushed to the Team Brain, no comms plaintext ever leaves the machine (bodies are not stored;
// only snippets + metadata, with on-demand fetch under the retention policy). Same-domain imports
// only (journal.js for the inbox dir constant); NO cross-domain value imports.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { INBOX_DIR_REL } from "./journal.js";

// ── constants ──────────────────────────────────────────────────────────────────────────────────────

/** Current enriched-observation line schema. Bump when the on-disk record shape changes. */
export const OBSERVATIONS_SCHEMA_VERSION = 1;
/** Enriched observation log, relative to the repo root (admin-tier, never synced). */
export const OBSERVATIONS_BASENAME = "observations.ndjson";

/** Object kinds an adapter can observe. Open-ended by contract (the `| string` escape hatch keeps
 *  new adapters — m365 / Telegram / Slack — landing without a schema bump), but these are the ones
 *  the gog adapter emits today. */
export type ObjectKind = "email" | "calendar-event" | "message" | (string & {});
export type RevisionOp = "create" | "edit" | "delete";

export interface ObservationParticipant {
  /** Stable identity within the account/tenant (usually an email or handle). */
  id: string;
  /** Human display name when the adapter has one. */
  display?: string | null;
  /** Role on the object when meaningful (organizer / attendee / from / to …). */
  role?: string | null;
}

export interface ObservationRevision {
  op: RevisionOp;
  /** Monotonic per dedup key: create = 0, each subsequent edit/delete increments. */
  revision: number;
  ts: string;
}

/**
 * A single versioned observation of one native object by one account/tenant connection. Identity
 * fields (`connection_id`, `account`, `tenant`, `object_kind`, `native_id`) are MANDATORY for new
 * adapters — they form the corrected dedup key. Bodies are never stored; `snippet` + `metadata`
 * carry the light context, with on-demand fetch under retention.
 */
export interface EnrichedObservation {
  schema_version: number;
  connection_id: string;
  account: string;
  tenant: string;
  object_kind: ObjectKind;
  native_id: string;
  thread_id: string | null;
  participants: ObservationParticipant[];
  revision: ObservationRevision;
  ts: string;
  snippet: string | null;
  /** Adapter cursor/page-token as of THIS record — carried with the data (transactional cursor). */
  cursor: string | null;
  metadata: Record<string, unknown>;
}

/** Caller shape for `buildObservation`; `schema_version`/`ts`/`revision` are defaulted/stamped. */
export interface ObservationInput {
  connection_id: string;
  account: string;
  tenant: string;
  object_kind: ObjectKind;
  native_id: string;
  thread_id?: string | null;
  participants?: ObservationParticipant[];
  revision?: Partial<ObservationRevision>;
  ts?: string;
  snippet?: string | null;
  cursor?: string | null;
  metadata?: Record<string, unknown>;
}

export class ObservationValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`enriched observation: ${message}`);
    this.name = "ObservationValidationError";
    this.field = field;
  }
}

// ── keys ─────────────────────────────────────────────────────────────────────────────────────────

function requireStr(v: unknown, field: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new ObservationValidationError(field, `${field} must be a non-empty string`);
  }
  return v;
}

/**
 * The CORRECTED dedup key: `(connection/account/tenant, object_kind, native_id)`. Account and tenant
 * are part of identity, so the SAME native message seen through two accounts produces two distinct
 * keys → two items. Serialized as a JSON tuple so no field separator can be spoofed by a value that
 * itself contains the separator.
 */
export function observationDedupKey(o: {
  connection_id: string;
  account: string;
  tenant: string;
  object_kind: string;
  native_id: string;
}): string {
  return JSON.stringify([o.connection_id, o.account, o.tenant, o.object_kind, o.native_id]);
}

/**
 * The scope-FREE object identity `(object_kind, native_id)`. Used ONLY to reconcile a legacy
 * `activity.jsonl` record (which carries no account/tenant) against its enriched twin during
 * dual-read: a legacy record whose object identity is already covered by an enriched observation is
 * absorbed (no duplicate item). It is deliberately NOT the dedup key — using it as such would
 * re-introduce the multi-account collision this issue fixes.
 */
export function observationObjectKey(o: { object_kind: string; native_id: string }): string {
  return JSON.stringify([o.object_kind, o.native_id]);
}

/** Idempotency key for a single observation LINE = dedup key + this revision's op + number. Two
 *  writes of the same revision (e.g. a crash re-pull of the same page) collapse to one line. */
export function observationLineKey(o: EnrichedObservation): string {
  return createHash("sha256")
    .update(observationDedupKey(o))
    .update("|")
    .update(o.revision.op)
    .update("|")
    .update(String(o.revision.revision))
    .digest("hex");
}

// ── build + validate ─────────────────────────────────────────────────────────────────────────────

/** Validate + stamp an input into a storable `EnrichedObservation`. */
export function buildObservation(input: ObservationInput): EnrichedObservation {
  if (!input || typeof input !== "object") {
    throw new ObservationValidationError("observation", "not an object");
  }
  const connection_id = requireStr(input.connection_id, "connection_id");
  const account = requireStr(input.account, "account");
  const tenant = requireStr(input.tenant, "tenant");
  const object_kind = requireStr(input.object_kind, "object_kind");
  const native_id = requireStr(input.native_id, "native_id");

  const rev = input.revision ?? {};
  const op: RevisionOp = rev.op === "edit" || rev.op === "delete" ? rev.op : "create";
  const revNum =
    typeof rev.revision === "number" && Number.isFinite(rev.revision) && rev.revision >= 0
      ? Math.floor(rev.revision)
      : 0;
  const ts = typeof input.ts === "string" && input.ts ? input.ts : new Date().toISOString();

  const participants: ObservationParticipant[] = Array.isArray(input.participants)
    ? input.participants
        .filter((p): p is ObservationParticipant => !!p && typeof p.id === "string" && !!p.id)
        .map((p) => ({
          id: p.id,
          display: typeof p.display === "string" ? p.display : null,
          role: typeof p.role === "string" ? p.role : null,
        }))
    : [];

  return {
    schema_version: OBSERVATIONS_SCHEMA_VERSION,
    connection_id,
    account,
    tenant,
    object_kind,
    native_id,
    thread_id: typeof input.thread_id === "string" && input.thread_id ? input.thread_id : null,
    participants,
    revision: { op, revision: revNum, ts: rev.ts ?? ts },
    ts,
    snippet: typeof input.snippet === "string" ? input.snippet : null,
    cursor: typeof input.cursor === "string" && input.cursor ? input.cursor : null,
    metadata:
      input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? input.metadata
        : {},
  };
}

/** Fixed key order → stable line bytes for identical observations. */
function serializeObservation(o: EnrichedObservation): string {
  return JSON.stringify({
    schema_version: o.schema_version,
    connection_id: o.connection_id,
    account: o.account,
    tenant: o.tenant,
    object_kind: o.object_kind,
    native_id: o.native_id,
    thread_id: o.thread_id,
    participants: o.participants,
    revision: o.revision,
    ts: o.ts,
    snippet: o.snippet,
    cursor: o.cursor,
    metadata: o.metadata,
  });
}

/** Parse one physical line → an observation, or a rejection reason (never throws). */
export function parseObservationLine(
  text: string
): { observation: EnrichedObservation } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: "malformed-json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: "not-an-object" };
  }
  const o = parsed as Record<string, unknown>;
  const sv = o.schema_version;
  if (typeof sv !== "number" || sv !== OBSERVATIONS_SCHEMA_VERSION) {
    return { reason: "unknown-schema-version" };
  }
  try {
    const rev = (o.revision ?? {}) as Record<string, unknown>;
    const observation = buildObservation({
      connection_id: o.connection_id as string,
      account: o.account as string,
      tenant: o.tenant as string,
      object_kind: o.object_kind as string,
      native_id: o.native_id as string,
      thread_id: (o.thread_id ?? null) as string | null,
      participants: Array.isArray(o.participants)
        ? (o.participants as ObservationParticipant[])
        : [],
      revision: {
        op: rev.op as RevisionOp,
        revision: rev.revision as number,
        ts: rev.ts as string,
      },
      ts: o.ts as string,
      snippet: (o.snippet ?? null) as string | null,
      cursor: (o.cursor ?? null) as string | null,
      metadata: (o.metadata ?? {}) as Record<string, unknown>,
    });
    return { observation };
  } catch (e) {
    return { reason: (e as Error).message };
  }
}

// ── paths + read ───────────────────────────────────────────────────────────────────────────────────

export function observationsPath(root: string): string {
  return path.join(root, INBOX_DIR_REL, OBSERVATIONS_BASENAME);
}

export interface ObservationReadWarning {
  line: number;
  reason: string;
}

export interface ObservationReadResult {
  observations: EnrichedObservation[];
  warnings: ObservationReadWarning[];
  /** True iff the last physical line was a partial/torn write that recovery dropped. */
  tornTail: boolean;
  /** Last durable adapter cursor per connection_id (transactional — reflects the last record). */
  cursors: Map<string, string>;
}

/**
 * Read + parse the enriched observation log. A partial/torn LAST line (a crash mid-append) is
 * dropped as `tornTail` — at most one line lost, never a corrupt fold. Interior malformed lines are
 * warnings, never silently dropped. `cursors` carries the last durable cursor per connection so an
 * adapter resumes exactly where the last record landed (no cursor-ahead-of-data window).
 */
export function readObservations(root: string, overridePath?: string): ObservationReadResult {
  const file = overridePath ?? observationsPath(root);
  const observations: EnrichedObservation[] = [];
  const warnings: ObservationReadWarning[] = [];
  const cursors = new Map<string, string>();
  let tornTail = false;
  if (!existsSync(file)) return { observations, warnings, tornTail, cursors };

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { observations, warnings, tornTail, cursors };
  }
  if (raw === "") return { observations, warnings, tornTail, cursors };

  const endsWithNl = raw.endsWith("\n");
  const parts = raw.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  parts.forEach((text, li) => {
    if (!text.trim()) return;
    const isLastPhysical = li === parts.length - 1;
    const res = parseObservationLine(text);
    if ("observation" in res) {
      observations.push(res.observation);
      if (res.observation.cursor)
        cursors.set(res.observation.connection_id, res.observation.cursor);
      return;
    }
    if (isLastPhysical && !endsWithNl) {
      tornTail = true; // torn tail — drop, no warning (recovery, not corruption)
      return;
    }
    warnings.push({ line: li + 1, reason: res.reason });
  });

  return { observations, warnings, tornTail, cursors };
}

/** Last durable adapter cursor for a connection, or null if none written yet. */
export function readCursor(
  root: string,
  connection_id: string,
  overridePath?: string
): string | null {
  return readObservations(root, overridePath).cursors.get(connection_id) ?? null;
}

// ── write (idempotent, cursor-transactional) ────────────────────────────────────────────────────────

/**
 * Append only observations whose LINE key isn't already on disk (idempotent by dedup key + revision).
 * A crash re-pull of an overlapping page therefore never duplicates a line. The adapter cursor rides
 * on each record, so the persisted cursor advances exactly with the durable data. Returns
 * `{ written, skipped }`.
 */
export function appendObservations(
  root: string,
  observations: readonly EnrichedObservation[],
  overridePath?: string
): { written: number; skipped: number } {
  const file = overridePath ?? observationsPath(root);
  mkdirSync(path.dirname(file), { recursive: true });

  const existing = new Set<string>();
  for (const o of readObservations(root, overridePath).observations) {
    existing.add(observationLineKey(o));
  }
  const seenThisRun = new Set<string>();
  const fresh: EnrichedObservation[] = [];
  for (const o of observations) {
    const key = observationLineKey(o);
    if (existing.has(key) || seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    fresh.push(o);
  }
  if (fresh.length) {
    const lines = fresh.map((o) => serializeObservation(o)).join("\n") + "\n";
    appendFileSync(file, lines); // single O_APPEND write — crash-safe (torn tail recovered on read)
  }
  return { written: fresh.length, skipped: observations.length - fresh.length };
}

/**
 * Append a single enriched observation to the log (idempotent). Async by contract (I-06 interface)
 * so future adapters can back it with an async store without a signature change; today it wraps the
 * synchronous crash-safe append.
 */
export async function writeObservation(
  root: string,
  observation: EnrichedObservation,
  overridePath?: string
): Promise<void> {
  appendObservations(root, [observation], overridePath);
}

// ── dual-read projection ────────────────────────────────────────────────────────────────────────────

/** One legacy `activity.jsonl` record (the shape gog-activity-pull.mjs writes, unchanged). */
export interface LegacyActivityRecord {
  source?: unknown;
  ref?: unknown;
  occurredAt?: unknown;
  summary?: unknown;
  channel?: unknown;
  direction?: unknown;
}

/** A projected inbox item: one logical object, its identity, current state, and revision history. */
export interface ProjectedItem {
  key: string;
  connection_id: string | null;
  account: string | null;
  tenant: string | null;
  object_kind: string;
  native_id: string;
  thread_id: string | null;
  participants: ObservationParticipant[];
  snippet: string | null;
  deleted: boolean;
  revisions: ObservationRevision[];
  ts: string;
  /** Where the item's identity came from: an enriched observation, or a legacy-only record. */
  origin: "enriched" | "legacy";
}

/** Map a legacy `source` + `ref` to a scope-free object identity, or null if unmappable. Mirrors the
 *  gog writer's `ref` scheme (`cal:<id>` / `gmail:<id>` / `slack:<conv>:<ts>`). */
export function legacyToObjectRef(
  record: LegacyActivityRecord
): { object_kind: ObjectKind; native_id: string } | null {
  const source = typeof record.source === "string" ? record.source : null;
  const ref = typeof record.ref === "string" ? record.ref : null;
  if (!ref) return null;
  const colon = ref.indexOf(":");
  const prefix = colon === -1 ? "" : ref.slice(0, colon);
  const rest = colon === -1 ? ref : ref.slice(colon + 1);
  if (!rest) return null;
  const kind: ObjectKind | null =
    source === "calendar" || prefix === "cal"
      ? "calendar-event"
      : source === "email" || prefix === "gmail"
        ? "email"
        : source === "slack" || prefix === "slack"
          ? "message"
          : null;
  if (!kind) return null;
  return { object_kind: kind, native_id: rest };
}

export interface ProjectInput {
  enriched?: readonly EnrichedObservation[];
  legacy?: readonly LegacyActivityRecord[];
}

/**
 * Dual-read projection: fold the enriched observation log AND the legacy `activity.jsonl` stream
 * into one keyed item map.
 *
 *   • Enriched observations group by the CORRECTED dedup key `(connection/account/tenant,
 *     object_kind, native_id)` — so the same native object seen through two accounts is TWO items.
 *   • Revisions with the same dedup key fold into ONE item (create → edit → delete) in
 *     `revision`-then-`ts` order; a `delete` sets `deleted`, it does NOT create a new item.
 *   • Legacy records reconcile by scope-free object identity `(object_kind, native_id)`: a legacy
 *     record whose object is already covered by ANY enriched observation is absorbed (its enriched
 *     twin owns the item — no duplicate). A legacy record with no enriched twin projects as its own
 *     `legacy`-origin item (account/tenant unknown).
 *
 * Deterministic: identical inputs → identical item map (revisions sorted, insertion via a Map keyed
 * by the dedup key / a stable `legacy:` key).
 */
export function projectObservations(input: ProjectInput): Map<string, ProjectedItem> {
  const items = new Map<string, ProjectedItem>();
  const coveredObjects = new Set<string>();

  // Pass 1 — enriched. Sort by (dedup key, revision, ts) for a deterministic fold.
  const enriched = [...(input.enriched ?? [])].sort((a, b) => {
    const ka = observationDedupKey(a);
    const kb = observationDedupKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    if (a.revision.revision !== b.revision.revision)
      return a.revision.revision - b.revision.revision;
    return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
  });

  for (const o of enriched) {
    const key = observationDedupKey(o);
    coveredObjects.add(observationObjectKey(o));
    let item = items.get(key);
    if (!item) {
      item = {
        key,
        connection_id: o.connection_id,
        account: o.account,
        tenant: o.tenant,
        object_kind: o.object_kind,
        native_id: o.native_id,
        thread_id: o.thread_id,
        participants: o.participants,
        snippet: o.snippet,
        deleted: false,
        revisions: [],
        ts: o.ts,
        origin: "enriched",
      };
      items.set(key, item);
    }
    // Later fields win (edits update the current view); revisions accumulate. A `delete` marks the
    // item deleted but does NOT overwrite the last-known content view (snippet/participants) — the
    // item is gone, not re-authored.
    item.thread_id = o.thread_id ?? item.thread_id;
    item.ts = o.ts;
    item.revisions.push(o.revision);
    if (o.revision.op === "delete") {
      item.deleted = true;
    } else {
      if (o.participants.length) item.participants = o.participants;
      item.snippet = o.snippet ?? item.snippet;
    }
  }

  // Pass 2 — legacy. Absorb into an enriched twin when the object is already covered; otherwise a
  // standalone legacy-origin item keyed by its object identity (scope unknown).
  for (const rec of input.legacy ?? []) {
    const ref = legacyToObjectRef(rec);
    if (!ref) continue;
    const objectKey = observationObjectKey(ref);
    if (coveredObjects.has(objectKey)) continue; // enriched twin owns the item
    const key = `legacy:${objectKey}`;
    if (items.has(key)) continue; // already projected this legacy object
    const ts = typeof rec.occurredAt === "string" ? rec.occurredAt : "";
    items.set(key, {
      key,
      connection_id: null,
      account: null,
      tenant: null,
      object_kind: ref.object_kind,
      native_id: ref.native_id,
      thread_id: null,
      participants: [],
      snippet: typeof rec.summary === "string" ? rec.summary : null,
      deleted: false,
      revisions: [{ op: "create", revision: 0, ts }],
      ts,
      origin: "legacy",
    });
  }

  return items;
}
