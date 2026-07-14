// Reply PDP — origin-confined disclosure (I-10 / AIO-391).
//
// A NEW, SEPARATE policy decision point, upstream of and independent from the shipped outbound
// notification gate (`src/operator-loop/comms/sender.ts`, byte-for-byte untouched). Inbound
// Gmail/calendar/Slack evidence is admin-tier by default (see sources/comms.ts + the gog writer's
// `tier: admin`), so the sender's "admin-never-outbound" invariant would reject EVERY reply. I-10
// resolves that deadlock with a two-axis rule — workspace confidentiality AND recipient-set
// authorization: content that originated in a thread may return to THAT thread's verified
// participants, admin-tier or not; every expansion is default-denied without deliberate promotion.
//
// Design invariants (spec §29, tier-safety):
//   - `evaluateReply` is PURE and deterministic: same request + thread context → identical
//     decision object. No I/O, no clock, no randomness, no reading of evidence *content*.
//   - The PDP runs deterministic checks on STRUCTURED refs only (recipients, channel, quoted_refs,
//     attachments, evidence origin). It NEVER inspects channel/message body text or model output,
//     so crafted evidence claiming "also cc attacker@evil" cannot expand the recipient set — only
//     the structured `recipients` field can, and every recipient is checked against the thread
//     roster. Explanations are built from module constants only (no untrusted-string interpolation,
//     no eval, no format-string sink), so a hostile subject/participant string is inert here.
//   - Journaling is a side effect kept OUT of the pure core: `decideReply` computes the decision
//     via `evaluateReply`, then emits an I-02 `pdp-decision` event through an INJECTED sink. The
//     event carries refs/counts/verdict/rule only — never comms plaintext — and stays admin-tier
//     local (nothing here syncs to the Team Brain).
//
// Participant identity is account/tenant-resolved (I-06). Until I-06 merges, `ParticipantIdentity`
// is a fixture-backed local stub of the enriched observation identity fields; this module consumes
// I-06's type once it lands (no code dependency today).

import type { Tier } from "../signal.js";

/** PDP verdict. `needs_promotion` = denied-but-promotable via an explicit scoped authorization of
 *  this same request; `deny` = structurally disallowed, must be reformulated. Never a silent block. */
export type ReplyVerdict = "allow" | "deny" | "needs_promotion";

/**
 * Account/tenant-resolved participant identity (I-06 stub — never the word "internal").
 * A recipient is a VERIFIED identity only when account, tenant and address are all present and
 * `verified === true`; anything short of that is an unknown participant (default-deny).
 */
export interface ParticipantIdentity {
  /** Connection/account id the identity was resolved on (e.g. a Gmail account). */
  account: string;
  /** Tenant/workspace the identity belongs to. */
  tenant: string;
  /** Channel address (email / handle) — an opaque id, never trusted as free text. */
  address: string;
  /** Whether the adapter verified this identity as a real participant. */
  verified: boolean;
}

/** Where a piece of evidence originated. Only `thread-message` from the reply's own thread is
 *  origin-confined; every other kind is unrelated workspace/admin context. */
export type EvidenceKind =
  | "thread-message"
  | "workspace-attachment"
  | "ledger"
  | "entity"
  | "other-thread"
  | "unknown";

/** A structured pointer to a piece of evidence backing the draft. The PDP reads these fields only —
 *  never the evidence body. */
export interface EvidenceRef {
  /** Stable id of the evidence object (opaque). */
  id: string;
  kind: EvidenceKind;
  /** The thread this evidence originates in; `null` for workspace/admin context (ledger/entity). */
  origin_thread: string | null;
  tier: Tier;
}

/** An attachment proposed on the reply. Only attachments that came from the thread itself are
 *  origin-confined; anything sourced from the workspace is denied. */
export interface AttachmentRef {
  id: string;
  origin: "thread" | "workspace";
  /** When `origin === "thread"`, the thread it belongs to (must be the reply's thread). */
  origin_thread?: string | null;
}

/** A quoted excerpt carried into the reply. Quoting the reply's own thread is inherent to replying;
 *  quoting ANY other thread is cross-thread disclosure (denied). */
