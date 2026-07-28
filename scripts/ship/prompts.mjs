/**
 * ship/prompts.mjs — the stage-content builders for `aios ship`: the exact text sent to each
 * model at each pipeline stage (recon, spec-eval audit, plan, plan-review, GPT code review, safety
 * review), plus the plan-output parsers (`## Deferred` scope, title normalization) that interpret
 * what a stage returns.
 *
 * This module owns the invariant that every stage's contract is defined in exactly one place: the
 * `## Deferred (out of scope)` section every plan prompt demands is the same section
 * `parseDeferredScope` parses back out; the safety prompt's required token is the same
 * `SAFETY_APPROVED_TOKEN` the gate module checks for. Changing what a stage asks for and how its
 * answer is read are the same edit.
 *
 * Extracted verbatim from scripts/ship.mjs (AIO-560, wave 5 of the safety-unit-extraction pattern
 * — docs/v1-operator-loop/domains/safety-unit-extraction.md). No prompt wording, section contract,
 * or parsing rule is edited in this move.
 */
import { constitutionPromptLines } from "../constitution.mjs";
import { PLAN_READY_TOKEN } from "../relay-core.mjs";
import { formatFindings, extractSections } from "../spec-eval.mjs";
import { SAFETY_APPROVED_TOKEN } from "./gates.mjs";

