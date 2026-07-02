// Unified notification sender (AIO-140) — the outbound half of the comms layer. Takes a typed
// loop event, gates it, and (only if authorized) emits a tier-safe message to a channel.
//
// The gate is TWO-SIDED and runs entirely BEFORE any format/send:
//   1. Resolve the destination channel explicitly (sender.channel ?? slack.defaultChannel).
//   2. Resolve the destination's audience Tier via the canonical channel-tier map.
//   3. Reject an unresolvable destination (default-deny) — never guess a broad audience.
//   4. Send only when the destination audience is authorized to SEE the message's tier.
// Plus a belt-and-suspenders guard: an admin-tier message is NEVER emitted outward, regardless
// of channel config (the verifier-enforced invariant — zero admin content reaches any channel).
//
// The Slack transport is injected (`SendFn`) so the sender is swappable and testable; this
// module owns the policy, not the wire.

import { visibleTiers } from "../ledger.js";
import { audienceForTier } from "../writeback.js";
import type { EvidenceRef, Tier } from "../signal.js";
import { resolveChannelTier, type CommsConfig } from "./config.js";

/** A notify-worthy loop event (produced by the detectors). Carries its triggering evidence. */
export interface NotificationEvent {
  /** e.g. "decision" | "task-assignment" | "deliverable-status" | "scope-change" | "stale-inbox". */
  kind: string;
  /** The event NAME matched against the sender's trigger gate (`sender.on`). Defaults to `kind`
   *  when unset — detectors set `kind`, so the gate matches on the detector event kind. */
  name?: string;
  /** The self-reported tier of the CONTENT being surfaced. NOT trusted directly: the gate derives
   *  the authorizing tier from the triggering evidence (`ref.tier`) and REQUIRES the two agree —
   *  a caller cannot pass admin evidence under a `team` label to slip past the admin guard. */
  tier: Tier;
  summary: string;
  /** Pointer back to the source that triggered this event (referenced in the message). The
   *  trusted tier anchor: `ref.tier` is what the outbound gate authorizes against. */
  ref: EvidenceRef;
  waitingOn?: string;
  dueAt?: string;
}

/** Injected transport. Returns whatever receipt the wire produces (opaque to the sender). */
export type SendFn = (msg: { channel: string; text: string }) => Promise<unknown> | unknown;

/** A richer, additive transport hook: receives the full event + resolved gate context (not just
 *  the formatted text), so a sink can persist structured fields (severity, ref, tier) rather than
 *  parse them back out of a string. Used by the asks inbox transport (AIO-167). Optional — when
 *  absent the sender falls back to `send`, so every existing caller is unaffected. */
export type SendEventFn = (args: {
  event: NotificationEvent;
  channel: string;
  messageTier: Tier;
  channelTier: Tier;
  text: string;
}) => Promise<unknown> | unknown;

export interface DispatchDeps {
  send: SendFn;
  sendEvent?: SendEventFn;
}

export type RejectReason =
  | "tier-spoof"
  | "no-destination-channel"
  | "admin-never-outbound"
  | "unresolvable-destination-tier"
  | "audience-not-authorized";

export type NoopReason = "not-triggered";

export interface DispatchResult {
  status: "sent" | "rejected" | "noop";
  reason?: RejectReason | NoopReason;
  detail?: string;
  channel?: string;
  messageTier?: Tier;
  channelTier?: Tier;
  /** The formatted message, present only when status === "sent". */
  text?: string;
  receipt?: unknown;
}

/** Whether a channel whose audience is `channelTier` may receive a `messageTier` message.
 *  Canonical rule: the channel's audience must be cleared to SEE that tier (visibleTiers). */
export function canChannelReceive(channelTier: Tier, messageTier: Tier): boolean {
  return visibleTiers(audienceForTier(channelTier)).has(messageTier);
}

/** Human-readable one-liner: the event summary + its triggering evidence ref. */
export function formatEvent(event: NotificationEvent): string {
  const ref = event.ref.row ? `${event.ref.path}#${event.ref.row}` : event.ref.path;
  const waiting = event.waitingOn ? ` — waiting on ${event.waitingOn}` : "";
  const due = event.dueAt ? ` (due ${event.dueAt})` : "";
  return `[${event.kind}] ${event.summary}${waiting}${due}\n↳ evidence: ${ref}`;
}

/**
 * Gate + dispatch a single loop event. The full two-sided gate runs before any formatting or
 * send; a rejection returns the reason and never touches the transport.
 */
export async function dispatchOnEvent(
  event: NotificationEvent,
  config: CommsConfig,
  deps: DispatchDeps
): Promise<DispatchResult> {
  // 0) Trigger gate (FIRST, before any tier/channel resolution): when `sender.on` is configured,
  // only the listed event name(s) dispatch; anything else is a silent no-op (never sent).
  const eventName = event.name ?? event.kind;
  if (config.sender.on && !config.sender.on.includes(eventName)) {
    return {
      status: "noop",
      reason: "not-triggered",
      detail: `event "${eventName}" is not in sender.on — not dispatched`,
    };
  }

  // Derive the authorizing tier from the TRUSTED evidence ref, not the caller-supplied
  // `event.tier`. A caller cannot pass admin-derived evidence while labelling the event `team`:
  // the self-reported tier MUST equal the evidence tier or the event is rejected (default-deny).
  const messageTier = event.ref.tier;
  if (event.tier !== messageTier) {
    return {
      status: "rejected",
      reason: "tier-spoof",
      detail: `event tier "${event.tier}" does not match its evidence tier "${messageTier}" (default-deny)`,
      messageTier,
    };
  }

  // Belt-and-suspenders: admin content never goes outward, whatever the channel is configured as.
  if (messageTier === "admin") {
    return {
      status: "rejected",
      reason: "admin-never-outbound",
      detail: "admin-tier content is never emitted to an outbound channel",
      messageTier,
    };
  }

  // 1) Resolve the destination channel explicitly.
  const channel = config.sender.channel ?? config.slack.defaultChannel;
  if (!channel) {
    return {
      status: "rejected",
      reason: "no-destination-channel",
      detail: "no sender.channel or slack.defaultChannel configured",
      messageTier,
    };
  }

  // 2) Resolve the destination's audience tier (default-deny).
  const channelTier = resolveChannelTier(config, channel);
  if (!channelTier) {
    return {
      status: "rejected",
      reason: "unresolvable-destination-tier",
      detail: `channel "${channel}" has no configured audience tier (default-deny)`,
      channel,
      messageTier,
    };
  }

  // 3) Two-sided authorization: destination audience must be cleared for the message tier.
  if (!canChannelReceive(channelTier, messageTier)) {
    return {
      status: "rejected",
      reason: "audience-not-authorized",
      detail: `${channelTier}-tier channel "${channel}" is not authorized to receive ${messageTier}-tier content`,
      channel,
      messageTier,
      channelTier,
    };
  }

  // Authorized — only now format + send. Prefer the richer `sendEvent` hook when a sink provides
  // it (structured fields); otherwise the plain text `send`. All four gates already ran above.
  const text = formatEvent(event);
  const receipt = deps.sendEvent
    ? await deps.sendEvent({ event, channel, messageTier, channelTier, text })
    : await deps.send({ channel, text });
  return { status: "sent", channel, messageTier, channelTier, text, receipt };
}
