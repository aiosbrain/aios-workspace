// C5 drafter — the loop's first LLM step, kept SEPARATE from and UNTRUSTED by the verifier.
//
// The drafter turns an AUDIENCE PROJECTION (project.ts) into a grounded evidence ledger + tier-
// tagged next-week actions. It is injected with a `CompletionFn` so it is pure and offline-
// testable; the default impl (llm.ts) calls Anthropic. Output is untrusted: C3 catches fabricated
// / over-tier refs and the C5 text-leak sweep catches above-audience text. Because the drafter
// only ever sees ≤-audience signals, every claim it can cite is allowed-evidence-only — mixed
// admin/team/external claims cannot form, so no LLM `supportCheck` tier gate is needed (deferred).

import type { RunManifest } from "./manifest.js";
import type { EvidenceRef, Signal, Tier } from "./signal.js";
import { visibleTiers, type Audience, type EvidenceLedger, type LedgerEntry } from "./ledger.js";
import type { CorrectFn, VerifierFinding } from "./verifier.js";
import type { CompletionFn } from "./llm.js";

/** A proposed action for next week. Tier-tagged (who may see it) + approvable; feeds C6/C7. */
export interface NextWeekAction {
  title: string;
  tier: Tier;
  rationale: string;
  evidence?: EvidenceRef[];
}

export interface DraftResult {
  ledger: EvidenceLedger;
  nextWeekActions: NextWeekAction[];
}

const TIERS: ReadonlySet<string> = new Set<Tier>(["admin", "team", "external"]);
const isTier = (v: unknown): v is Tier => typeof v === "string" && TIERS.has(v);

/** Coerce an untrusted ref-like object into an EvidenceRef (or null). Tier must be a real tier;
 *  the verifier independently re-checks that the ref actually resolves to a manifest signal. */
function coerceRef(x: unknown): EvidenceRef | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.path !== "string" || !isTier(o.tier)) return null;
  const ref: EvidenceRef = { path: o.path, tier: o.tier };
  if (typeof o.row === "string") ref.row = o.row;
  return ref;
}

function coerceEntry(x: unknown): LedgerEntry | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.claim !== "string") return null;
  const evidence = Array.isArray(o.evidence)
    ? o.evidence.map(coerceRef).filter((r): r is EvidenceRef => r !== null)
    : [];
  return { claim: o.claim, evidence };
}

const TIER_RANK: Record<Tier, number> = { external: 0, team: 1, admin: 2 };

/** Coerce + tier-clamp an untrusted action. The action's tier is DERIVED from its evidence (the
 *  most-restrictive evidence tier) rather than trusting the drafter's self-reported label, so a
 *  team-derived action can't be over-broadened to `external` for `mergeActions`/downstream C6.
 *  Evidence is tier-filtered to ≤ audience; an action with no allowed evidence is dropped. */
function coerceAction(x: unknown, audience: Audience): NextWeekAction | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title.trim()) return null;
  const visible = visibleTiers(audience);

  const allEvidence = Array.isArray(o.evidence)
    ? o.evidence.map(coerceRef).filter((r): r is EvidenceRef => r !== null)
    : [];
  // Drop above-audience evidence (a fabricated tier can't sneak an admin ref into a shareable action).
  const evidence = allEvidence.filter((r) => visible.has(r.tier));

  // Tier = most-restrictive surviving evidence tier; fall back to the clamped self-reported tier
  // only when there is no evidence to derive from.
  let tier: Tier;
  if (evidence.length) {
    tier = evidence.reduce<Tier>(
      (acc, r) => (TIER_RANK[r.tier] > TIER_RANK[acc] ? r.tier : acc),
      evidence[0]!.tier
    );
  } else {
    const reported: Tier = isTier(o.tier) ? o.tier : "team";
    if (!visible.has(reported)) return null;
    tier = reported;
  }

  const action: NextWeekAction = {
    title: o.title,
    tier,
    rationale: typeof o.rationale === "string" ? o.rationale : "",
  };
  if (evidence.length) action.evidence = evidence;
  return action;
}

// JSON schema for the forced structured tool call (see llm.ts). Advisory for fakes.
const DRAFT_SCHEMA: Record<string, unknown> = {
  type: "object",
  required: ["claims", "actions"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        required: ["claim", "evidence"],
        properties: {
          claim: { type: "string" },
          evidence: {
            type: "array",
            items: {
              type: "object",
              required: ["path", "tier"],
              properties: {
                path: { type: "string" },
                row: { type: "string" },
                tier: { type: "string", enum: ["admin", "team", "external"] },
              },
            },
          },
        },
      },
    },
    actions: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "tier", "rationale"],
        properties: {
          title: { type: "string" },
          tier: { type: "string", enum: ["admin", "team", "external"] },
          rationale: { type: "string" },
        },
      },
    },
  },
};

/** Render the projected signals as the catalogue the drafter must cite from (refs copied exactly). */
function signalCatalogue(projection: RunManifest): string {
  return (projection.signals ?? [])
    .map((s, i) => {
      const ref = JSON.stringify({ path: s.ref.path, row: s.ref.row, tier: s.ref.tier });
      return `#${i} [${s.kind}/${s.tier}] ${s.summary}\n    ref=${ref}`;
    })
    .join("\n");
}

