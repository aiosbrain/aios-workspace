// C5 weekly closeout orchestrator — the heavy weekly cadence and the M1 payoff.
//
// One run: full 7-day manifest → draft → C3 verify + bounded correction → render TWO artifacts
// (private owner brief + shareable digest) at the correct tiers → next-week actions. The drafter
// is untrusted; tier-safety is deterministic (tier-bounded input + C3 verifier + the C5 text-leak
// sweep). See docs/v1-operator-loop/c5-weekly.md and .claude/rubrics/operator-loop-c5.md.
//
// SEQUENCING: a SEPARATE per-audience pipeline (project → draft → verify/correct → render), one
// ledger per audience, never shared. The owner brief is composed LOCALLY (no LLM on admin
// content). The corrected ledger is used in-process only and never serialized to a shareable path.

import { createHash } from "node:crypto";
import type { RunManifest } from "./manifest.js";
import type { Tier } from "./signal.js";
import {
  redactForTier,
  type Audience,
  type EvidenceLedger,
  type WithheldSummary,
} from "./ledger.js";
import { runVerificationWithLedger, type VerifierResult, type VerifierStatus } from "./verifier.js";
import type { CompletionFn } from "./llm.js";
import {
  draftShareable,
  stubDraftShareable,
  makeCorrectFn,
  deriveAdminActions,
  type DraftResult,
  type NextWeekAction,
} from "./drafter.js";
import {
  projectManifest,
  withheldByTier,
  aboveAudienceStrings,
  aboveAudienceStringTiers,
} from "./project.js";
import { sweepForLeaks } from "./leak-sweep.js";
import { runtimeByTag, formatHours, type TagTotal } from "./time/runtime.js";
import type { Signal } from "./signal.js";

/** Filename the CLI always writes a non-empty leak report to, sibling to the digests in the same
 *  closeout dir — referenced by name (not full path, which closeout.ts doesn't know) from the
 *  FAILED-digest suppression message. AIO-363. */
export const LEAK_REPORT_FILENAME = "leak-report.json";

/**
 * One C5 leak-sweep withhold, admin-tier ONLY (never rendered to a shareable digest). Explains a
 * withhold well enough to debug it: which entry, the exact needle that matched, which tier it came
 * from, and a stable hash of the withheld snippet (so repeat runs / dedup don't require storing the
 * raw snippet twice). AIO-363: this is what `digest-<aud>.FAILED.md` and the CLI summary now point
 * to instead of "review the owner brief" — the brief has no leak detail at all.
 */
export interface LeakReportEntry {
  audience: ShareableAudience;
  kind: "claim" | "action" | "whole-document";
  /** e.g. "claim:2", "action:0", "whole-document" — positional within THIS audience's render. */
  entryId: string;
  /** The exact above-audience needle (`aboveAudienceStrings`) that matched. Admin-tier content —
   *  fine here (this report is owner-only, same trust boundary as brief.md), essential for triage. */
  matchedString: string;
  /** The tier of the signal the matched needle originated from. */
  sourceTier: Tier;
  /** sha256 (first 16 hex chars) of the withheld snippet — a stable fingerprint without duplicating
   *  a second full copy of the (possibly large) withheld text in the report. */
  snippetHash: string;
}

function snippetHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export type ShareableAudience = "team" | "external";

export interface ShareableResult {
  audience: ShareableAudience;
  /** Audience-safe rendered digest (markdown). Safe to write to a shareable file ON PASS/CORRECTED. */
  digestMarkdown: string;
  /** Audience-safe verifier result (the C3 contract — no raw ledger/admin content). */
  result: VerifierResult;
  status: VerifierStatus;
  /** false when status is `failed` OR any claim/action had to be withheld by the leak sweep. */
  shippable: boolean;
  /** How many claims/actions the deterministic C5 text-leak sweep withheld (a tier-safety event). */
  leakWithheld: number;
  /** Shareable next-week actions (already tier ≤ audience). */
  nextWeekActions: NextWeekAction[];
  /** Admin-tier detail behind every `leakWithheld` increment (AIO-363) — empty when leakWithheld
   *  is 0. Never render this into a shareable artifact; it exists to make FAILED digests and the
   *  CLI summary debuggable, since the owner brief carries no leak information at all. */
  leakReport: LeakReportEntry[];
}

