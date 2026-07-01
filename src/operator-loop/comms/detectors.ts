// Notification detectors (AIO-140) — the "detectors → typed events" half of the pattern.
// Pure functions over C1 signals that surface notify-worthy loop events for the sender.
//
// Detectors NEVER gate on tier — they carry each event's content tier straight through to
// `dispatchOnEvent`, which owns the outbound gate. That single-responsibility split is what
// keeps the tier invariant enforced in exactly one place.
//
// Covered (per the domain spec): decision-log Type 2/3, scope change, task assignment,
// stale inbox, deliverable status.

import type { Signal } from "../signal.js";
import type { NotificationEvent } from "./sender.js";

/** A carried-over/inbox item unread this many days reads as a stale-inbox event. */
export const DEFAULT_STALE_INBOX_DAYS = 7;

const SCOPE_RE = /\bscope\b/i;
// Decision "type" column values that warrant a notification: Type 2 (reversible-costly) and
// Type 3 (irreversible). Matches "2"/"3"/"type 2"/"type-3" etc., not "type 1".
const TYPE_23_RE = /(?:^|type[\s_-]*)[23]\b/i;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Coerce a decision-row `type` (the decisions source emits it as a NUMBER — `parseInt` of the
 *  "type" column — while hand-authored signals may use a string like "Type 3") to a string the
 *  TYPE_23_RE can match. Without this, a numeric Type 2/3 never triggers a notification. */
function typeText(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v) ?? "";
}

function base(
  sig: Signal,
  kind: string,
  extra: Partial<NotificationEvent> = {}
): NotificationEvent {
  return { kind, tier: sig.tier, summary: sig.summary, ref: sig.ref, ...extra };
}

/**
 * Derive notification events from a manifest's signals. `now` bounds the stale-inbox check.
 * Returns events in signal order; the caller decides which to dispatch (and the sender gates).
 */
export function detectEvents(
  signals: readonly Signal[],
  now: Date,
  staleInboxDays: number = DEFAULT_STALE_INBOX_DAYS
): NotificationEvent[] {
  const events: NotificationEvent[] = [];

  for (const sig of signals) {
    const p = sig.payload ?? {};

    if (sig.kind === "decision") {
      // Scope change takes precedence over a plain Type 2/3 classification.
      const scopeText = [sig.summary, str(p.rationale), str(p.impact)].filter(Boolean).join(" ");
      if (SCOPE_RE.test(scopeText)) {
        events.push(base(sig, "scope-change"));
      } else if (TYPE_23_RE.test(typeText(p.type))) {
        events.push(base(sig, "decision"));
      }
      continue;
    }

    if (sig.kind === "task") {
      const assignee = str(p.assignee);
      if (assignee) {
        events.push(base(sig, "task-assignment", { waitingOn: assignee, dueAt: str(p.due) }));
      }
      continue;
    }

    if (sig.kind === "deliverable") {
      const status = str(p.status);
      if (status) {
        events.push(base(sig, "deliverable-status", { waitingOn: str(p.owner) }));
      }
      continue;
    }

    if (sig.kind === "inbox") {
      if (staleDays(sig.occurredAt, now) > staleInboxDays) {
        events.push(base(sig, "stale-inbox"));
      }
      continue;
    }
    // Unknown kinds → no event (forward-compat: ignore kinds we don't recognize).
  }

  return events;
}

/** Whole days between a signal's occurredAt and now; -1 (never stale) if unparseable. */
function staleDays(occurredAt: string, now: Date): number {
  const t = Date.parse(occurredAt);
  if (!Number.isFinite(t)) return -1;
  return Math.floor((now.getTime() - t) / 86_400_000);
}
