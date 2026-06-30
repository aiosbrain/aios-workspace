// Window configs — the ONLY thing that differs between the two cadences. One collector
// engine consumes a WindowConfig; daily and weekly are just different config objects
// (window length + kind allowlist). No per-cadence code path. (C1 acceptance.)

import type { Cadence } from "./signal.js";

export interface WindowConfig {
  cadence: Cadence;
  days: number; // lookback window in days
  kinds: readonly string[]; // signal kinds collected for this cadence
}

/** Daily: 1-day window, minimal kind filter — fast, low-friction orientation. */
export const DAILY: WindowConfig = {
  cadence: "daily",
  days: 1,
  kinds: ["decision", "task", "deliverable", "carryover"],
};

/** Weekly: 7-day window, full source set — the heavy verified pull. */
export const WEEKLY: WindowConfig = {
  cadence: "weekly",
  days: 7,
  // github is listed (full set) but its source is an inert deferred stub — it emits nothing
  // until a local GitHub-activity source exists (AIO-32 is brain-side). See sources/github.ts.
  kinds: ["decision", "task", "hours", "deliverable", "inbox", "carryover", "github"],
};

export function windowFor(cadence: Cadence): WindowConfig {
  return cadence === "daily" ? DAILY : WEEKLY;
}
