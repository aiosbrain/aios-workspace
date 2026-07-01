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
  /** The tier of the CONTENT being surfaced — what the gate authorizes against. */
  tier: Tier;
  summary: string;
  /** Pointer back to the source that triggered this event (referenced in the message). */
  ref: EvidenceRef;
  waitingOn?: string;
  dueAt?: string;
}

/** Injected transport. Returns whatever receipt the wire produces (opaque to the sender). */
export type SendFn = (msg: { channel: string; text: string }) => Promise<unknown> | unknown;

export interface DispatchDeps {
  send: SendFn;
}

export type RejectReason =
  | "no-destination-channel"
  | "admin-never-outbound"
  | "unresolvable-destination-tier"
  | "audience-not-authorized";

export interface DispatchResult {
  status: "sent" | "rejected";
  reason?: RejectReason;
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
  const messageTier = event.tier;

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

  // Authorized — only now format + send.
  const text = formatEvent(event);
  const receipt = await deps.send({ channel, text });
  return { status: "sent", channel, messageTier, channelTier, text, receipt };
}
