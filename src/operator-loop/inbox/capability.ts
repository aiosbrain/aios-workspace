// Unified Inbox — capability-handle broker (I-03 / AIO-384, G2b). COORDINATOR SIDE.
//
// The three-authority contract (I-01 §4) splits approval trust into: the Coordinator (brokers the
// human decision), the Owning runtime (holds the authoritative pending record and consumes it), and
// the Policy gateway. THIS module is the coordinator seam. It brokers — it never authorizes: it takes
// the OPAQUE handle + display projection the runtime issued, records the human's intent + the PDP
// decision into the inbox journal, and returns a `BrokeredDecision` envelope that carries ONLY the
// handle, the decision, and the digest the human saw. It never sees, holds, or mutates the request's
// operation/args/resources — those live only in the runtime's own record. The runtime re-validates
// its own record against this envelope's digest (see gui/server/runtime-adapters/capability-store.mjs)
// and atomically consumes; a mutated digest or a replayed handle is rejected THERE, not trusted here.
//
// Provisional module home per I-01 (`src/operator-loop/inbox/`); no cross-domain value imports.
// Admin-tier local state — never synced to the Team Brain.
//
// I-02 WIRING (AIO-427): the journal writer is injected as a content-free callback. Production wires
// it to the durable `inbox-events.ndjson` journal via `createDurableCapabilityJournal(root)` (the loop
// composition point in ../index.ts, which maps this seam's `{ kind, handle, at, data }` event onto the
// real `appendInboxEvent(root, { kind, correlation_id, payload, ts })`). Domains never value-import
// each other, so this module stays free of a hard journal dependency and the sink is injected. The
// in-memory helper below is retained ONLY as a test utility — production never defaults to it.

export type ApprovalDecision = "approve" | "deny";

/**
 * The safe-to-render projection the owning runtime hands the coordinator alongside the opaque handle.
 * Carries NO request payload — only a display summary and the canonical digest the human decision
 * binds to. The coordinator renders `summary`, captures the human's choice, and echoes `digest` back
 * unchanged; it cannot recompute or alter it.
 */
export interface DisplayProjection {
  handle: string;
  operation: string;
  summary: string;
  digest: string;
  expiresAt: string;
}

/**
 * The envelope the coordinator returns to the owning runtime. Deliberately minimal: the runtime
 * trusts none of these as request fields — it re-loads its authoritative record and only checks that
 * `digest` matches what it stored (tamper gate) and that `handle` is still pending (replay gate).
 */
export interface BrokeredDecision {
  handle: string;
  decision: ApprovalDecision;
  digest: string;
  brokeredAt: string;
}

// Journal event kinds this coordinator seam emits (a subset of the I-02 `INBOX_EVENT_KINDS`). Named
// `Capability*` to avoid colliding with journal.ts's canonical `InboxEvent` / `InboxEventKind` (both
// are re-exported from ../index.ts). The composition bridge validates these against the real I-02
// vocabulary before the durable append.
export type CapabilityEventKind =
  "user-intent" | "pdp-decision" | "capability-consumption" | "native-receipt" | "outcome";

/**
 * The lightweight, handle-keyed event the seam emits. The composition bridge maps it onto a real I-02
 * `AppendEventInput`: `handle → correlation_id`, `at → ts`, `data → payload`. `data` MUST stay
 * content-free (operation names, digests, decisions — never message bodies or args).
 */
export interface CapabilityEvent {
  kind: CapabilityEventKind;
  handle: string;
  at: string;
  data?: Record<string, unknown>;
}

/** The injected journal-append seam. Production supplies `createDurableCapabilityJournal(root)`. */
export type AppendCapabilityEvent = (event: CapabilityEvent) => void;

export interface BrokerOptions {
  /** Injected journal writer. Omit for a no-op (e.g. before the compiled loop is present). */
  appendInboxEvent?: AppendCapabilityEvent;
  now?: number;
}

/**
 * TEST UTILITY ONLY: an in-memory journal that records the seam's events. Handy for asserting the
 * emitted lifecycle without touching disk. Production must NOT default to this — it wires the durable
 * `createDurableCapabilityJournal(root)` sink instead.
 */
export function createInMemoryJournal(): {
  events: CapabilityEvent[];
  append: AppendCapabilityEvent;
} {
  const events: CapabilityEvent[] = [];
  return { events, append: (e) => void events.push(e) };
}

/**
 * Broker a human decision over an opaque handle. Records `user-intent` + `pdp-decision` into the
 * journal and returns the `BrokeredDecision` envelope. It NEVER mutates request fields (it has none):
 * the returned `digest` is the projection's digest, verbatim. The owning runtime is the sole authority
 * that validates + consumes; this function does not self-authorize.
 */
export function brokerDecision(
  projection: DisplayProjection,
  decision: ApprovalDecision,
  opts: BrokerOptions = {}
): BrokeredDecision {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  const append = opts.appendInboxEvent;
  // user-intent: the handle was surfaced to the human for a decision. `intent: "surface"` is the
  // read-model's legal `unseen → surfaced` attention edge; `operation`/`digest` are content-free
  // (tool name + canonical hash) — never the request payload.
  append?.({
    kind: "user-intent",
    handle: projection.handle,
    at,
    data: { intent: "surface", operation: projection.operation, digest: projection.digest },
  });
  // pdp-decision: the brokered verdict. `decision` is the read-model's action verdict; the digest
  // binds the decision to exactly what the human saw.
  append?.({
    kind: "pdp-decision",
    handle: projection.handle,
    at,
    data: { decision, digest: projection.digest },
  });
  return { handle: projection.handle, decision, digest: projection.digest, brokeredAt: at };
}

// ── Fallback lane: content-free notify + deep-link ────────────────────────────────────────────────

/** A content-free ask reference — carries NO operation payload, only correlation ids + a deep link. */
export interface DeepLinkAsk {
  handle: string;
  /** Deep link into the runtime's OWN safe prompt (the runtime always retains its local prompt). */
  deepLink: string;
}

export interface NotifyDeepLink {
  handle: string;
  deepLink: string;
  at: string;
  /** Marker so consumers know this is the fallback lane, not a brokered capability round-trip. */
  lane: "notify-deep-link";
}

export interface NotifyDeepLinkOptions {
  appendInboxEvent?: AppendCapabilityEvent;
  now?: number;
}

/**
 * KILL-path fallback: emit a CONTENT-FREE notification + deep-link to the runtime's own prompt. No
 * brokered decision, no request payload, no capability round-trip — the human approves inside the
 * runtime's native surface. Ships as the delivered feature if durable compare-and-consume proves
 * impossible for a runtime; here it rides alongside the primary design so a kill still leaves a
 * shippable lane (I-05's content-free notification is the outbound transport; sender.ts untouched).
 */
export function notifyDeepLink(ask: DeepLinkAsk, opts: NotifyDeepLinkOptions = {}): NotifyDeepLink {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  // Deliberately construct the payload from ONLY the handle + deep link — no operation/args/resources
  // ever cross this seam, so the notification is safe on any channel.
  const notification: NotifyDeepLink = {
    handle: ask.handle,
    deepLink: ask.deepLink,
    at,
    lane: "notify-deep-link",
  };
  // Journal the surface (content-free): the ask was surfaced to the human via the fallback lane.
  // `intent: "surface"` is the read-model's legal `unseen → surfaced` edge; no payload crosses.
  opts.appendInboxEvent?.({
    kind: "user-intent",
    handle: ask.handle,
    at,
    data: { intent: "surface", lane: "notify-deep-link" },
  });
  return notification;
}