export interface CloseoutResult {
  /** OWNER-ONLY: the private operator brief (markdown, contains admin content). Write to disk
   *  under .aios/loop/ only — NEVER serialize to stdout/JSON for a shared audience. */
  briefMarkdown: string;
  /** OWNER-ONLY: full next-week actions (shareable merged + deterministic admin candidates). */
  ownerNextWeekActions: NextWeekAction[];
  /** Owner verifier status (the brief is grounded by construction; this is the badge). */
  ownerStatus: VerifierStatus;
  shareables: ShareableResult[];
}

// Tier breadth: external is visible to the MOST audiences (broadest), admin the fewest.
const TIER_BREADTH: Record<Tier, number> = { external: 0, team: 1, admin: 2 };
const normalizeTitle = (t: string) => t.trim().toLowerCase().replace(/\s+/g, " ");

/** Dedupe actions across pipelines by normalized title; on a clash keep the BROADEST visibility. */
function mergeActions(lists: NextWeekAction[][]): NextWeekAction[] {
  const byTitle = new Map<string, NextWeekAction>();
  for (const list of lists) {
    for (const a of list) {
      const key = normalizeTitle(a.title);
      const prev = byTitle.get(key);
      if (!prev || TIER_BREADTH[a.tier] < TIER_BREADTH[prev.tier]) byTitle.set(key, a);
    }
  }
  return [...byTitle.values()];
}

function statusBadge(status: VerifierStatus): string {
  return status === "pass" ? "PASS" : status === "corrected" ? "CORRECTED" : "FAILED";
}

function renderWithheld(withheld: WithheldSummary[]): string {
  if (!withheld.length) return "";
  const parts = withheld.map(
    ({ tier, count }) => `${count} ${tier}-tier source${count === 1 ? "" : "s"}`
  );
  return `\n_Withheld from this audience: ${parts.join(", ")}._\n`;
}

function renderActions(actions: NextWeekAction[]): string {
  if (!actions.length) return "_No next-week actions proposed._\n";
  return (
    actions
      .map((a) => `- [${a.tier}] ${a.title}${a.rationale ? ` — ${a.rationale}` : ""}`)
      .join("\n") + "\n"
  );
}

/** Extract { tag, durationMin } from time signals — the ONLY shape that reaches a shareable digest
 *  (no repo/alias, id, path, or session). AIO-139. */
function timeTotals(signals: Signal[]): TagTotal[] {
  return runtimeByTag(
    signals
      .filter((s) => s.kind === "time")
      .map((s) => ({
        tag: typeof s.payload?.tag === "string" ? s.payload.tag : "engineering",
        durationMin: typeof s.payload?.durationMin === "number" ? s.payload.durationMin : 0,
      }))
  );
}

/** Deterministic runtime-by-tag section (aggregate only). "" when there is no time to report. */
function renderRuntimeByTag(ran: TagTotal[]): string {
  if (!ran.length) return "";
  const total = ran.reduce((a, t) => a + t.durationMin, 0);
  return (
    `## Agent runtime (by tag)\n_Total ${formatHours(total)} · native session capture_\n` +
    ran.map((t) => `- ${t.tag}: ${formatHours(t.durationMin)}`).join("\n") +
    "\n"
  );
}

/**
 * Run one shareable-audience pipeline. `complete` undefined → deterministic offline stub drafter.
 */
