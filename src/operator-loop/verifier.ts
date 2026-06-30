// C3 — the verifier. Productizes the scaffold's adversarial-verify + rubric-gated
// self-correction pattern (scaffold/.claude/skills/weekly-synthesis + rubrics/) into the
// loop's verification step. "Verification is the value." See docs/v1-operator-loop/c3-verifier.md
// and the must-pass rubric .claude/rubrics/operator-loop-c3.md.
//
// Two deterministic checks against the C2 ledger, gating a bounded correction loop:
//   1. Evidence  — every claim is grounded in a REAL manifest signal (no fabricated grounding).
//   2. Tier-policy — nothing admin/private leaks into a team/external digest; redactions are
//      correct, INCLUDING mixed claims whose sensitive detail may rest only on above-audience
//      evidence (default-deny: must-fail until corrected or a blocking supportCheck certifies).
//
// The result contract is tier-safe BY CONSTRUCTION: a VerifierResult is serialized to `--json`
// and may be shown for a team/external audience, so no finding may carry raw above-audience
// claim text, path, or row. Previews are derived from a redactForTier projection built on the
// TRUSTWORTHY manifest tier (never the drafter's self-reported ref tier, which could be spoofed).

import type { RunManifest } from "./manifest.js";
import type { Cadence, EvidenceRef, Tier } from "./signal.js";
import {
  redactForTier,
  visibleTiers,
  type Audience,
  type EvidenceLedger,
  type LedgerEntry,
} from "./ledger.js";

export type VerifierStatus = "pass" | "corrected" | "failed";
export type VerifierCheck = "evidence" | "tier-policy" | "support";

export interface VerifierFinding {
  check: VerifierCheck;
  /** Maps to a rubric criterion id in .claude/rubrics/operator-loop-c3.md (e.g. "V1"). */
  ruleId: string;
  /** Index into ledger.entries — the owner cross-refs the full un-redacted text on the
   *  source-of-truth (owner) ledger; the index itself leaks nothing. */
  entryIndex: number;
  /** AUDIENCE-SAFE preview only: the redactForTier projection's claim (a placeholder when the
   *  claim is withheld). NEVER the raw above-audience claim text. */
  claimPreview: string;
  /** Audience-safe explanation: check type + counts/tiers only — no paths, rows, or claim text. */
  detail: string;
}

export interface VerifierResult {
  status: VerifierStatus;
  audience: Audience;
  cadence: Cadence;
  /** Remaining must-fails (empty on pass/corrected). */
  findings: VerifierFinding[];
  /** Non-blocking notes (the weekly LLM semantic layer); never affects status. */
  advisory: VerifierFinding[];
  checkedClaims: number;
  loopsUsed: number;
  budget: number;
}

/**
 * A re-draft step: given the current must-fails, return a revised ledger. Injected by the
 * caller (C5's drafter); C3 ships only the controller. The loop is bounded by `budgetFor`.
 */
export type CorrectFn = (
  findings: VerifierFinding[],
  ledger: EvidenceLedger
) => EvidenceLedger | Promise<EvidenceLedger>;

/**
 * BLOCKING support certifier for mixed (requiresIndependentSupport) claims: confirms the
 * ALLOWED-tier refs independently support the emitted claim. A truthy return clears the
 * must-fail; absent/false keeps it. This is the ONLY mechanism (besides correction into an
 * audience-safe claim) that may clear a mixed claim — it is never advisory.
 */
export type SupportCheckFn = (
  entry: LedgerEntry,
  allowedEvidence: EvidenceRef[]
) => boolean | Promise<boolean>;

/**
 * Advisory-only semantic check (weekly): may surface non-blocking notes (e.g. an LLM judging
 * whether prose faithfully reflects its cited signal). It NEVER changes status — tier-sensitive
 * safety is owned by the deterministic checks + the blocking supportCheck, not by this hook.
 */
export type SemanticCheckFn = (
  manifest: RunManifest,
  ledger: EvidenceLedger,
  audience: Audience
) => VerifierFinding[] | Promise<VerifierFinding[]>;

/** Correction budget by cadence: daily near-zero (no LLM correction), weekly a bounded few. */
export function budgetFor(cadence: Cadence): number {
  return cadence === "weekly" ? 2 : 0;
}

const TIER_RANK: Record<Tier, number> = { external: 0, team: 1, admin: 2 };
// Collision-proof location key. JSON-encodes [path, row] so an ABSENT row (null) is distinct
// from an empty-string row (""), and no separator can be forged inside a path/row.
const refKey = (r: { path: string; row?: string }) => JSON.stringify([r.path, r.row ?? null]);
// Location + tier — the exact-resolution key (a path/row match with a different tier is a spoof).
const refTierKey = (r: EvidenceRef) => JSON.stringify([r.path, r.row ?? null, r.tier]);

/** Index a manifest by signal-ref location → the most restrictive REAL tier at that location.
 *  Used to build tier-safe previews from trustworthy tiers (defends against ref-tier spoofing). */