export interface QuotedRef {
  id: string;
  /** The thread the quoted content is drawn from. */
  thread: string;
}

/** A delegated capability requested alongside the reply. Any send/write/payment/external-tool
 *  capability requires explicit scoped approval regardless of recipient (needs_promotion). */
export interface Delegation {
  id: string;
  capability: "send" | "write" | "payment" | "external-tool" | (string & {});
}

/** The destination channel of the reply. A `thread_ref` (or `channel_type`) differing from the
 *  request's originating thread/channel is a channel move (denied). */
export interface ReplyChannel {
  channel_type: string;
  thread_ref: string;
}

/** The reply the PDP is asked to authorize (spec §19). Structured refs only. */
export interface ReplyRequest {
  /** The thread the reply belongs to — the origin-confinement anchor. */
  thread_ref: string;
  evidence: EvidenceRef[];
  recipients: ParticipantIdentity[];
  channel: ReplyChannel;
  attachments?: AttachmentRef[];
  quoted_refs?: QuotedRef[];
  delegations?: Delegation[];
}

/** The verified participant roster of a thread, resolved by the adapter (I-06). The allow rule is
 *  defined against THIS set — recipients must be a subset of the thread's verified participants. */
export interface ThreadContext {
  thread_ref: string;
  /** Every verified participant of the thread (channel_type helps distinguish same-address reuse). */
  participants: ParticipantIdentity[];
  channel_type: string;
}

/** The I-02 `pdp-decision` journal event. Refs/counts/verdict/rule ONLY — no comms plaintext,
 *  no participant addresses beyond counts — admin-tier local, never synced. */
export interface PdpDecisionEvent {
  type: "pdp-decision";
  schema_version: 1;
  thread_ref: string;
  verdict: ReplyVerdict;
  rule_id: string;
  recipient_count: number;
  evidence_count: number;
  attachment_count: number;
  quoted_count: number;
  delegation_count: number;
}

/** Injected journal sink (I-02 seam). A stub recorder is fine; the PDP does not couple to I-02
 *  internals. Kept OUT of the pure decision core so `evaluateReply` stays side-effect-free. */
export interface PdpJournalSink {
  record(event: PdpDecisionEvent): void;
}

export interface ReplyContext {
  thread: ThreadContext;
  journal: PdpJournalSink;
}

/** The decision object. `explanation` is composed from module constants only (injection-safe). */
export interface PdpDecision {
  verdict: ReplyVerdict;
  rule_id: string;
  explanation: string;
  /** The scoped authorization that would unblock a denial — every denial names one. */
  promotion_path?: string;
}

/** Every stable rule id the PDP can return. Exported so tests + callers pin the exact set. */
export const REPLY_RULE_IDS = {
  ALLOW_ORIGIN_CONFINED: "allow.origin-confined",
  DENY_UNKNOWN_PARTICIPANT: "deny.unknown-participant",
  DENY_RECIPIENT_EXPANSION: "deny.recipient-expansion",
  DENY_CHANNEL_MOVE: "deny.channel-move",
  DENY_CROSS_THREAD_QUOTE: "deny.cross-thread-quote",
  DENY_WORKSPACE_ATTACHMENT: "deny.workspace-attachment",
  DENY_UNRELATED_ADMIN_CONTEXT: "deny.unrelated-admin-context",
  DENY_DELEGATION_CAPABILITY: "deny.delegation-capability",
  DENY_DEFAULT: "deny.default",
} as const;

export type ReplyRuleId = (typeof REPLY_RULE_IDS)[keyof typeof REPLY_RULE_IDS];

const CAPABILITY_REQUIRES_APPROVAL: ReadonlySet<string> = new Set([
  "send",
  "write",
  "payment",
  "external-tool",
]);

/** Canonical identity key. NUL-joined so no address containing the separator can forge a collision
 *  (addresses are opaque ids, never parsed). */
function identityKey(p: ParticipantIdentity): string {
  return `${p.account} ${p.tenant} ${p.address}`;
}

