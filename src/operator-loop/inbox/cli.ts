// Unified inbox — the read-only projection that merges asks + activity + enriched observations
// into ONE ranked queue (I-09 / AIO-390, the G4 gate).
//
// This is the first user-facing unification: `aios inbox` renders one queue over
//   • the asks escalation store (agent-events), and
//   • the enriched gog observations ∪ legacy activity.jsonl (thread-states, projected via I-06),
// read-only, admin-tier, purely local. Nothing here mutates asks/journal, nothing syncs to the
// Team Brain — `--json` is a LOCAL artifact, not a sync surface (I-09 spec §Tier safety).
//
// Two trust affordances the spec makes load-bearing:
//   • A PROTECTED PARTITION: items that must not be buried by ranking render above a separator.
//   • A RAW escape hatch: pure chronological order, no ranking — "how do I know it isn't hiding
//     anything." (I-09 spec §Interface / §Demo relevance.)
//
// Ranking is deliberately young: this module consumes I-04's `why` / `ranker_version` IF a ranker
// is injected, otherwise it falls back to the deterministic recency order with `why: "recency"`
// (I-04 is NOT a hard dependency — the CLI does not block on it; I-09 spec §Dependencies).
//
// DUAL-READ PARITY is the EXIT gate: every v1 ask field must survive the merge byte-identical to
// `aios asks --json`. This module therefore passes each `Ask` THROUGH VERBATIM as `item.ask` — it
// never re-derives, re-orders, or re-serializes ask fields, so `JSON.stringify(item.ask)` is
// byte-for-byte equal to the ask emitted by `aios asks list --json`.
//
// Domain isolation (Constitution §4): this file lives in the `inbox` domain. It value-imports only
// same-domain modules (`observations.js`); the cross-domain `Ask` shape is a type-only reference
// (the legitimate typed seam). The `asks` store is read and injected by the loop's composition
// point (`src/operator-loop/index.ts` → `buildInbox`), never value-imported here.

import type { Ask } from "../asks/store.js";
import {
  projectObservations,
  type LegacyActivityRecord,
  type ProjectedItem,
} from "./observations.js";

// ── constants ──────────────────────────────────────────────────────────────────────────────────────

/** Ranker id used when no I-04 ranker is injected — the deterministic recency fallback. */
export const INBOX_RANKER_VERSION_FALLBACK = "recency-fallback";
/** Per-row `why` for the recency fallback. */
export const RECENCY_WHY = "recency";
/**
 * Freshness SLO window. The coordinator-up SLO is p95 ingest lag ≤5 min (I-09 spec §Interface);
 * if the newest observation is older than this, the read view is honestly flagged stale rather
 * than pretending freshness it can't vouch for while the coordinator is down.
 */
export const FRESHNESS_SLO_MS = 5 * 60 * 1000;

/** The visual partition between protected items and the rest (rendered on its own line). */
export const PARTITION_SEPARATOR = "──────────────────────────────────────────";

// ── item + view shapes ─────────────────────────────────────────────────────────────────────────────

/** Coarse routing bucket. Buckets are advisory grouping, not a lifecycle state. */
export type InboxBucket = "needs-you" | "in-flight" | "fyi" | "thread" | "done";

/** Origin of an inbox row: an agent escalation, or a projected comms/thread observation. */
export type InboxOrigin = "agent-event" | "thread-state";

/**
 * Content-free host-health badge carried by an `agent-event` row that represents a degraded channel
 * adapter (I-15 / AIO-396). Projected from `AdapterHealth` (host-supervisor.ts) — no message bodies,
 * no credentials, just adapter id / supervision state / restart count.
 */
export interface InboxHealthBadge {
  adapter: string;
  state: string;
  detail: string;
  restarts: number;
}

/**
 * One row of the unified queue (the read-model projection). The v1 ask fields ride UNCHANGED inside
 * `ask` for `agent-event` rows (dual-read parity); `observation` carries the projected thread for
 * `thread-state` rows. The flat fields (`bucket`/`protected`/`why`/`attention_state`/…) are the
 * unified view the GUI (I-14) renders.
 */
export interface InboxItem {
  id: string;
  origin: InboxOrigin;
  /** Channel (thread) or runtime (agent) the row came from. */
  source: string | null;
  /** Account/tenant identity for thread rows; null for agent rows. */
  account: string | null;
  bucket: InboxBucket;
  protected: boolean;
  why: string;
  attention_state: string;
  action_state: string;
  ts: string;
  /** Present iff `origin === "agent-event"` AND the row is a real ask — the v1 ask, byte-identical
   *  to `aios asks --json`. Host-health `agent-event` rows carry `health` instead (never both). */
  ask?: Ask;
  /** Present iff `origin === "thread-state"` — the projected observation. */
  observation?: ProjectedItem;
  /** Present iff the row is a host-health `agent-event` (I-15) — see `InboxHealthBadge`. */
  health?: InboxHealthBadge;
}

export interface Staleness {
  stale: boolean;
  /** ISO ts of the newest observation, or null when there are no observations. */
  newest_observation_ts: string | null;
  slo_ms: number;
  /** now − newest_observation_ts in ms, or null when there are no observations. */
  age_ms: number | null;
}