// Parse the plan's `## Deferred (out of scope)` section into a list of normalized titles.
// Tolerates `## Deferred` without the parenthetical; strips checkbox markers; stops at the next
// heading or EOF; drops a lone `none`/empty. Pure; exported.
export function parseDeferredScope(planText, { maxLen = 200 } = {}) {
  const lines = String(planText ?? "").split("\n");
  let inSection = false;
  const titles = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (inSection) break; // next heading ends the section
      if (/^#{1,6}\s+deferred\b/i.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (!m) continue;
    let item = m[1].replace(/^\[[ xX]\]\s*/, "").trim();
    if (!item) continue;
    if (/^none\.?$/i.test(item)) continue;
    if (item.length > maxLen) item = item.slice(0, maxLen).trimEnd();
    titles.push(item);
  }
  return titles;
}
// A normalized title for dedup (lowercase, collapsed whitespace, trimmed trailing punctuation).
export function normalizeTitle(t) {
  return String(t ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}
const DEFERRED_CONTRACT = [
  "",
  "End your plan with this exact section (empty is allowed — use a single `- none` bullet):",
  "",
  "## Deferred (out of scope)",
  "- <one deferred follow-up per bullet, or `- none`>",
].join("\n");
export function buildReconPrompt(issue, { allowedFiles }) {
  return [
    `You are preparing a recon context pack for Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    "## Issue description",
    "",
    issue.description || "(no description)",
    "",
    "## Referenced repo files (git-tracked only)",
    "",
    allowedFiles.length ? allowedFiles.map((f) => `- ${f}`).join("\n") : "(none)",
    "",
    "Read the referenced files (read-only) and summarize the concrete implementation context a",
    "planner needs: the surfaces involved, the invariants to preserve, and the acceptance criteria.",
    "Do NOT write files. Output the context pack as markdown.",
  ].join("\n");
}
/** Compose the spec-readiness input from a Linear issue: title + description + comments. */
export function buildSpecTextFromIssue(issue) {
  const parts = [
    `# ${issue.identifier}: ${issue.title}`,
    "",
    issue.description || "(no description)",
  ];
  const comments = (issue.comments ?? []).filter((cm) => String(cm.body ?? "").trim());
  if (comments.length) {
    parts.push("", "## Issue comments", "");
    for (const cm of comments) {
      const who = cm.author?.name ?? cm.user?.name ?? "comment";
      parts.push(`### ${who}`, "", String(cm.body).trim(), "");
    }
  }
  return parts.join("\n");
}
// ── light loop helpers (AIO-398) ─────────────────────────────────────────────────────────────

/** Does a spec's leading YAML frontmatter carry `safety: true`? Parsed from the RAW spec body
 *  (the Linear issue description / spec file), whose frontmatter — when present — must open the
 *  text. A `---` used later as a markdown horizontal rule never matches. */
export function specSafetyFlag(text) {
  const m = String(text ?? "").match(/^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return false;
  return /^safety:\s*true\s*$/im.test(m[1]);
}
/** The spec sections that stand in for the plan in the light loop. */
const LIGHT_PLAN_SECTION_RE = /\b(interfaces?|implementation|acceptance)\b/i;
/** Compose the light loop's plan from a SPEC_READY spec: its Interfaces / Implementation /
 *  Acceptance sections are fed into the build prompt where the plan output normally goes
 *  (the spec IS the plan — the plan/plan_review stages are skipped by design). When none of
 *  the three sections is present the full spec text is included but prefixed with a prominent
 *  warning so the builder knows the contract is incomplete. Ends with an empty `## Deferred`
 *  section so follow-up capture (parseDeferredScope) stays a no-op. */
export function buildLightPlanFromSpec(specText, { issue } = {}) {
  const picked = extractSections(specText).filter(
    (s) => s.heading && LIGHT_PLAN_SECTION_RE.test(s.heading)
  );
  const parts = [
    `# Implementation plan${issue ? ` for ${issue}` : ""} (light loop — derived from the SPEC_READY spec)`,
    "",
    "This spec already passed `aios spec eval`; the plan/plan_review stages were skipped by",
    "design (`--loop light`). Treat the sections below as the approved plan, and the Acceptance",
    "section as the verification contract.",
    "",
  ];
  if (picked.length) {
    for (const s of picked) parts.push(`## ${s.heading}`, "", s.body.trim(), "");
  } else {
    parts.push(
      "",
      "**WARNING: Build contract incomplete.** No Interfaces / Implementation / Acceptance",
      "headings found in the SPEC_READY spec. The full spec text is included below as a",
      "fallback, but the plan may contain sections the light loop normally excludes.",
      "",
      "---",
      "",
      String(specText ?? "").trim(),
      "",
      "---"
    );
  }
  parts.push("## Deferred (out of scope)", "- none");
  return parts.join("\n");
}
/** Audit artifact for a spec-eval round (verdict + score + findings). */
export function formatSpecEvalAudit(res) {
  const lines = [
    "# Spec readiness evaluation",
    "",
    `- verdict: ${res.verdict}`,
    `- exit: ${res.exitCode}`,
    ...(res.score != null ? [`- score: ${res.score}`] : []),
    "",
    "## Findings",
    "",
    formatFindings(res.findings),
  ];
  return lines.join("\n");
}
// Per-file body cap for recon: file blobs are sliced to this many chars before injection so a
// single large file cannot dominate the recon prompt. Truncation is now marked, never silent.
export const RECON_FILE_CAP = 8000;
// Recon transparency: `extractRepoFileRefs` drops referenced files once its maxFiles/maxBytes caps
// are hit (reason "cap-exceeded"). Those drops land in the recon-skipped.md audit but NOT in the
// prompt, so the model plans as if nothing was omitted. This note surfaces the cap-exceeded drops
// to the model. Other skip reasons (not-tracked/denied/absolute/parent-traversal) are deliberate
// security filters, not truncation, so they stay out of the plan-context note. Pure; exported.
export function buildOmittedRefsNote(skipped) {
  const dropped = (skipped ?? []).filter((s) => s.reason === "cap-exceeded");
  if (!dropped.length) return "";
  return [
    "",
    "## Omitted references (NOT read — recon file caps exceeded)",
    "",
    `${dropped.length} referenced repo file(s) were dropped before reading because the recon caps`,
    "(max file count / total bytes) were hit. Treat the context as INCOMPLETE for these paths and",
    "call out where the plan depends on a file that was not read:",
    ...dropped.map((s) => `- \`${s.raw}\``),
  ].join("\n");
}
export function buildPlanPrompt(issue, contextPack, prevReview, constitution, builderContext) {
  const parts = [
    `You are a senior software architect. Produce a clear, numbered implementation plan for`,
    `Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    "## Task",
    "",
    issue.description || "(no description)",
    "",
    ...(builderContext?.skills?.length
      ? ["## Selected builder skills", "", builderContext.prompt, ""]
      : []),
    "## Recon context pack",
    "",
    contextPack || "(none)",
    "",
    "The context pack above was built from the live repo minutes ago — treat it as trusted",
    "ground truth. Do NOT re-explore surfaces it already covers; verify beyond it only where",
    "the plan hinges on a detail it does not settle. Budget your time for writing the plan.",
    ...constitutionPromptLines(constitution),
    DEFERRED_CONTRACT,
  ];
  if (prevReview) {
    parts.push(
      "",
      "## Reviewer feedback on your previous plan (address every Blocker/Major)",
      "",
      prevReview
    );
  }
  return parts.join("\n");
}
export function buildPlanReviewPrompt(
  plan,
  round,
  maxRounds,
  prevReview = null,
  builderSkillAudit = []
) {
  const isLast = round >= maxRounds;
  const roundNote = isLast
    ? `**Final round (${round}/${maxRounds}). Approve unless there is a Blocker.**`
    : `Round ${round} of ${maxRounds}.`;
  return [
    "/review-plan",
    "",
    `> ${roundNote}`,
    "",
    "## Plan to review",
    "",
    plan,
    "",
    ...(builderSkillAudit.length
      ? [
          "## Selected builder skill constraints",
          "",
          ...builderSkillAudit.map(
            (entry) => `- ${entry.id} sha256=${entry.sha256} bytes=${entry.bytes}`
          ),
          "",
          "Verify plan conformance to the applicable hard constraints above.",
          "",
        ]
      : []),
    // Regression guard (AIO-239 R5a): a revision round can silently revert a fix the previous
    // review already demanded and got — the reviewer must re-verify prior acceptances, not just
    // hunt new issues. (Observed live: round 3 reverted two accepted round-1 fixes.)
    ...(prevReview
      ? [
          "## Previously required changes (from the prior review round)",
          "",
          prevReview,
          "",
          "**Regression check: verify EVERY previously required change above is still honored in",
          "this revision. A silently reverted prior fix is a Blocker.**",
          "",
        ]
      : []),
    "---",
    "Review the plan. List any Blockers or approach-level Majors. Minor issues do not block.",
    `When the plan is ready to implement, place this token alone on the very last line:`,
    PLAN_READY_TOKEN,
  ].join("\n");
}
export function buildGptReviewPrompt(plan, prDiff, pr, constitution) {
  return [
    "/ai-code-review",
    "",
    `You are reviewing PR #${pr} against the approved plan below. Emit findings as`,
    "`- \\`severity\\` \\`file\\`: …` lines (Critical/High/Medium/Low).",
    "",
    "## Approved plan",
    "",
    plan,
    "",
    "## PR diff",
    "",
    prDiff || "(no diff)",
    ...constitutionPromptLines(constitution),
    ...(constitution
      ? ["", "A diff that violates the constitution above is a finding (severity by impact)."]
      : []),
  ].join("\n");
}
export function buildSafetyPrompt(diff, changedPaths) {
  return [
    "You are a safety reviewer for the AIOS workspace toolkit. The diff below touches a",
    "safety-critical surface (tier model, sync contract, secrets/leak gate, hooks, validators,",
    "or scaffold governance). Confirm EVERY tier/sync/secrets/hook invariant is preserved.",
    "",
    "## Changed safety-surface paths",
    "",
    changedPaths.map((p) => `- ${p}`).join("\n"),
    "",
    "## Diff",
    "",
    diff || "(no diff)",
    "",
    "---",
    `If (and ONLY if) every invariant is preserved, emit ${SAFETY_APPROVED_TOKEN} alone on the`,
    "very last line. Otherwise list what is unsafe and do NOT emit the token.",
  ].join("\n");
}
