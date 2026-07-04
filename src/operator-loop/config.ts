// Window configs — the ONLY thing that differs between the two cadences. One collector
// engine consumes a WindowConfig; daily and weekly are just different config objects
// (window length + kind allowlist). No per-cadence code path. (C1 acceptance.)

import type { Cadence } from "./signal.js";

export interface WindowConfig {
  cadence: Cadence;
  days: number; // lookback window in days
  kinds: readonly string[]; // signal kinds collected for this cadence
}

/** Daily: 1-day window, minimal kind filter — fast, low-friction orientation.
 *  `time` feeds C4's "what agents ran yesterday" section (daily.ts renders it explicitly). */
export const DAILY: WindowConfig = {
  cadence: "daily",
  days: 1,
  // `comms` (AIO-140) feeds C4's "what's blocked / waiting on someone" from Slack/email/calendar
  // activity; inert (empty) until a workspace has a comms activity store.
  kinds: ["decision", "task", "deliverable", "carryover", "time", "comms"],
};

/** Weekly: 7-day window, full source set — the heavy verified pull. */
export const WEEKLY: WindowConfig = {
  cadence: "weekly",
  days: 7,
  // github is listed (full set) but its source is an inert deferred stub — it emits nothing
  // until a local GitHub-activity source exists (AIO-32 is brain-side). See sources/github.ts.
  // time (AIO-139) feeds the C5 runtime-by-tag roll-up; closeout partitions it out of claims.
  // maturity (AIO-144) is the C8 telemetry slice — one aggregate AEM placement signal from
  // the local AM1 session store (admin-tier, never syncs); inert until sessions are captured.
  kinds: [
    "decision",
    "task",
    "hours",
    "deliverable",
    "inbox",
    "carryover",
    "github",
    "time",
    "comms",
    "maturity",
  ],
};

export function windowFor(cadence: Cadence): WindowConfig {
  return cadence === "daily" ? DAILY : WEEKLY;
}