export async function runShareable(opts: {
  fullManifest: RunManifest;
  audience: ShareableAudience;
  complete?: CompletionFn;
}): Promise<ShareableResult> {
  const { fullManifest, audience, complete } = opts;
  const fullProjection = projectManifest(fullManifest, audience);
  // Partition kind:"time" out of EVERY drafter / verifier / catalogue path (AIO-139): a time row's
  // ref, id, alias, or payload must never become a claim or reach the LLM. It is rendered ONLY as a
  // deterministic { tag, durationMin } aggregate below. projectManifest already stripped
  // admin/above-audience rows, so this sums only ≤-audience blocks.
  const ran = timeTotals(fullProjection.signals);
  const projection: RunManifest = {
    ...fullProjection,
    signals: fullProjection.signals.filter((s) => s.kind !== "time"),
  };
  const aboveStrings = aboveAudienceStrings(fullManifest, audience);
  const aboveTiers = aboveAudienceStringTiers(fullManifest, audience);
  const withheld = withheldByTier(fullManifest, audience);
  const leakReport: LeakReportEntry[] = [];
  const recordLeak = (kind: LeakReportEntry["kind"], entryId: string, hits: string[], snippet: string) => {
    const hash = snippetHash(snippet);
    for (const matched of hits) {
      leakReport.push({
        audience,
        kind,
        entryId,
        matchedString: matched,
        sourceTier: aboveTiers.get(matched) ?? "admin",
        snippetHash: hash,
      });
    }
  };

  const draft: DraftResult = complete
    ? await draftShareable({ projection, audience, complete })
    : stubDraftShareable(projection, audience);

  const { result, ledger: corrected } = await runVerificationWithLedger({
    manifest: projection, // verify against the ≤-audience projection: refs can't resolve above audience
    ledger: draft.ledger,
    audience,
    cadence: "weekly",
    correct: complete ? makeCorrectFn(complete, projection, audience) : undefined,
  });

  // ── Render the digest from the POST-correction ledger, with a per-claim text-leak sweep. ──
  let leakWithheld = 0;
  const claimLines: string[] = [];
  let claimIdx = 0;
  for (const entry of corrected.entries ?? []) {
    const idx = claimIdx++;
    const r = redactForTier(entry, audience);
    if (!r.emit) {
      // Already a content-free placeholder (admin-only evidence) — a normal redaction, not a leak.
      claimLines.push(`- ${r.entry.claim}`);
      continue;
    }
    // The C3 gap: claim text may quote above-audience content even with an allowed ref. Withhold it.
    const claimHits = sweepForLeaks(r.entry.claim, aboveStrings);
    if (claimHits.length > 0) {
      leakWithheld++;
      recordLeak("claim", `claim:${idx}`, claimHits, r.entry.claim);
      claimLines.push("- [withheld — claim text referenced above-audience material]");
      continue;
    }
    const cites = r.entry.evidence.map((e) => e.path).filter(Boolean);
    const citation = cites.length ? ` _(evidence: ${cites.join(", ")})_` : "";
    claimLines.push(`- ${r.entry.claim}${citation}`);
  }

  // Sweep the shareable actions (their titles/rationales are drafter free text), and STRIP their
  // evidence refs entirely — an audience-facing action carries no ref, so a fabricated/above-
  // audience ref can never reach the digest or the `--json` payload.
  const safeActions = draft.nextWeekActions
    .filter((a, idx) => {
      const text = `${a.title} ${a.rationale}`;
      const hits = sweepForLeaks(text, aboveStrings);
      if (hits.length > 0) {
        leakWithheld++;
        recordLeak("action", `action:${idx}`, hits, text);
      }
      return hits.length === 0;
    })
    .map((a) => ({ title: a.title, tier: a.tier, rationale: a.rationale }));

  let shippable = result.status !== "failed" && leakWithheld === 0;

  let digestMarkdown = [
    `# Weekly digest — ${audience}`,
    `_${fullManifest.window.from.slice(0, 10)} → ${fullManifest.window.to.slice(0, 10)} · verifier: ${statusBadge(result.status)}${shippable ? "" : " · NOT SHIPPABLE"}_`,
    "",
    "## What happened",
    claimLines.length ? claimLines.join("\n") : "_No shareable claims._",
    renderWithheld(withheld),
    renderRuntimeByTag(ran),
    "## Next week",
    renderActions(safeActions),
  ].join("\n");

  // Belt-and-suspenders: the fully-rendered document must contain NO above-audience string. The
  // per-claim/per-action sweeps above should guarantee this; a residual hit is a "should never
  // happen" rendering bug — fail SAFE (suppress the body + mark non-shippable), never emit it.
  const wholeDocHits = sweepForLeaks(digestMarkdown, aboveStrings);
  if (wholeDocHits.length > 0) {
    shippable = false;
    leakWithheld++;
    recordLeak("whole-document", "whole-document", wholeDocHits, digestMarkdown);
    digestMarkdown = [
      `# Weekly digest — ${audience}`,
      `_${fullManifest.window.from.slice(0, 10)} → ${fullManifest.window.to.slice(0, 10)} · NOT SHIPPABLE_`,
      "",
      `_Digest suppressed: a residual tier-leak guard tripped during rendering. The owner brief has no leak detail — see ${LEAK_REPORT_FILENAME} in this closeout (entry id, matched string, source tier, snippet hash) to triage._`,
    ].join("\n");
  }

  return {
    audience,
    digestMarkdown,
    result,
    status: result.status,
    shippable,
    leakWithheld,
    nextWeekActions: safeActions,
    leakReport,
  };
}

