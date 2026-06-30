// C2 — the evidence ledger. The trust primitive: every claim links to >=1 manifest signal
// (its EvidenceRef). This is what makes C3's verifier possible and lets a human inspect
// "why does it say this?".
//
// The ledger governs CLAIM EMISSION, not just which refs are shown. Withholding only the
// refs while still printing an admin-derived claim would leak private content into a
// lower-tier digest — so a claim backed solely by above-audience evidence emits NO factual
// text, only a content-free placeholder. See docs/v1-operator-loop/c2-evidence-ledger.md.

import type { EvidenceRef, Tier } from "./signal.js";

export type Audience = "owner" | "team" | "external";

/**
 * What an audience may SEE. `external` content is the most broadly shareable (cleared for
 * outside); `team` is internal-shareable; `admin` is owner-only. So an external digest may
 * cite only external sources; a team digest external+team; the owner brief everything.
 */
export function visibleTiers(audience: Audience): ReadonlySet<Tier> {
  if (audience === "external") return new Set<Tier>(["external"]);
  if (audience === "team") return new Set<Tier>(["external", "team"]);
  return new Set<Tier>(["external", "team", "admin"]);
}

/** Content-free record of withheld evidence: count by tier only — safe to show at any audience
 *  (a raw EvidenceRef path/row could itself leak above-tier information, e.g. a filename). */
export interface WithheldSummary {
  tier: Tier;
  count: number;
}

export interface LedgerEntry {
  claim: string;
  evidence: EvidenceRef[]; // >=1 ref into the manifest; empty = hard fail
  /** Count + tier only — NEVER raw refs. The full above-audience refs live on the un-redacted
   *  (owner/internal) ledger entry, never on a digest-facing one. */
  withheld?: WithheldSummary[];
  /** Set when the claim mixes allowed + above-audience evidence: C3 must confirm the
   *  allowed evidence independently grounds the claim before the digest ships. */
  requiresIndependentSupport?: boolean;
}

export interface EvidenceLedger {
  entries: LedgerEntry[];
}

/** A claim with no evidence reference cannot be emitted — a hard fail. */
export function assertGrounded(entry: LedgerEntry): void {
  if (!entry.evidence || entry.evidence.length === 0) {
    throw new Error(`ungrounded claim (no evidence reference): "${entry.claim}"`);
  }
}

/**
 * A digest-facing, redacted projection of a ledger entry. Unlike `LedgerEntry`, its `evidence`
 * MAY be empty — a fully-withheld claim emits no evidence, only a placeholder. This is a separate
 * type precisely so it does NOT masquerade as a groundable `LedgerEntry` (assertGrounded guards
 * the source-of-truth entry, not this projection).
 */
export interface RedactedEntry {
  claim: string;
  evidence: EvidenceRef[];
  withheld?: WithheldSummary[];
  requiresIndependentSupport?: boolean;
}

export interface RedactionResult {
  /** Whether the claim's factual text may appear in a digest for this audience. */
  emit: boolean;
  /** The entry as it should appear: when emit=false, `claim` is replaced by a placeholder. */
  entry: RedactedEntry;
  /** A content-free notice when something was withheld (count + tier), never claim text. */
  placeholder?: string;
}

/** Reduce above-audience refs to counts by tier — strips path/row so nothing leaks. */
function summarizeWithheld(refs: EvidenceRef[]): WithheldSummary[] {
  const byTier = new Map<Tier, number>();
  for (const r of refs) byTier.set(r.tier, (byTier.get(r.tier) ?? 0) + 1);
  return [...byTier.entries()].map(([tier, count]) => ({ tier, count }));
}

function withheldNotice(summary: WithheldSummary[]): string {
  // Count + tier only — no content, no paths, no claim text.
  const parts = summary.map(
    ({ tier, count }) => `${count} ${tier}-tier source${count === 1 ? "" : "s"}`
  );
  return `[withheld — ${parts.join(", ")}]`;
}

/**
 * Decide how a ledger entry may be emitted to a digest for `audience`.
 * - allowed === 0  → emit:false; no claim text, only a content-free placeholder.
 * - mixed          → emit:true with requiresIndependentSupport=true and withheld counts.
 * - all allowed    → emit:true, nothing withheld.
 * Redactions are always visible (counts + tier), never silent drops.
 */
export function redactForTier(entry: LedgerEntry, audience: Audience): RedactionResult {
  assertGrounded(entry);
  const visible = visibleTiers(audience);
  const allowed = entry.evidence.filter((e) => visible.has(e.tier));
  const aboveAudience = entry.evidence.filter((e) => !visible.has(e.tier));

  if (allowed.length === 0) {
    const summary = summarizeWithheld(aboveAudience);
    const placeholder = withheldNotice(summary);
    return {
      emit: false,
      placeholder,
      entry: { claim: placeholder, evidence: [], withheld: summary },
    };
  }

  if (aboveAudience.length > 0) {
    return {
      emit: true,
      entry: {
        claim: entry.claim,
        evidence: allowed,
        withheld: summarizeWithheld(aboveAudience), // counts only — no above-audience paths/rows
        requiresIndependentSupport: true,
      },
    };
  }

  return { emit: true, entry: { claim: entry.claim, evidence: allowed } };
}