function indexManifestTiers(manifest: RunManifest): Map<string, Tier> {
  const byLoc = new Map<string, Tier>();
  for (const s of manifest.signals) {
    const k = refKey(s.ref);
    const prev = byLoc.get(k);
    if (prev === undefined || TIER_RANK[s.ref.tier] > TIER_RANK[prev]) byLoc.set(k, s.ref.tier);
  }
  return byLoc;
}

/** A ref RESOLVES iff a manifest signal shares its exact path + row + tier. A path/row match
 *  with a different tier is a spoof — unresolved (and caught as fabricated grounding). */
function indexManifestRefs(manifest: RunManifest): Set<string> {
  const exact = new Set<string>();
  for (const s of manifest.signals) exact.add(refTierKey(s.ref));
  return exact;
}

/**
 * Build an audience-safe claim preview. C3-strict: a claim's text is echoed ONLY when EVERY
 * piece of its evidence rests on a tier the audience may see — using the TRUSTWORTHY manifest
 * tier at each ref location (worst-case `admin` when a ref does not resolve, so a spoofed or
 * fabricated ref tier cannot coax text into the open). This is stricter than `redactForTier`,
 * which emits a *mixed* claim's text under a flag: here a mixed (or withheld, or ungrounded)
 * claim NEVER echoes its text, because that text may rest entirely on above-audience evidence.
 */
function safeClaimPreview(
  entry: LedgerEntry,
  audience: Audience,
  trustedTiers: Map<string, Tier>
): string {
  if (!entry.evidence || entry.evidence.length === 0) return "[ungrounded claim — withheld]";
  const visible = visibleTiers(audience);
  const allVisible = entry.evidence.every((r) =>
    visible.has(trustedTiers.get(refKey(r)) ?? "admin")
  );
  return allVisible ? entry.claim : "[withheld — claim depends on above-audience evidence]";
}

export interface VerifyLedgerInput {
  manifest: RunManifest;
  ledger: EvidenceLedger;
  audience: Audience;
  /** Optional blocking certifier for mixed claims (see SupportCheckFn). */
  supportCheck?: SupportCheckFn;
}

/**
 * Run the deterministic checks once over the ledger, returning the must-fail findings.
 * (The bounded correction loop lives in `runVerification`.)
 */
export async function verifyLedger(input: VerifyLedgerInput): Promise<VerifierFinding[]> {
  const { manifest, ledger, audience, supportCheck } = input;
  const trustedTiers = indexManifestTiers(manifest);
  const resolvable = indexManifestRefs(manifest);
  const visible = visibleTiers(audience);
  const findings: VerifierFinding[] = [];

  const entries = ledger.entries ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const preview = () => safeClaimPreview(entry, audience, trustedTiers);

    // ── Evidence check (V1): a claim with no evidence reference cannot be emitted. ──
    if (!entry.evidence || entry.evidence.length === 0) {
      findings.push({
        check: "evidence",
        ruleId: "V1",
        entryIndex: i,
        claimPreview: preview(),
        detail: "ungrounded: claim carries no evidence reference",
      });
      continue; // nothing further is meaningful without evidence
    }

    // ── Evidence check (V2): every ref must resolve to a REAL manifest signal. ──
    const unresolved = entry.evidence.filter((r) => !resolvable.has(refTierKey(r)));
    if (unresolved.length > 0) {
      findings.push({
        check: "evidence",
        ruleId: "V2",
        entryIndex: i,
        claimPreview: preview(),
        detail: `fabricated grounding: ${unresolved.length} of ${entry.evidence.length} evidence ref(s) do not resolve to a manifest signal`,
      });
      // tiers are untrustworthy when refs don't resolve — skip the tier-policy verdict for this
      // entry; the evidence finding already blocks it. (preview() still worst-cases the tier.)
      continue;
    }

    // ── Tier-policy + support check (V3 / V7) on a redaction of the real entry. ──
    const r = redactForTier(entry, audience);

    // Mixed (allowed + above-audience) evidence: default-deny. Only a blocking supportCheck
    // certification (or correction into an audience-safe claim) may clear it.
    if (r.entry.requiresIndependentSupport) {
      const allowed = entry.evidence.filter((e) => visible.has(e.tier));
      const certified = supportCheck ? await supportCheck(entry, allowed) : false;
      if (!certified) {
        findings.push({
          check: "support",
          ruleId: "V7",
          entryIndex: i,
          // A mixed claim's TEXT may rest on the admin detail — withhold it (not r.entry.claim,
          // which redactForTier would emit under its weaker emit-but-flag policy).
          claimPreview: preview(),
          detail: certifyDetail(r.entry.withheld),
        });
        continue;
      }
    }

    // Belt-and-suspenders (V3): a redacted projection must never carry an above-audience
    // path/row. Guards against any future redactForTier regression.
    const leaked = JSON.stringify(r.entry).match(/"path":/)
      ? entry.evidence.filter((e) => !visible.has(e.tier) && projectionLeaks(r.entry, e))
      : [];
    if (leaked.length > 0) {
      findings.push({
        check: "tier-policy",
        ruleId: "V3",
        entryIndex: i,
        claimPreview: preview(),
        detail: `tier leak: ${leaked.length} above-audience source reference(s) appeared in a digest-facing projection`,
      });
    }
  }

  return findings;
}