export interface InboxView {
  items: InboxItem[];
  ranker_version: string;
  generated_at: string;
  staleness: Staleness;
}

/**
 * The I-04 ranker seam. When injected (default wiring: the deterministic-ranker adapter built at the
 * loop composition point, AIO-429), it supplies a per-item `why`, the per-item protected verdict, and
 * an overall `ranker_version`; when absent `assembleInboxView` uses the recency fallback. Kept as an
 * injected object so I-04 lands (and tests substitute a fake) without touching this file's shape.
 */
export interface Ranker {
  version: string;
  /**
   * Rank ALL items: return a deterministically-ordered copy, a `why` per item id, and the set of ids
   * the ranker considers protected. Must be a total, deterministic order. The caller re-enforces the
   * protected-partition split as a safety net, so protection is a UNION with each row's structural
   * `protected` (an open blocker is never demoted regardless of the ranker's verdict).
   */
  rank(items: readonly InboxItem[]): {
    order: InboxItem[];
    why: Map<string, string>;
    protectedIds: Set<string>;
  };
}

export interface AssembleInput {
  asks: readonly Ask[];
  /** Already-projected thread items (enriched ∪ legacy), e.g. from `projectObservations`. */
  threads: readonly ProjectedItem[];
  /** Pre-mapped host-health `agent-event` rows (I-15), merged + ranked with everything else. These
   *  are NOT thread observations, so they never affect the staleness computation. */
  healthRows?: readonly InboxItem[];
  now?: Date;
  sloMs?: number;
  ranker?: Ranker;
}

// ── mapping (source records → unified rows) ─────────────────────────────────────────────────────────

function askAttention(status: Ask["status"]): string {
  return status === "resolved"
    ? "resolved"
    : status === "orphaned" || status === "archived"
      ? "archived"
      : "surfaced";
}
function askBucket(ask: Ask): InboxBucket {
  if (ask.status !== "open") return "done";
  if (ask.severity === "blocker") return "needs-you";
  if (ask.severity === "decision") return "in-flight";
  return "fyi";
}

/** An ask → a unified row. The ask rides through VERBATIM (`ask`) so parity is airtight. */
export function askToItem(ask: Ask): InboxItem {
  return {
    id: ask.id,
    origin: "agent-event",
    source: ask.source,
    account: null,
    bucket: askBucket(ask),
    // Protected = an OPEN blocker: the one class ranking must never bury. Resolved blockers are done.
    protected: ask.severity === "blocker" && ask.status === "open",
    why: RECENCY_WHY,
    attention_state: askAttention(ask.status),
    action_state: "none",
    ts: ask.createdAt,
    ask,
  };
}

/** A projected thread → a unified row. */
export function threadToItem(item: ProjectedItem): InboxItem {
  return {
    id: item.key,
    origin: "thread-state",
    source: item.object_kind,
    account: item.account,
    bucket: item.deleted ? "done" : "thread",
    protected: false,
    why: RECENCY_WHY,
    attention_state: item.deleted ? "archived" : "surfaced",
    action_state: "none",
    ts: item.ts,
    observation: item,
  };
}

// ── ordering ─────────────────────────────────────────────────────────────────────────────────────

