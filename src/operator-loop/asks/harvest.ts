// Asks harvest (AIO-167) — the production caller that wires the inbox transport into the real
// loop pipeline. Without this the transport would be dead code (the review blocker): `aios asks
// harvest` loads the comms config, runs the C1 collector for the cadence window, derives loop
// events with the AIO-140 detectors, and dispatches each through the tier-gated sender into the
// local asks store.
//
// Idempotency: each harvested ask gets a dedupeKey = sha256(kind|ref.path|ref.row); an event whose
// key already matches an OPEN ask is suppressed (not re-added) so re-harvesting the same window
// never floods the queue.

import { collect } from "../collector.js";
import type { Cadence } from "../signal.js";
import { loadCommsConfig } from "../comms/config.js";
import { detectEvents } from "../comms/detectors.js";
import { dispatchOnEvent, type NotificationEvent } from "../comms/sender.js";
import { createInboxTransport } from "./transport.js";
import { hasOpenDuplicate, sha256 } from "./store.js";

export interface HarvestOptions {
  cadence: Cadence;
  now?: Date;
  /** Override for the comms config file (tests). */
  commsConfigPath?: string;
  member?: string;
  project?: string;
}

export interface HarvestResult {
  events: number; // total loop events detected
  delivered: number; // events dispatched → ask created
  rejected: number; // events blocked by a gate (tier/channel/audience)
  noop: number; // events not dispatched (sender.on trigger gate)
  suppressed: number; // events dropped as an open duplicate before dispatch
  byReason: Record<string, number>;
}

function dedupeKeyFor(event: NotificationEvent): string {
  return sha256(`${event.kind}|${event.ref.path}|${event.ref.row ?? ""}`);
}

/**
 * Harvest loop events into the local asks store through the real collect → detect → dispatch →
 * sink path. Returns per-outcome counts (and per-reason tallies for rejected/noop/suppressed).
 */
export async function harvestAsks(root: string, opts: HarvestOptions): Promise<HarvestResult> {
  const now = opts.now ?? new Date();
  const config = loadCommsConfig(root, opts.commsConfigPath);
  const manifest = collect({
    root,
    cadence: opts.cadence,
    now,
    ...(opts.member ? { member: opts.member } : {}),
    ...(opts.project ? { project: opts.project } : {}),
  });
  const events = detectEvents(manifest.signals, now);

  const result: HarvestResult = {
    events: events.length,
    delivered: 0,
    rejected: 0,
    noop: 0,
    suppressed: 0,
    byReason: {},
  };
  const bump = (reason: string): void => {
    result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
  };

  for (const event of events) {
    const dedupeKey = dedupeKeyFor(event);
    if (hasOpenDuplicate(root, dedupeKey)) {
      result.suppressed++;
      bump("suppressed-open-duplicate");
      continue;
    }
    const transport = createInboxTransport(root, { dedupeKey, now });
    const res = await dispatchOnEvent(event, config, transport);
    if (res.status === "sent") {
      result.delivered++;
    } else if (res.status === "rejected") {
      result.rejected++;
      bump(res.reason ?? "rejected");
    } else {
      result.noop++;
      bump(res.reason ?? "noop");
    }
  }
  return result;
}
