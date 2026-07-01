// Inspection helper for `aios loop manifest --explain`. Renders each signal with its
// source + tier, annotated with the lowest audience at which it would be withheld. Default
// view is the owner's (shows everything); `--as team|external` simulates a digest audience.

import type { RunManifest } from "./manifest.js";
import type { Tier } from "./signal.js";
import { visibleTiers, type Audience } from "./ledger.js";

/** The most restrictive audience that can still SEE a given tier (for annotation). */
function withheldFrom(tier: Tier): Audience[] {
  const audiences: Audience[] = ["external", "team", "owner"];
  return audiences.filter((a) => !visibleTiers(a).has(tier));
}

export interface ExplainLine {
  kind: string;
  tier: Tier;
  ref: string; // path[#row]
  summary: string;
  withheldFrom: Audience[]; // audiences that would NOT see this evidence
  visibleToAudience: boolean; // whether visible to the requested `as` audience
}

export interface ExplainView {
  audience: Audience;
  window: RunManifest["window"];
  lines: ExplainLine[];
  excluded: RunManifest["excluded"];
}

export function explainManifest(manifest: RunManifest, audience: Audience = "owner"): ExplainView {
  const visible = visibleTiers(audience);
  const lines: ExplainLine[] = manifest.signals.map((s) => ({
    kind: s.kind,
    tier: s.tier,
    ref: s.ref.row ? `${s.ref.path}#${s.ref.row}` : s.ref.path,
    summary: s.summary,
    withheldFrom: withheldFrom(s.tier),
    visibleToAudience: visible.has(s.tier),
  }));
  return { audience, window: manifest.window, lines, excluded: manifest.excluded };
}
