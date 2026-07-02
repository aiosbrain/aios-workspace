// Asks inbox transport (AIO-167) — a DispatchDeps sink that turns an authorized loop event into a
// local ask, instead of an outbound Slack message. It plugs into the SAME `dispatchOnEvent` gate:
// the four gates (trigger / tier-spoof / admin-never-outbound / two-sided audience) all run first,
// so admin content is never written and only events cleared for the configured channel land here.
//
// `sendEvent` is the primary path (structured fields). `send` is the interface-required text
// fallback (unused in production because we always provide `sendEvent`), kept correct for safety.

import type { DispatchDeps, NotificationEvent } from "../comms/sender.js";
import type { Tier } from "../signal.js";
import { appendCreate, type AskSeverity } from "./store.js";

export interface InboxTransportOptions {
  /** Injectable clock (deterministic tests). */
  now?: Date;
  /** Stamped onto created asks for open-ask suppression on re-harvest. Default null. */
  dedupeKey?: string | null;
}

/** decision + task-assignment read as decisions worth a human call; everything else is fyi. */
function severityFor(event: NotificationEvent): AskSeverity {
  return event.kind === "decision" || event.kind === "task-assignment" ? "decision" : "fyi";
}

function refString(event: NotificationEvent): string {
  return event.ref.row ? `${event.ref.path}#${event.ref.row}` : event.ref.path;
}

/**
 * Build a `DispatchDeps` sink that appends authorized loop events to the local asks store. Pass it
 * to `dispatchOnEvent` — the gate decides authorization, this decides persistence.
 */
export function createInboxTransport(root: string, opts: InboxTransportOptions = {}): DispatchDeps {
  const dedupeKey = opts.dedupeKey ?? null;
  return {
    sendEvent: ({ event, messageTier }) =>
      appendCreate(root, {
        kind: event.kind,
        severity: severityFor(event),
        title: event.summary,
        body: "",
        ref: refString(event),
        source: `transport:${event.kind}`,
        dedupeKey,
        tier: messageTier as Tier,
        ...(opts.now ? { createdAt: opts.now.toISOString() } : {}),
      }),
    // Text fallback: only reached if `sendEvent` were absent. Passed the already-gated text.
    send: ({ text }) =>
      appendCreate(root, {
        kind: "notification",
        severity: "fyi",
        title: text,
        body: "",
        ref: null,
        source: "transport:send",
        dedupeKey,
        tier: "team",
        ...(opts.now ? { createdAt: opts.now.toISOString() } : {}),
      }),
  };
}