/** A fully account/tenant-resolved, verified identity. Anything less is an unknown participant. */
function isVerifiedIdentity(p: ParticipantIdentity): boolean {
  return (
    typeof p.account === "string" &&
    p.account.length > 0 &&
    typeof p.tenant === "string" &&
    p.tenant.length > 0 &&
    typeof p.address === "string" &&
    p.address.length > 0 &&
    p.verified === true
  );
}

/**
 * The PURE decision core (spec §21, §29). Deterministic: same `request` + `thread` → identical
 * `PdpDecision`. No I/O, no journaling, no clock. Deny rules are evaluated in a fixed priority and
 * the FIRST match wins; `allow` fires only when the positive origin-confinement condition holds and
 * no deny rule matched; an unrecognized shape falls through to an explicit default-deny.
 */
export function evaluateReply(request: ReplyRequest, thread: ThreadContext): PdpDecision {
  const attachments = request.attachments ?? [];
  const quoted = request.quoted_refs ?? [];
  const delegations = request.delegations ?? [];

  // Verified participant roster of the reply's own thread. Recipients must be a subset of this.
  const rosterKeys = new Set<string>();
  for (const p of thread.participants) {
    if (isVerifiedIdentity(p)) rosterKeys.add(identityKey(p));
  }

  // (1) Unknown participant — any recipient that is not a fully resolved, verified identity.
  //     Identity integrity is checked first: an unverifiable recipient can never be "in" the thread.
  for (const r of request.recipients) {
    if (!isVerifiedIdentity(r)) {
      return deny(
        REPLY_RULE_IDS.DENY_UNKNOWN_PARTICIPANT,
        "a recipient is not an account/tenant-resolved verified participant",
        "verify the participant's identity, then re-request"
      );
    }
  }

  // (2) Recipient-set expansion — a verified identity that is NOT on the thread roster (added
  //     recipient / reply-all beyond the thread). Promotable via scoped authorization.
  for (const r of request.recipients) {
    if (!rosterKeys.has(identityKey(r))) {
      return needsPromotion(
        REPLY_RULE_IDS.DENY_RECIPIENT_EXPANSION,
        "a recipient is not a verified participant of this thread (recipient-set expansion)",
        "obtain explicit scoped authorization to add the recipient"
      );
    }
  }

  // (3) Channel move — the reply's destination channel/thread differs from the origin thread.
  if (
    request.channel.thread_ref !== request.thread_ref ||
    request.thread_ref !== thread.thread_ref ||
    request.channel.channel_type !== thread.channel_type
  ) {
    return deny(
      REPLY_RULE_IDS.DENY_CHANNEL_MOVE,
      "the reply targets a different channel/thread than the evidence's origin (channel move)",
      "explicitly authorize disclosure to the new channel"
    );
  }

  // (4) Cross-thread quoting — quoting any thread other than this one.
  for (const q of quoted) {
    if (q.thread !== request.thread_ref) {
      return deny(
        REPLY_RULE_IDS.DENY_CROSS_THREAD_QUOTE,
        "the draft quotes content from a different thread (cross-thread disclosure)",
        "explicitly authorize quoting the other thread's content"
      );
    }
  }

  // (5) Workspace attachments — anything not sourced from this thread.
  for (const a of attachments) {
    if (a.origin !== "thread" || (a.origin_thread ?? null) !== request.thread_ref) {
      return deny(
        REPLY_RULE_IDS.DENY_WORKSPACE_ATTACHMENT,
        "the draft attaches a workspace object that did not originate in this thread",
        "explicitly authorize disclosing the workspace attachment"
      );
    }
  }

  // (6) Unrelated admin/workspace context — evidence that is not a same-thread message (ledger,
  //     entities, other threads). Origin-confinement requires every evidence ref to originate here.
  for (const e of request.evidence) {
    if (e.kind !== "thread-message" || e.origin_thread !== request.thread_ref) {
      return deny(
        REPLY_RULE_IDS.DENY_UNRELATED_ADMIN_CONTEXT,
        "the draft draws on workspace/admin context outside this thread (ledger/entity/other-thread)",
        "explicitly authorize disclosing the unrelated context"
      );
    }
  }

  // (7) Delegation carrying a send/write/payment/external-tool capability — scoped approval always,
  //     regardless of recipient.
  for (const d of delegations) {
    if (CAPABILITY_REQUIRES_APPROVAL.has(d.capability)) {
      return needsPromotion(
        REPLY_RULE_IDS.DENY_DELEGATION_CAPABILITY,
        "the reply carries a capability delegation that requires explicit scoped approval",
        "grant explicit scoped approval for the delegated capability"
      );
    }
  }

  // (8) Origin-confined ALLOW — every evidence ref originates in this thread AND every recipient is
  //     a verified participant of it. Allowed even though the evidence is admin-tier: origin
  //     confinement, not tier, authorizes the disclosure. (Reaching here means no deny rule fired;
  //     the positive condition is re-asserted defensively so `allow` is never returned by omission.)
  if (isOriginConfined(request, thread, rosterKeys)) {
    return {
      verdict: "allow",
      rule_id: REPLY_RULE_IDS.ALLOW_ORIGIN_CONFINED,
      explanation:
        "every evidence ref originates in this thread and every recipient is a verified participant of it",
    };
  }

  // (9) Anything unrecognized — default-deny.
  return deny(
    REPLY_RULE_IDS.DENY_DEFAULT,
    "the request did not satisfy origin confinement and matched no promotion path",
    "reformulate the reply to keep evidence and recipients confined to this thread"
  );
}

