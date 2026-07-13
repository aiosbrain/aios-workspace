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
 *   - whole MULTI-WORD summaries (a distinctive phrase is unlikely to appear in lower-tier prose by
 *     coincidence);
 *   - DISTINCTIVE tokens from summaries/paths: words ≥8 chars (sentinels, identifiers, proper
 *     nouns) OR short mixed alphanumerics ≥3 chars like "40m"/"v12" (sensitive ids).
 * A single short common word ("Funding") is deliberately NOT swept as a whole string — it would
 * brick valid digests on coincidence, and the PRIMARY defense (tier-bounded input) already keeps
 * such content from ever reaching the drafter.
 *
 * AIO-363, part 1 — bare paths/row-ids: file paths and row-ids (whole-string, not tokenized) are
 * deliberately NOT added to this corpus, for the same reason a short common word isn't. A path/
 * row-id is a STRUCTURAL pointer, not secret content by itself — and real workspace files routinely
 * mix tiers per-row in one file (e.g. `3-log/time-log.md` is file-tier `admin` but carries `Tier:
 * team` rows). When that happens, a legitimately ≤-audience claim's own evidence citation (its own
 * path, appended AFTER the per-claim sweep — see closeout.ts) coincidentally collides with an
 * unrelated above-audience signal's path in the SAME file, and the whole-document residual sweep
 * (closeout.ts) would nuke an entirely clean digest. The primary defense against a real path/row
 * leak is tier-bounded drafter input (`signalVisible`/`projectManifest`) plus ref resolution in the
 * C3 verifier — never this sweep. A path's SENSITIVE-ID-shaped tokens (mixed alnum, e.g. a real
 * identifier) are still swept via `addTokens`; its bare ≥8-char WORD tokens are not (see part 2 —
 * field evidence showed a path is far more often a generic folder name — "reference", "personal",
 * "engagement" — than a genuine codename, the same over-fire shape as ordinary prose).
 *
 * AIO-363, part 2 — the bigger field-verified contributor: a candidate needle is dropped entirely
 * when it ALSO occurs (case-insensitive substring) somewhere in the manifest's ≤-audience VISIBLE
 * signals (summary or path). Real dogfood data showed the length/shape heuristics above still
 * over-fire on ordinary domain vocabulary — "engineering", "management", "Anthropic", "OpenRouter" —
 * words that recur in EVERY tier of a real AI-transformation workspace (including the digest's own
 * deterministic tag-name boilerplate, `renderRuntimeByTag`). A word/phrase that already appears
 * somewhere the audience is allowed to see carries no additional tier-safety signal by sweeping it
 * again — it's shared vocabulary, not admin-exclusive content. This "differential" gate is what
 * turned a 0%-shippable-on-4/4-real-runs corpus into one that only flags genuinely admin-exclusive
 * strings (proper nouns, sentinels, ids that never occur in ≤-audience content this run).
 */
export function aboveAudienceStrings(manifest: RunManifest, audience: Audience): Set<string> {
  return collectAboveAudience(manifest, audience).strings;
}

/**
 * Same corpus as {@link aboveAudienceStrings}, but paired with the (most-restrictive) tier each
 * needle came from — used by the C5 leak-report (AIO-363) to explain WHY a claim was withheld
 * without re-deriving the sweep. Not used by the sweep itself (which only needs the string set).
 */
export function aboveAudienceStringTiers(manifest: RunManifest, audience: Audience): Map<string, Tier> {
  return collectAboveAudience(manifest, audience).tierOf;
}

function collectAboveAudience(
  manifest: RunManifest,
  audience: Audience
): { strings: Set<string>; tierOf: Map<string, Tier> } {
  const visible = visibleTiers(audience);
  const out = new Set<string>();
  const tierOf = new Map<string, Tier>();
  const hasLetter = (t: string) => /[A-Za-z]/.test(t);
  const hasDigit = (t: string) => /[0-9]/.test(t);

  // AIO-363 differential gate: the ≤-audience-VISIBLE text, lowercased, from THIS SAME manifest.
  // A candidate needle that already occurs here is ordinary shared vocabulary the audience is
  // already allowed to see — sweeping it again only ever bricks a valid digest on coincidence.
  let visibleBlob = "";
  for (const s of manifest.signals ?? []) {
    if (!signalVisible(s, visible)) continue;
    visibleBlob += ` ${s.summary ?? ""} ${s.ref?.path ?? ""}`;
  }
  visibleBlob = visibleBlob.toLowerCase();
  const alreadyVisible = (v: string) => visibleBlob.includes(v.toLowerCase());

  const record = (v: string, tier: Tier) => {
    if (alreadyVisible(v)) return;
    out.add(v);
    // A needle can theoretically come from more than one above-audience signal at different
    // tiers; keep the MOST restrictive (admin > team > external) for reporting purposes.
    const prev = tierOf.get(v);
    if (!prev || TIER_RANK[tier] > TIER_RANK[prev]) tierOf.set(v, tier);
  };

  const addPhrase = (v: string | undefined, tier: Tier) => {
    const t = (v ?? "").trim();
    // A whole string is added only if it's a distinctive PHRASE (multi-token) — never a single
    // bare word, which would substring-collide with ordinary lower-tier prose.
    if (/\s/.test(t) && t.length >= 4) record(t, tier);
  };
  // `words: true` also sweeps bare ≥8-char alpha tokens (sentinels/identifiers/proper nouns in
  // authored prose). `words: false` sweeps ONLY the sensitive-id shape (mixed alnum, e.g. "40m").
  // AIO-363 field evidence: a bare ≥8-char word carved out of a PATH is overwhelmingly a generic
  // folder/organizational word ("reference", "personal", "engagement") rather than a project
  // codename — the exact same false-positive shape as part 2, just via paths instead of summaries.
  // Summaries are authored free text, where a long word is more plausibly a genuine distinctive
  // term worth protecting; paths get the narrower, still-real sensitive-id check only.
  const addTokens = (v: string | undefined, tier: Tier, opts: { words: boolean }) => {
    for (const tok of (v ?? "").split(/[^A-Za-z0-9]+/)) {
      const distinctiveWord = opts.words && tok.length >= 8 && !/^[0-9]+$/.test(tok);
      const sensitiveId = tok.length >= 3 && hasLetter(tok) && hasDigit(tok);
      if (distinctiveWord || sensitiveId) record(tok, tier);
    }
  };

  for (const s of manifest.signals ?? []) {
    if (signalVisible(s, visible)) continue;
    const sig = s as Signal;
    const tier = effectiveTier(sig);
    addPhrase(sig.summary, tier);
    addTokens(sig.summary, tier, { words: true });
    addTokens(sig.ref?.path, tier, { words: false });
  }
  return { strings: out, tierOf };
}