/** Recency (newest first), stable tiebreak on id — the deterministic ranker fallback. */
function byRecency(a: InboxItem, b: InboxItem): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/** Pure chronological (oldest first), stable tiebreak on id — the `--raw` escape hatch order. */
function byChronological(a: InboxItem, b: InboxItem): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Ranked order: the protected partition first (recency within it), then everything else (recency).
 * With an injected ranker the order, `why`, and protected verdict come from I-04 (unioned with each
 * row's structural protection); the partition split is re-enforced here either way, so protected
 * always renders above the fold.
 */
export function rankItems(items: readonly InboxItem[], ranker?: Ranker): InboxItem[] {
  if (ranker) {
    const { order, why, protectedIds } = ranker.rank(items);
    for (const it of order) {
      // UNION (trust floor): the ranker can promote a row into the partition, never demote a row
      // that is already structurally protected (an open blocker).
      it.protected = protectedIds.has(it.id) || it.protected;
      it.why = why.get(it.id) ?? it.why;
    }
    // Re-enforce the partition invariant regardless of the ranker's returned order: protected always
    // renders above the fold. Relative order within each partition is the ranker's.
    const protectedItems = order.filter((i) => i.protected);
    const rest = order.filter((i) => !i.protected);
    return [...protectedItems, ...rest];
  }
  const protectedItems = items.filter((i) => i.protected);
  const rest = items.filter((i) => !i.protected);
  return [...protectedItems].sort(byRecency).concat([...rest].sort(byRecency));
}

/** Pure timestamp order across ALL items — no partition, no ranking. */
export function rawOrder(items: readonly InboxItem[]): InboxItem[] {
  return [...items].sort(byChronological);
}

// ── assemble ─────────────────────────────────────────────────────────────────────────────────────

function computeStaleness(threads: readonly InboxItem[], now: Date, sloMs: number): Staleness {
  let newest: string | null = null;
  for (const it of threads) {
    if (it.ts && (newest === null || it.ts > newest)) newest = it.ts;
  }
  if (newest === null) {
    return { stale: false, newest_observation_ts: null, slo_ms: sloMs, age_ms: null };
  }
  const parsed = Date.parse(newest);
  const age = Number.isFinite(parsed) ? now.getTime() - parsed : null;
  return {
    stale: age !== null && age > sloMs,
    newest_observation_ts: newest,
    slo_ms: sloMs,
    age_ms: age,
  };
}

/**
 * Assemble the read-only view: map both sources to unified rows, rank (protected partition first),
 * and compute honest staleness from the newest observation. PURE — no I/O; the loop composition
 * point reads the stores and hands the records in.
 */
export function assembleInboxView(input: AssembleInput): InboxView {
  const now = input.now ?? new Date();
  const sloMs = input.sloMs ?? FRESHNESS_SLO_MS;
  // Explicitly archived asks stay in the durable ledger for audit/CLI inspection but disappear from
  // the actionable inbox. Resolved/orphaned rows retain the historical behavior of appearing in Done.
  const askItems = input.asks.filter((ask) => ask.status !== "archived").map(askToItem);
  const threadItems = input.threads.map(threadToItem);
  const healthItems = input.healthRows ?? [];
  const items = rankItems([...askItems, ...threadItems, ...healthItems], input.ranker);
  return {
    items,
    ranker_version: input.ranker?.version ?? INBOX_RANKER_VERSION_FALLBACK,
    generated_at: now.toISOString(),
    staleness: computeStaleness(threadItems, now, sloMs),
  };
}

/** Convenience: project enriched ∪ legacy observations, then assemble. Same-domain composition. */
export function assembleFromObservations(
  input: Omit<AssembleInput, "threads"> & {
    enriched?: Parameters<typeof projectObservations>[0]["enriched"];
    legacy?: readonly LegacyActivityRecord[];
  }
): InboxView {
  const threads = [
    ...projectObservations({ enriched: input.enriched, legacy: input.legacy }).values(),
  ];
  return assembleInboxView({ ...input, threads });
}

// ── rendering (pure string builders; the CLI adds the color fn) ───────────────────────────────────

export interface RenderColors {
  blue: (s: string) => string;
  dim: (s: string) => string;
  yellow: (s: string) => string;
}
const NO_COLOR: RenderColors = { blue: (s) => s, dim: (s) => s, yellow: (s) => s };

/** Compact "age" label from a ts relative to now — best-effort, never throws. */
function ageLabel(ts: string, now: Date): string {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return "?";
  const ms = Math.max(0, now.getTime() - t);
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function renderRow(it: InboxItem, now: Date, c: RenderColors): string {
  const mark = it.protected ? "●" : " ";
  const label = it.source ?? it.origin;
  return (
    `  ${mark} ${it.id}  ` +
    `${c.dim(`[${it.bucket}]`)} ${label}  ` +
    `${c.dim(ageLabel(it.ts, now))}  ${c.dim(it.why)}`
  );
}

function staleHeader(s: Staleness, now: Date, c: RenderColors): string | null {
  if (!s.stale || s.newest_observation_ts === null) return null;
  const age = ageLabel(s.newest_observation_ts, now);
  const slo = Math.round(s.slo_ms / 60000);
  return c.yellow(
    `  ⚠ read model is STALE — newest observation ${age} old (freshness SLO ${slo}m)`
  );
}

/**
 * Render the ranked view: staleness header (only when stale), the protected partition, the
 * separator, then the rest. `raw` swaps to the pure-chronological escape hatch (no partition).
 */
export function renderInboxText(
  view: InboxView,
  opts: { raw?: boolean; now?: Date; colors?: RenderColors } = {}
): string {
  const c = opts.colors ?? NO_COLOR;
  const now = opts.now ?? new Date();
  const lines: string[] = [];

  if (opts.raw) {
    const ordered = rawOrder(view.items);
    lines.push(c.blue("aios inbox --raw") + c.dim(`  ${ordered.length} item(s) · chronological`));
    const sh = staleHeader(view.staleness, now, c);
    if (sh) lines.push(sh);
    if (!ordered.length) lines.push(c.dim("  (empty)"));
    for (const it of ordered) lines.push(renderRow(it, now, c));
    return lines.join("\n");
  }

  const protectedItems = view.items.filter((i) => i.protected);
  const rest = view.items.filter((i) => !i.protected);
  lines.push(
    c.blue("aios inbox") + c.dim(`  ${view.items.length} item(s) · ${view.ranker_version}`)
  );
  const sh = staleHeader(view.staleness, now, c);
  if (sh) lines.push(sh);

  if (protectedItems.length) {
    lines.push(c.dim("  protected"));
    for (const it of protectedItems) lines.push(renderRow(it, now, c));
  }
  lines.push(c.dim(PARTITION_SEPARATOR));
  if (!rest.length) lines.push(c.dim("  (nothing below the line)"));
  for (const it of rest) lines.push(renderRow(it, now, c));
  return lines.join("\n");
}
