// Unified inbox — the `aios inbox --overdue` recovery view (I-05 / AIO-386, the G3b safety net).
//
// This is the safety story told alongside the Telegram interrupt lane (notify-telegram.ts): the
// phone lane can silently fail (Telegram disabled, token revoked, API accepted but never seen, the
// coordinator restarted, the phone offline) — in EVERY one of those cases the ask stays durably
// queued in the asks store, and the overdue view surfaces it. It replaces the retracted "digest as
// redundancy" claim (the digest never carried agent asks). The claim it makes is narrow and
// verifiable: no interrupt failure loses an ask.
//
// The view is a PURE projection over two durable inputs:
//   • the asks store (the durable ask queue — an ask is "queued" while its status is `open`), and
//   • the inbox journal's notify-lane events (`delivery-attempted` / `human-ack`, keyed by
//     `correlation_id === ask_id`) — the honest ack read model.
// An ask is OVERDUE when it is open, has NOT been acknowledged, and its reference time (its most
// recent delivery attempt, or its creation time if it was never delivered) is older than the
// escalation window. Because a never-delivered open ask falls back to its creation time, a fully
// silent lane (Telegram disabled / token revoked — no `delivery-attempted` written) STILL surfaces
// the ask: the recovery view fails safe.
//
// Domain isolation (Constitution §4): the `Ask` shape is a TYPE-ONLY cross-domain reference (the
// legitimate typed seam); the asks store is read by the loop composition point and handed in. Journal
// events are read there too and passed in — this module is pure (no I/O), so it is trivially testable
// and deterministic (injected `now`).

import type { Ask } from "../asks/store.js";
import type { InboxEvent } from "./journal.js";

/** Default escalation window: an interrupt unacknowledged for this long escalates into recovery. */
export const DEFAULT_ESCALATION_WINDOW_MS = 15 * 60 * 1000; // 15 min

// ── notify-lane read model (the ack projection) ─────────────────────────────────────────────────────

/** Per-ask notification state folded from the journal's notify-lane events. Makes the two events
 *  distinguishable: a `delivery-attempted` bumps `delivery_attempts`; a `human-ack` flips `acked`. */
export interface NotificationState {
  ask_id: string;
  delivery_attempts: number;
  /** ISO ts of the most recent `delivery-attempted`, or null if never delivered. */
  last_delivery_at: string | null;
  /** True iff a `human-ack` event exists AT OR AFTER the last delivery attempt (an honest ack). */
  acked: boolean;
  /** ISO ts of the most recent `human-ack`, or null. */
  last_ack_at: string | null;
}

function tsOf(ev: InboxEvent): string {
  // Prefer the event's own `ts`; fall back to a payload `at` (both are ISO). Empty string sorts first.
  const payloadAt = typeof ev.payload.at === "string" ? ev.payload.at : "";
  return ev.ts || payloadAt;
}

/**
 * Fold the journal's notify-lane events into per-ask notification state. Events are read in `seq`
 * order by the journal reader; `acked` is true when the latest `human-ack` is at or after the latest
 * `delivery-attempted` (or there was no delivery but a human still acked). Non-notify kinds are
 * ignored — this projection is scoped to the notify lane.
 */
export function foldNotificationState(
  events: readonly InboxEvent[]
): Map<string, NotificationState> {
  const byAsk = new Map<string, NotificationState>();
  const get = (askId: string): NotificationState => {
    let s = byAsk.get(askId);
    if (!s) {
      s = {
        ask_id: askId,
        delivery_attempts: 0,
        last_delivery_at: null,
        acked: false,
        last_ack_at: null,
      };
      byAsk.set(askId, s);
    }
    return s;
  };
  for (const ev of events) {
    if (ev.kind === "delivery-attempted") {
      const s = get(ev.correlation_id);
      s.delivery_attempts += 1;
      const at = tsOf(ev);
      if (s.last_delivery_at === null || at > s.last_delivery_at) s.last_delivery_at = at;
    } else if (ev.kind === "human-ack") {
      const s = get(ev.correlation_id);
      const at = tsOf(ev);
      if (s.last_ack_at === null || at > s.last_ack_at) s.last_ack_at = at;
    }
  }
  // Derive `acked` once both streams are folded: an ack counts only if it is at or after the most
  // recent delivery attempt (a re-notify after an ack re-arms the escalation — honest freshness).
  for (const s of byAsk.values()) {
    if (s.last_ack_at === null) s.acked = false;
    else if (s.last_delivery_at === null) s.acked = true;
    else s.acked = s.last_ack_at >= s.last_delivery_at;
  }
  return byAsk;
}

// ── overdue view ─────────────────────────────────────────────────────────────────────────────────

/** One row of the recovery view. Rendered locally on the Mac (admin-tier) — NOT a phone payload, so
 *  it may carry the ask's own title for orientation. It never leaves the machine. */
export interface OverdueItem {
  ask_id: string;
  title: string;
  severity: Ask["severity"];
  source: string;
  created_at: string;
  /** How many times the interrupt lane attempted delivery (0 if the lane was silent/disabled). */
  delivery_attempts: number;
  /** ISO ts of the most recent delivery attempt, or null if never delivered. */
  last_delivery_at: string | null;
  /** How long (ms) past the escalation window this ask has gone unacknowledged. Always ≥ 0. */
  overdue_by_ms: number;
  /** Content-free deep link back to the ask (same contract as the phone lane). */
  deep_link: string;
}