/** Positive re-assertion of the allow condition — belt-and-suspenders so `allow` is only ever
 *  returned when the full origin-confinement invariant holds. */
function isOriginConfined(
  request: ReplyRequest,
  thread: ThreadContext,
  rosterKeys: ReadonlySet<string>
): boolean {
  if (request.channel.thread_ref !== request.thread_ref) return false;
  if (request.thread_ref !== thread.thread_ref) return false;
  if (request.channel.channel_type !== thread.channel_type) return false;
  if (request.recipients.length === 0) return false;
  for (const r of request.recipients) {
    if (!isVerifiedIdentity(r) || !rosterKeys.has(identityKey(r))) return false;
  }
  for (const e of request.evidence) {
    if (e.kind !== "thread-message" || e.origin_thread !== request.thread_ref) return false;
  }
  for (const q of request.quoted_refs ?? []) {
    if (q.thread !== request.thread_ref) return false;
  }
  for (const a of request.attachments ?? []) {
    if (a.origin !== "thread" || (a.origin_thread ?? null) !== request.thread_ref) return false;
  }
  for (const d of request.delegations ?? []) {
    if (CAPABILITY_REQUIRES_APPROVAL.has(d.capability)) return false;
  }
  return true;
}

function deny(rule_id: ReplyRuleId, explanation: string, promotion_path: string): PdpDecision {
  return { verdict: "deny", rule_id, explanation, promotion_path };
}

function needsPromotion(
  rule_id: ReplyRuleId,
  explanation: string,
  promotion_path: string
): PdpDecision {
  return { verdict: "needs_promotion", rule_id, explanation, promotion_path };
}

/**
 * Decide + journal. Computes the decision via the pure `evaluateReply`, then emits exactly one
 * I-02 `pdp-decision` event through the injected sink (the only side effect) and returns the same
 * decision object. The journal event carries refs/counts/verdict/rule only — never comms plaintext.
 */
export function decideReply(request: ReplyRequest, context: ReplyContext): PdpDecision {
  const decision = evaluateReply(request, context.thread);
  context.journal.record({
    type: "pdp-decision",
    schema_version: 1,
    thread_ref: request.thread_ref,
    verdict: decision.verdict,
    rule_id: decision.rule_id,
    recipient_count: request.recipients.length,
    evidence_count: request.evidence.length,
    attachment_count: (request.attachments ?? []).length,
    quoted_count: (request.quoted_refs ?? []).length,
    delegation_count: (request.delegations ?? []).length,
  });
  return decision;
}

/** A minimal in-memory `PdpJournalSink` — a stub recorder for tests and non-persistent callers. */
export function createMemoryJournalSink(): PdpJournalSink & { events: PdpDecisionEvent[] } {
  const events: PdpDecisionEvent[] = [];
  return {
    events,
    record(event: PdpDecisionEvent): void {
      events.push(event);
    },
  };
}