/**
 * Full weekly closeout: per-audience shareable pipelines + a locally-composed owner brief.
 * `complete` undefined → offline (deterministic stub drafter, no egress).
 */
export async function runCloseout(opts: {
  fullManifest: RunManifest;
  shareableAudiences: ShareableAudience[];
  complete?: CompletionFn;
}): Promise<CloseoutResult> {
  const { fullManifest, shareableAudiences, complete } = opts;

  const shareables: ShareableResult[] = [];
  for (const audience of shareableAudiences) {
    shareables.push(await runShareable({ fullManifest, audience, complete }));
  }

  // ── Owner brief: verify a full-manifest owner ledger (grounded by construction), then render
  //    the honest internal picture locally. No LLM on admin content; owner sees every tier. ──
  const ownerProjectionFull = projectManifest(fullManifest, "owner"); // owner = all signals, excluded stripped
  // Same partition as the shareables: time is rendered as an aggregate, never a claim (AIO-139).
  const ownerRan = timeTotals(ownerProjectionFull.signals);
  const ownerProjection: RunManifest = {
    ...ownerProjectionFull,
    signals: ownerProjectionFull.signals.filter((s) => s.kind !== "time"),
  };
  const ownerDraft = stubDraftShareable(ownerProjection, "owner");
  const { result: ownerResult } = await runVerificationWithLedger({
    manifest: ownerProjection,
    ledger: ownerDraft.ledger,
    audience: "owner",
    cadence: "weekly",
  });

  const adminActions = deriveAdminActions(fullManifest);
  const ownerNextWeekActions = mergeActions([
    ...shareables.map((s) => s.nextWeekActions),
    ownerDraft.nextWeekActions,
    adminActions,
  ]);

  const briefMarkdown = renderBrief(
    fullManifest,
    ownerDraft.ledger,
    ownerNextWeekActions,
    ownerResult.status,
    ownerRan
  );

  return {
    briefMarkdown,
    ownerNextWeekActions,
    ownerStatus: ownerResult.status,
    shareables,
  };
}

/** Render the private operator brief (owner-only; contains admin content). Deterministic. */
function renderBrief(
  fullManifest: RunManifest,
  ledger: EvidenceLedger,
  actions: NextWeekAction[],
  status: VerifierStatus,
  ran: TagTotal[]
): string {
  const byTier = new Map<Tier, number>();
  for (const s of fullManifest.signals ?? []) byTier.set(s.tier, (byTier.get(s.tier) ?? 0) + 1);
  const tierLine = [...byTier.entries()].map(([t, n]) => `${t}:${n}`).join("  ") || "(none)";

  const claimLines = (ledger.entries ?? []).map((e) => {
    const cites = e.evidence.map((r) => r.path).filter(Boolean);
    return `- ${e.claim}${cites.length ? ` _(evidence: ${cites.join(", ")})_` : ""}`;
  });

  return [
    "---",
    "access: admin",
    "---",
    "",
    `# Private operator brief — ${fullManifest.member}`,
    `_${fullManifest.window.from.slice(0, 10)} → ${fullManifest.window.to.slice(0, 10)} · verifier: ${statusBadge(status)} · signals ${tierLine}_`,
    "",
    "> Owner-only. Contains admin-tier content. Never synced; never shared.",
    "",
    "## The honest picture",
    claimLines.length ? claimLines.join("\n") : "_No signals this week._",
    "",
    renderRuntimeByTag(ran),
    "## Next week",
    renderActions(actions),
  ].join("\n");
}
