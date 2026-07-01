// The run manifest — the single input contract that the brief/digest steps (C4/C5) read.
// It decouples sources from drafting: nothing downstream reads the workspace directly.

import type { Cadence, Signal } from "./signal.js";
import type { Exclusion } from "./sources/types.js";

export interface RunManifest {
  member: string;
  project: string;
  window: { cadence: Cadence; from: string; to: string };
  windowed: boolean; // false means signals contain the full current state for the cadence's kinds
  generatedAt: string;
  signals: Signal[]; // includes admin-tier signals (they feed the private operator brief)
  excluded: Exclusion[]; // default-deny log: signals dropped for an unresolvable tier
}

export interface BuildManifestInput {
  member: string;
  project: string;
  cadence: Cadence;
  from: string;
  to: string;
  windowed?: boolean;
  generatedAt: string;
  signals: Signal[];
  excluded: Exclusion[];
}

export function buildManifest(i: BuildManifestInput): RunManifest {
  return {
    member: i.member,
    project: i.project,
    window: { cadence: i.cadence, from: i.from, to: i.to },
    windowed: i.windowed ?? true,
    generatedAt: i.generatedAt,
    signals: i.signals,
    excluded: i.excluded,
  };
}