function draftSystemPrompt(audience: Audience): string {
  return [
    `You are drafting the weekly closeout DIGEST for the "${audience}" audience of an AIOS workspace.`,
    "You are given a catalogue of work SIGNALS already collected from the workspace — draft ONLY from them.",
    "Rules:",
    "- Every claim MUST cite >=1 evidence ref COPIED EXACTLY from a catalogue signal's `ref` (path, row, tier).",
    "- Never invent a path, row, or tier. Never cite a ref that is not in the catalogue.",
    "- A claim's text must be SUPPORTED BY its cited signals' summaries — do not add facts not present in them.",
    "- Write a concise, honest digest: what happened, what shipped, what decisions were made.",
    "- Propose next-week actions, each tier-tagged (use the tier of its supporting signal).",
    "Return the structured result via the `emit` tool.",
  ].join("\n");
}

/** LLM drafter: audience projection → grounded ledger + tier-tagged actions. Untrusted output. */
export async function draftShareable(opts: {
  projection: RunManifest;
  audience: Audience;
  complete: CompletionFn;
}): Promise<DraftResult> {
  const { projection, audience, complete } = opts;
  const out = await complete({
    system: draftSystemPrompt(audience),
    user: `Signal catalogue (${projection.signals?.length ?? 0} signals):\n${signalCatalogue(projection)}`,
    schema: DRAFT_SCHEMA,
  });
  return normalizeDraft(out, audience);
}

/** Coerce an untrusted drafter output object into a DraftResult. */
function normalizeDraft(out: unknown, audience: Audience): DraftResult {
  const o = (out ?? {}) as Record<string, unknown>;
  const entries = Array.isArray(o.claims)
    ? o.claims.map(coerceEntry).filter((e): e is LedgerEntry => e !== null && e.evidence.length > 0)
    : [];
  const nextWeekActions = Array.isArray(o.actions)
    ? o.actions.map((a) => coerceAction(a, audience)).filter((a): a is NextWeekAction => a !== null)
    : [];
  return { ledger: { entries }, nextWeekActions };
}

/** Deterministic OFFLINE drafter: one grounded claim per projected signal (refs copied exactly),
 *  and a candidate action per open carryover/task signal. No LLM, no egress. */
export function stubDraftShareable(projection: RunManifest, audience: Audience): DraftResult {
  const signals = projection.signals ?? [];
  const entries: LedgerEntry[] = signals.map((s) => ({
    claim: s.summary || `${s.kind} signal`,
    evidence: [
      {
        path: s.ref.path,
        ...(s.ref.row !== undefined ? { row: s.ref.row } : {}),
        tier: s.ref.tier,
      },
    ],
  }));
  const nextWeekActions: NextWeekAction[] = signals
    .filter((s) => s.kind === "carryover" || s.kind === "task")
    .map((s) => actionFromSignal(s, "open item carried into next week"))
    .filter((a): a is NextWeekAction => a !== null && visibleTiers(audience).has(a.tier));
  return { ledger: { entries }, nextWeekActions };
}

function actionFromSignal(s: Signal, rationale: string): NextWeekAction | null {
  if (!s.summary) return null;
  return {
    title: s.summary,
    tier: s.ref.tier,
    rationale,
    evidence: [
      {
        path: s.ref.path,
        ...(s.ref.row !== undefined ? { row: s.ref.row } : {}),
        tier: s.ref.tier,
      },
    ],
  };
}

/**
 * Deterministic OWNER/admin next-week actions derived from the FULL LOCAL manifest (no LLM, no
 * egress): open admin-tier carryover/task signals surfaced as candidate actions. The owner brief
 * is the only place these appear. Richer admin synthesis is deferred to C6/C7.
 */
export function deriveAdminActions(fullManifest: RunManifest): NextWeekAction[] {
  return (fullManifest.signals ?? [])
    .filter((s) => s.tier === "admin" && (s.kind === "carryover" || s.kind === "task"))
    .map((s) => actionFromSignal(s, "open admin-tier item from this week"))
    .filter((a): a is NextWeekAction => a !== null);
}

/**
 * Build a bounded re-draft step for the verifier's `correct` seam. Closes over the audience
 * PROJECTION + audience so the re-draft can inspect real allowed signal summaries without reading
 * the workspace (the verifier seam itself only passes findings + ledger). Re-drafts failing claims
 * into allowed-evidence-only claims grounded in catalogue refs.
 */
export function makeCorrectFn(
  complete: CompletionFn,
  projection: RunManifest,
  audience: Audience
): CorrectFn {
  return async (findings: VerifierFinding[], ledger: EvidenceLedger): Promise<EvidenceLedger> => {
    const failingIdx = new Set(findings.map((f) => f.entryIndex));
    const failingPreviews = findings
      .map((f) => `- entry #${f.entryIndex} [${f.ruleId} ${f.check}]: ${f.detail}`)
      .join("\n");
    const out = await complete({
      system: [
        draftSystemPrompt(audience),
        "REVISION PASS: some claims failed verification (listed below). Re-draft so EVERY claim is",
        "grounded in catalogue refs copied exactly. If a claim cannot be supported by an allowed",
        "signal, DROP it. Return the FULL corrected claim set via `emit`.",
      ].join("\n"),
      user: [
        `Signal catalogue (${projection.signals?.length ?? 0} signals):`,
        signalCatalogue(projection),
        "",
        "Failing findings (audience-safe):",
        failingPreviews,
        "",
        `Current claim count: ${ledger.entries?.length ?? 0}. Failing indices: ${[...failingIdx].join(", ")}.`,
      ].join("\n"),
      schema: DRAFT_SCHEMA,
    });
    return normalizeDraft(out, audience).ledger;
  };
}
