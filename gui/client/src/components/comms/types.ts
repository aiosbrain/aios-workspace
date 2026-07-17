/**
 * Comms section types (I-14 / AIO-395) — a faithful mirror of the server contract:
 * `aios inbox --json` (I-09) for the queue, and I-03's display projection for the scoped-confirm.
 * Kept in one place so the queue, detail, ask card, and dialog all speak the same shape.
 */

export type InboxOrigin = "agent-event" | "thread-state";
export type InboxBucket = "needs-you" | "in-flight" | "fyi" | "thread" | "done";

/** The v1 ask, carried through verbatim on `agent-event` rows (dual-read parity). Open shape. */
export interface Ask {
  id: string;
  kind?: string;
  severity?: string;
  status?: string;
  title?: string;
  source?: string | null;
  tier?: string;
  createdAt?: string;
  resolvedAt?: string | null;
  dedupeKey?: string;
  [k: string]: unknown;
}

/** A projected comms/thread observation on a `thread-state` row. Open shape. */
export interface ProjectedItem {
  key: string;
  account: string | null;
  object_kind: string;
  native_id?: string;
  ts: string;
  snippet?: string;
  origin?: string;
  deleted?: boolean;
  participants?: { id: string; display?: string; role?: string }[];
  [k: string]: unknown;
}

export interface InboxItem {
  id: string;
  origin: InboxOrigin;
  source: string | null;
  account: string | null;
  bucket: InboxBucket;
  protected: boolean;
  why: string;
  attention_state: string;
  action_state: string;
  ts: string;
  ask?: Ask;
  observation?: ProjectedItem;
}

export interface InboxView {
  items: InboxItem[];
  ranker_version: string;
  generated_at: string;
  freshness: {
    status: "idle" | "refreshing" | "ready" | "degraded" | "failed" | "unavailable";
    last_attempt_at: string | null;
    last_success_at: string | null;
    error: string | null;
    sources: {
      gmail: string;
      calendar: string;
      telegram: "outbound_only";
    };
  } | null;
}

/** I-03 safe-to-render display projection (no request payload — only the digest the human binds to). */
export interface DisplayProjection {
  handle: string;
  operation: string;
  summary: string;
  digest: string;
  expiresAt: string;
}

export interface InboxDetail {
  item: InboxItem | null;
  agentContext: {
    subject: string;
    summary: string;
    turns: { role: "You" | "Claude"; text: string }[];
    canReply: boolean;
  } | null;
  pendingApprovals: DisplayProjection[];
  generated_at: string;
  freshness: InboxView["freshness"];
}

// ── ask-card display state vocabulary (I-13 Q3) ─────────────────────────────────────────────────────
//
// The full set the state sheet must enumerate — a projection of the orthogonal attention/action state
// machines onto the cards the operator reads. The three the design ruling names explicitly (STALE,
// action_pending, delivery_failed) are first-class here, alongside open/snoozed/resolved, receipted,
// outcome_unknown, and the reopened-thread-with-a-failed-action card.
export type AskCardState =
  | "open"
  | "snoozed"
  | "resolved"
  | "action_pending"
  | "receipted"
  | "delivery_failed"
  | "outcome_unknown"
  | "stale"
  | "reopened_failed";

/** Canonical order for the state sheet / enumeration test. Missing one = a failing test. */
export const ASK_CARD_STATES: readonly AskCardState[] = [
  "open",
  "snoozed",
  "resolved",
  "action_pending",
  "receipted",
  "delivery_failed",
  "outcome_unknown",
  "stale",
  "reopened_failed",
];

/** The distinct, human-readable label rendered on each card (the enumeration test asserts each shows). */
export const ASK_CARD_STATE_LABELS: Record<AskCardState, string> = {
  open: "OPEN",
  snoozed: "SNOOZED",
  resolved: "RESOLVED",
  action_pending: "ACTION PENDING",
  receipted: "RECEIPTED",
  delivery_failed: "DELIVERY FAILED",
  outcome_unknown: "OUTCOME UNKNOWN",
  stale: "STALE",
  reopened_failed: "REOPENED · FAILED",
};

/**
 * Derive the display state for a live row from its orthogonal state columns.
 * Best-effort and total (always returns a state). The enumeration test drives `AskCard` with explicit
 * states, so this derivation is only the live UI's convenience mapper.
 *
 * A row's card state reflects the ITEM's own action/attention columns. Ingestion freshness is a queue
 * concern and is deliberately not folded in here. The "stale" card state is reserved for an item whose
 * own approval window elapsed (`action_state === "expired"`).
 */
export function deriveAskState(item: InboxItem): AskCardState {
  const attention = item.attention_state;
  const action = item.action_state;
  if (action === "failed") return attention === "surfaced" ? "reopened_failed" : "delivery_failed";
  if (action === "outcome_unknown") return "outcome_unknown";
  if (action === "expired") return "stale";
  if (action === "succeeded") return "receipted";
  if (
    action === "proposed" ||
    action === "awaiting_approval" ||
    action === "approved" ||
    action === "executing"
  ) {
    return "action_pending";
  }
  if (attention === "snoozed") return "snoozed";
  if (attention === "resolved" || attention === "archived") return "resolved";
  return "open";
}