export interface OverdueInput {
  asks: readonly Ask[];
  events: readonly InboxEvent[];
  now?: Date;
  escalationWindowMs?: number;
  /** Deep-link builder (injected so recovery stays free of the notify-telegram value import). */
  deepLinkForAsk?: (askId: string) => string;
}

/**
 * Compute the overdue recovery view: the OPEN, un-acknowledged asks whose reference time (last
 * delivery attempt, else creation time) is older than the escalation window. Deterministic given
 * `now`; ordered oldest-reference first (the most-overdue at the top), stable on ask id.
 *
 * Fail-safe: an open ask with NO delivery event (a silent/disabled lane) is included once it ages
 * past the window on its creation time — so "no interrupt failure loses an ask" holds by construction.
 */
export function overdueView(input: OverdueInput): OverdueItem[] {
  const now = (input.now ?? new Date()).getTime();
  const windowMs = input.escalationWindowMs ?? DEFAULT_ESCALATION_WINDOW_MS;
  const deepLink = input.deepLinkForAsk ?? ((id: string) => `aios://inbox/ask/${id}`);
  const notify = foldNotificationState(input.events);

  const rows: OverdueItem[] = [];
  for (const ask of input.asks) {
    if (ask.status !== "open") continue; // only durably-queued asks can be overdue
    const state = notify.get(ask.id);
    if (state?.acked) continue; // an honest human-ack clears the escalation

    const createdMs = Date.parse(ask.createdAt);
    const deliveryMs = state?.last_delivery_at ? Date.parse(state.last_delivery_at) : NaN;
    // Reference = most recent delivery attempt if we have one, else the ask's creation time.
    // An unparseable timestamp is treated as OLDEST (epoch → immediately overdue): falling back to
    // "now" would reset on every evaluation and hide the ask forever, breaking the fail-safe.
    const refMs = Number.isFinite(deliveryMs)
      ? (deliveryMs as number)
      : Number.isFinite(createdMs)
        ? createdMs
        : 0;
    const age = now - refMs;
    if (age <= windowMs) continue;

    rows.push({
      ask_id: ask.id,
      title: ask.title,
      severity: ask.severity,
      source: ask.source,
      created_at: ask.createdAt,
      delivery_attempts: state?.delivery_attempts ?? 0,
      last_delivery_at: state?.last_delivery_at ?? null,
      overdue_by_ms: age - windowMs,
      deep_link: deepLink(ask.id),
    });
  }

  rows.sort((a, b) => {
    // Most overdue first (largest overdue_by_ms), stable tiebreak on ask id for a total order.
    if (a.overdue_by_ms !== b.overdue_by_ms) return b.overdue_by_ms - a.overdue_by_ms;
    return a.ask_id < b.ask_id ? -1 : a.ask_id > b.ask_id ? 1 : 0;
  });
  return rows;
}

export interface OverdueView {
  items: OverdueItem[];
  generated_at: string;
  escalation_window_ms: number;
}

/** Wrap the rows in a stable machine surface `{ items, generated_at, escalation_window_ms }`. */
export function buildOverdueView(input: OverdueInput): OverdueView {
  const now = input.now ?? new Date();
  return {
    items: overdueView({ ...input, now }),
    generated_at: now.toISOString(),
    escalation_window_ms: input.escalationWindowMs ?? DEFAULT_ESCALATION_WINDOW_MS,
  };
}

// ── rendering (pure string builders; the CLI injects the color fn) ─────────────────────────────────

export interface OverdueRenderColors {
  blue: (s: string) => string;
  dim: (s: string) => string;
  yellow: (s: string) => string;
}
const NO_COLOR: OverdueRenderColors = { blue: (s) => s, dim: (s) => s, yellow: (s) => s };

function ageLabel(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Render the recovery view: a header, then EXACTLY one line per overdue ask (ask id, severity,
 * source, how-overdue, delivery-attempt count). An empty view renders the header + an "(none)" line.
 */
export function renderOverdueText(
  view: OverdueView,
  opts: { colors?: OverdueRenderColors } = {}
): string {
  const c = opts.colors ?? NO_COLOR;
  const win = Math.round(view.escalation_window_ms / 60000);
  const lines: string[] = [
    c.blue("aios inbox --overdue") +
      c.dim(`  ${view.items.length} overdue · escalation window ${win}m`),
  ];
  if (!view.items.length) {
    lines.push(c.dim("  (none — no unacknowledged asks past the escalation window)"));
    return lines.join("\n");
  }
  for (const it of view.items) {
    const attempts =
      it.delivery_attempts > 0
        ? `${it.delivery_attempts} attempt${it.delivery_attempts === 1 ? "" : "s"}`
        : c.yellow("never delivered");
    lines.push(
      `  ${c.yellow("⚠")} ${it.ask_id}  ${c.dim(`[${it.severity}]`)} ${it.source}  ` +
        `${c.dim(`overdue ${ageLabel(it.overdue_by_ms)}`)}  ${c.dim(attempts)}`
    );
  }
  return lines.join("\n");
}