function certifyDetail(withheld: { tier: Tier; count: number }[] | undefined): string {
  const parts = (withheld ?? []).map((w) => `${w.count} ${w.tier}-tier`);
  const counts = parts.length ? ` (withheld: ${parts.join(", ")})` : "";
  return `mixed-evidence claim requires independent support from allowed refs${counts}`;
}

/** True if an above-audience ref's path or row literally appears in the redacted projection. */
function projectionLeaks(projection: { evidence: EvidenceRef[] }, above: EvidenceRef): boolean {
  const ser = JSON.stringify(projection.evidence);
  if (ser.includes(JSON.stringify(above.path))) return true;
  if (above.row !== undefined && ser.includes(`"row":${JSON.stringify(above.row)}`)) return true;
  return false;
}

const VERIFIER_CHECKS: ReadonlySet<VerifierCheck> = new Set<VerifierCheck>([
  "evidence",
  "tier-policy",
  "support",
]);

/**
 * Make hook-provided advisory findings tier-safe BY CONSTRUCTION (V5/V6). A `semanticCheck`
 * hook controls EVERY field of the findings it returns, so for a shared (team/external) audience
 * none of them may pass through verbatim — any string field could carry admin content:
 *  - `claimPreview` is ALWAYS re-derived from the ledger entry (never the hook's string).
 *  - `detail` is hook-authored FREE TEXT (it may paraphrase admin content, not just quote a
 *    scrubbable literal) → replaced with a content-free pointer.
 *  - `ruleId` is also a hook free string (and the CLI prints it) → replaced with a fixed label.
 *  - `check` is clamped to the known enum; `entryIndex` to a validated in-range integer (or -1).
 * The OWNER brief already sees every tier, so the hook's fields are passed through there.
 */
function sanitizeAdvisory(
  raw: VerifierFinding[],
  manifest: RunManifest,
  ledger: EvidenceLedger,
  audience: Audience
): VerifierFinding[] {
  const trustedTiers = indexManifestTiers(manifest);
  const entries = ledger.entries ?? [];
  const ownerView = audience === "owner";

  return raw.map((f) => {
    const inRange =
      Number.isInteger(f.entryIndex) && f.entryIndex >= 0 && f.entryIndex < entries.length;
    const claimPreview = inRange
      ? safeClaimPreview(entries[f.entryIndex]!, audience, trustedTiers)
      : "[advisory]";
    if (ownerView) {
      return {
        check: f.check,
        ruleId: f.ruleId,
        entryIndex: f.entryIndex,
        claimPreview,
        detail: f.detail ?? "",
      };
    }
    // Shared audience: rebuild from validated/derived values only — no hook string survives.
    return {
      check: VERIFIER_CHECKS.has(f.check) ? f.check : "evidence",
      ruleId: "advisory",
      entryIndex: inRange ? f.entryIndex : -1,
      claimPreview,
      detail: "[advisory note withheld — visible on the owner brief]",
    };
  });
}

export interface RunVerificationInput {
  manifest: RunManifest;
  ledger: EvidenceLedger;
  audience: Audience;
  cadence: Cadence;
  correct?: CorrectFn;
  supportCheck?: SupportCheckFn;
  semanticCheck?: SemanticCheckFn;
}

/**
 * The bounded, rubric-gated verification loop:
 *   verify → (must-fails && budget left && correct) ? re-draft → re-verify : stop.
 * Status: pass (clean first time) | corrected (clean within budget) | failed (budget exhausted —
 * fail loud, do NOT ship). Daily budget is 0 (deterministic only). The optional semanticCheck
 * contributes advisory notes only and never changes status.
 */
export async function runVerification(input: RunVerificationInput): Promise<VerifierResult> {
  const { manifest, audience, cadence, correct, supportCheck, semanticCheck } = input;
  const budget = budgetFor(cadence);
  let ledger = input.ledger;

  let findings = await verifyLedger({ manifest, ledger, audience, supportCheck });
  let loopsUsed = 0;
  let corrected = false;

  while (findings.length > 0 && loopsUsed < budget && correct) {
    ledger = await correct(findings, ledger);
    loopsUsed++;
    corrected = true;
    findings = await verifyLedger({ manifest, ledger, audience, supportCheck });
  }

  let status: VerifierStatus;
  if (findings.length === 0) status = corrected ? "corrected" : "pass";
  else status = "failed";

  // Advisory semantic layer (weekly only) — never gates, and is sanitized so the hook cannot
  // leak above-audience content through claimPreview/detail.
  let advisory: VerifierFinding[] = [];
  if (cadence === "weekly" && semanticCheck) {
    const rawAdvisory = (await semanticCheck(manifest, ledger, audience)) ?? [];
    advisory = sanitizeAdvisory(rawAdvisory, manifest, ledger, audience);
  }

  return {
    status,
    audience,
    cadence,
    findings,
    advisory,
    checkedClaims: ledger.entries?.length ?? 0,
    loopsUsed,
    budget,
  };
}
