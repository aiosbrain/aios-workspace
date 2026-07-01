// C5 privacy primitives — tier-bound the DRAFTER INPUT, not just its output.
//
// The local-first invariant (CLAUDE.md): nothing leaves the machine until `aios push`. C5's
// drafter is the loop's first off-machine step, so the ONLY manifest shape it ever sees is an
// audience projection: signals filtered to `visibleTiers(audience)` with `excluded[]` stripped.
// Consequences (see docs/v1-operator-loop/c5-weekly.md "Remote LLM drafting — egress consent"):
//   - a `team` draft sees only team+external signals; `external` sees only external. Admin-tier
//     content (and the default-deny `excluded` log, which carries dropped paths/reasons) is
//     NEVER sent off-machine.
//   - the drafter can only cite signals it was given → every claim is allowed-evidence-only and
//     mixed admin/team/external claims cannot form on the shareable path (no LLM tier gate needed).
//
// The FULL manifest stays local and is used by trusted in-process code only: to verify refs, to
// count withheld signals for the digest, and to feed the C5 deterministic text-leak sweep.

import type { RunManifest } from "./manifest.js";
import type { Signal, Tier } from "./signal.js";
import { visibleTiers, type Audience, type WithheldSummary } from "./ledger.js";

const TIER_RANK: Record<Tier, number> = { external: 0, team: 1, admin: 2 };

/**
 * A signal counts as visible to an audience ONLY when BOTH its own `tier` AND its `ref.tier` are
 * audience-visible. Guarding both fields defends a hand-edited/malformed manifest (e.g. a mislabel
 * `tier: team` over a `ref.tier: admin`) from leaking the admin ref into a remote drafter input.
 */
function signalVisible(s: Signal, visible: ReadonlySet<Tier>): boolean {
  return visible.has(s.tier) && visible.has(s.ref?.tier ?? "admin");
}

/** The most restrictive tier carried by a signal (own tier vs ref tier) — used for withheld counts. */
function effectiveTier(s: Signal): Tier {
  const a = s.tier;
  const b = s.ref?.tier ?? "admin";
  return TIER_RANK[a] >= TIER_RANK[b] ? a : b;
}

/**
 * The audience projection of a manifest: signals visible to the audience (by BOTH tier fields) and
 * `excluded` cleared. This is the ONLY manifest shape passed to the drafter / a remote LLM.
 */
export function projectManifest(manifest: RunManifest, audience: Audience): RunManifest {
  const visible = visibleTiers(audience);
  return {
    member: manifest.member,
    project: manifest.project,
    window: manifest.window,
    windowed: manifest.windowed,
    generatedAt: manifest.generatedAt,
    signals: (manifest.signals ?? []).filter((s) => signalVisible(s, visible)),
    // Strip the default-deny log entirely: its `ref`/`reason` strings can name dropped admin
    // paths, and the drafter has no use for them. Withheld COUNTS come from `withheldByTier`.
    excluded: [],
  };
}

/**
 * Content-free summary, computed from the FULL LOCAL manifest, of how many signals sit ABOVE the
 * audience tier — so the digest can show "N team-tier source(s) withheld" without the drafter ever
 * seeing them. Counts + tiers only; never paths/rows/summaries. A signal withheld for either tier
 * field is counted under its most-restrictive (effective) tier.
 */
export function withheldByTier(manifest: RunManifest, audience: Audience): WithheldSummary[] {
  const visible = visibleTiers(audience);
  const byTier = new Map<Tier, number>();
  for (const s of manifest.signals ?? []) {
    if (signalVisible(s, visible)) continue;
    const tier = effectiveTier(s);
    byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
  }
  return [...byTier.entries()].map(([tier, count]) => ({ tier, count }));
}

/**
 * The corpus for the C5 deterministic text-leak sweep: the DISTINCTIVE literal strings of every
 * ABOVE-audience signal in the full local manifest. C3 validates that a claim's REFS resolve +
 * don't leak, but it does NOT check that a claim's free TEXT is supported by its cited ref — so a
 * drafter could cite an allowed ref while writing text that quotes an admin signal's summary.
 * `sweepForLeaks` checks rendered output for any of these strings (case-insensitive substring).
 *
 * Matching primitive — chosen so the sweep is neither a false-negative sieve nor a false-positive
 * brick (both failure modes flagged in review):
 *   - whole MULTI-WORD summaries + whole PATHS (a distinctive phrase/path is unlikely to appear in
 *     lower-tier prose by coincidence);
 *   - DISTINCTIVE tokens from summaries/paths: words ≥8 chars (sentinels, identifiers, proper
 *     nouns) OR short mixed alphanumerics ≥3 chars like "40m"/"v12" (sensitive ids);
 *   - descriptive (non-numeric) row keys ≥4 chars.
 * A single short common word ("Funding") is deliberately NOT swept as a whole string — it would
 * brick valid digests on coincidence, and the PRIMARY defense (tier-bounded input) already keeps
 * such content from ever reaching the drafter.
 */
export function aboveAudienceStrings(manifest: RunManifest, audience: Audience): Set<string> {
  const visible = visibleTiers(audience);
  const out = new Set<string>();
  const hasLetter = (t: string) => /[A-Za-z]/.test(t);
  const hasDigit = (t: string) => /[0-9]/.test(t);

  const addPhrase = (v: string | undefined) => {
    const t = (v ?? "").trim();
    // A whole string is added only if it's a distinctive PHRASE (multi-token) — never a single
    // bare word, which would substring-collide with ordinary lower-tier prose.
    if (/\s/.test(t) && t.length >= 4) out.add(t);
  };
  const addPath = (v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t.length >= 4 && !/^[0-9]+$/.test(t)) out.add(t);
  };
  const addRow = (v: string | undefined) => {
    const t = (v ?? "").trim();
    if (t.length >= 4 && !/^[0-9]+$/.test(t)) out.add(t);
  };
  const addTokens = (v: string | undefined) => {
    for (const tok of (v ?? "").split(/[^A-Za-z0-9]+/)) {
      const distinctiveWord = tok.length >= 8 && !/^[0-9]+$/.test(tok);
      const sensitiveId = tok.length >= 3 && hasLetter(tok) && hasDigit(tok);
      if (distinctiveWord || sensitiveId) out.add(tok);
    }
  };

  for (const s of manifest.signals ?? []) {
    if (signalVisible(s, visible)) continue;
    const sig = s as Signal;
    addPhrase(sig.summary);
    addTokens(sig.summary);
    addPath(sig.ref?.path);
    addTokens(sig.ref?.path);
    addRow(sig.ref?.row);
  }
  return out;
}
