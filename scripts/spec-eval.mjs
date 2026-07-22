/**
 * spec-eval.mjs — the spec/plan readiness harness (EE5 / AIO-171), packaged as
 * `aios spec eval|fix`. Two layers, gated by the spec-readiness rubric
 * (.claude/rubrics/spec-readiness.md):
 *
 *   1. DETERMINISTIC (zero-LLM, offline): structural presence/shape checks + real-path
 *      resolution against the repo tree. A deterministic must-fail is a hard blocker.
 *   2. ADVERSARIAL (LLM, opt-in): an independent evaluator REFUTES the spec — finds the
 *      underspecified corner a cold-start builder stumbles on. Emits a single verdict.
 *
 * The VERDICT is the only gate; the 0–100 score is advisory/reporting and never derives an
 * exit code. Exit codes: 0 SPEC_READY · 1 deterministic must-fail · 2 adversarial blocker ·
 * 3 NOT_EVALUATED (clean deterministic, LLM not run) · 4 usage/IO.
 *
 * Test seams (documented, PATH-fake analog for an SDK-backed CLI):
 *   AIOS_SPEC_EVAL_STUB — raw evaluator text (or a file path to it); bypasses the SDK call.
 *   AIOS_SPEC_FIX_STUB  — revised-spec text (or a file path to it); bypasses the SDK reviser.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { c } from "./relay-core.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { callPromptModel, requirePromptModelKey } from "./model-call.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_RUBRIC_REL = path.join(".claude", "rubrics", "spec-readiness.md");
// The canonical rubric shipped inside this toolkit checkout (…/aios-workspace/.claude/rubrics/…).
const TOOLKIT_RUBRIC_PATH = path.join(SCRIPT_DIR, "..", DEFAULT_RUBRIC_REL);
const DEFAULT_FIX_BUDGET = 2;
const SPEC_PROMPT_TIMEOUT_MS = 300_000;
export const SPEC_BATCH_CONCURRENCY_MAX = 8;

// The rule ids the deterministic layer can emit. The rubric↔code drift test asserts every
// deterministic must/conditional row in the rubric appears here (no silent divergence).
export const DETERMINISTIC_CHECK_IDS = new Set([
  "SR1",
  "SR2",
  "SR3",
  "SR4",
  "SR5",
  "SR6",
  "SR7",
  "SR10",
  "SR16",
  "SR17",
]);

// Spec-gate ENFORCEMENT policies (orthogonal to eval_tier, which selects layers):
//   block    — a NOT_READY verdict stops the build (default; the contract most specs want)
//   advisory — run the eval, record findings, WARN, but proceed to build regardless of verdict
//   off      — do not run the adversarial gate at all (named equivalent of --skip-spec-gate)
export const SPEC_GATE_POLICIES = new Set(["block", "advisory", "off"]);
export const DEFAULT_SPEC_GATE = "block";

// Adversarial-eval quorum: how many independent samples vote on the verdict. The evaluator is a
// stochastic LLM judge; a single roll can flip the gate. 3 samples + majority vote (with
// confirm-before-fail escalation) removes the flip while keeping the common ready path at one call.
// K=1 disables quorum (single pass — the semantics mocked/CI tests rely on).
export const DEFAULT_QUORUM = 3;

// ── rubric loading ──────────────────────────────────────────────────────────────────────────

/**
 * Parse the spec-readiness rubric: frontmatter (kind/applies_to/budget/pass) + the SR table.
 * Throws (loudly) on a missing/unreadable/malformed rubric — the caller maps that to exit 4.
 */
export function loadRubric(rubricPath) {
  if (!existsSync(rubricPath)) throw new Error(`rubric not found: ${rubricPath}`);
  let raw;
  try {
    raw = readFileSync(rubricPath, "utf8");
  } catch (e) {
    throw new Error(`cannot read rubric ${rubricPath}: ${e.message}`);
  }
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) throw new Error(`malformed rubric ${rubricPath}: missing YAML frontmatter`);
  const frontmatter = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) frontmatter[m[1]] = m[2].trim();
  }
  if (frontmatter.kind !== "rubric") {
    throw new Error(`malformed rubric ${rubricPath}: frontmatter kind must be 'rubric'`);
  }
  const budget = Number(frontmatter.budget);
  frontmatter.budget = Number.isInteger(budget) && budget >= 0 ? budget : DEFAULT_FIX_BUDGET;

  // Rows: table lines with 4 cells (ID | Criterion | Check method | Must), skipping the header
  // and the |---| separator. A rubric with no parseable SR row is malformed.
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((s) => s.trim());
    if (cells.length < 4) continue;
    const [id, criterion, method, must] = cells;
    if (!/^SR\d+$/.test(id)) continue; // header / separator / non-SR rows
    rows.push({ id, criterion, method, must });
  }
  if (rows.length === 0) {
    throw new Error(`malformed rubric ${rubricPath}: no SR criteria rows found`);
  }
  return { frontmatter, rows, raw, path: rubricPath };
}

/**
 * Resolve which rubric file to grade against, in precedence order:
 *   1. an explicit `--rubric <path>` (caller override, honored verbatim),
 *   2. the target repo's own `.claude/rubrics/spec-readiness.md` (scaffolded workspaces vendor it),
 *   3. the canonical rubric shipped inside this toolkit checkout.
 * The fallback (3) is what lets the spec gate run in a NON-workspace repo — the Team Brain, or any
 * bare repo — that doesn't vendor a rubric, instead of hard-failing with "rubric not found" (exit 4).
 */
export function resolveRubricPath(repo, explicit = null) {
  if (explicit) return explicit;
  const local = path.join(repo, DEFAULT_RUBRIC_REL);
  if (existsSync(local)) return local;
  return TOOLKIT_RUBRIC_PATH;
}

// ── text helpers ────────────────────────────────────────────────────────────────────────────

/** Split a spec into markdown sections { heading, level, body }. Content before the first
 *  heading is a section with an empty heading (the preamble). */
export function extractSections(specText) {
  const lines = String(specText).split("\n");
  const sections = [];
  let current = { heading: "", level: 0, body: "" };
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      sections.push(current);
      current = { heading: h[2].trim(), level: h[1].length, body: "" };
    } else {
      current.body += line + "\n";
    }
  }
  sections.push(current);
  return sections;
}

function extractBullets(body) {
  const out = [];
  for (const line of String(body).split("\n")) {
    const m = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (m && m[1].trim()) out.push(m[1].trim());
  }
  return out;
}

const VAGUE_RE =
  /\b(works?\s*(well)?|is\s+fast|blazing|good|great|nice(ly)?|properly|correct(ly)?|robust|clean|solid|reasonable|as expected|makes sense|user-?friendly|intuitive|smooth|feels?\s+\w+|seamless)\b/i;
const CONCRETE_RE =
  /(\bexit(s|ed)?\s*(code\s*)?\d|\breturns?\b|=>|->|\bprints?\b|\boutputs?\b|\bwrites?\b|\bpass(es|ed)?\b|\bassert\w*\b|\bregex\b|\bhttp\s*\d|\bstatus\s*\d|\b\d{2,}\b|--\w+|`[^`]+`|\.(ts|mjs|js|json|md|sh)\b|\bwhen\b[^.\n]*\bthen\b|\bgiven\b[^.\n]*\bwhen\b|\btest\b)/i;

/** Heuristic: is an acceptance criterion observable — does it name a concrete, checkable
 *  signal (exit code, output, named test, command, number) rather than a vibe ("works well")? */
export function looksObservable(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (!CONCRETE_RE.test(t)) return false;
  // Concrete signal present, but if the sentence is dominated by a vague qualifier with no
  // other substance, still treat it as vague (defends against "works, and fast — 100% good").
  const stripped = t.replace(CONCRETE_RE, "").trim();
  if (VAGUE_RE.test(t) && stripped.replace(VAGUE_RE, "").replace(/[\s,.;:]+/g, "").length < 3) {
    return false;
  }
  return true;
}

const SYNC_SURFACE_RE =
  /\b(the brain|team brain|to the brain|from the brain|aios push|aios pull|\/api\/v1|brain[ -]?api|syncs?\s+(to|outward|upward|the)|synced to|tier-?tagged push|push(es|ed|ing)?\s+(to\s+)?the\s+brain)\b/i;

/** Does the spec touch a sync/brain surface (the SR7 trigger)? */
export function touchesSyncSurface(specText) {
  return SYNC_SURFACE_RE.test(String(specText));
}

const KNOWN_EXT_RE = /\.(ts|tsx|mjs|cjs|js|jsx|json|md|sh|yaml|yml|py|txt)$/i;

function isPathCandidate(s) {
  if (!s) return false;
  if (/[*<>\s]/.test(s)) return false; // glob / <placeholder> / multi-word
  if (s.includes("://")) return false; // url
  if (s.includes("/") && /^[\w./@-]+$/.test(s) && KNOWN_EXT_RE.test(s)) return true; // path with ext
  if (!s.includes("/") && /^[\w.-]+$/.test(s) && KNOWN_EXT_RE.test(s)) return true; // bare filename.ext
  return false;
}

function normalizePath(p) {
  return String(p)
    .replace(/^\.\//, "")
    .replace(/[.,;:)]+$/, "");
}

function backtickSpans(line) {
  const out = [];
  const re = /`([^`]+)`/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1].trim());
  return out;
}

/** Find file-path references in a spec, tagged with the section + line context they appear in.
 *  Globs and <placeholder> paths are excluded. */
export function findReferencedPaths(specText) {
  const lines = String(specText).split("\n");
  const refs = [];
  let heading = "";
  lines.forEach((line, i) => {
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h) {
      heading = h[1].trim();
      return;
    }
    for (const span of backtickSpans(line)) {
      if (isPathCandidate(span)) {
        refs.push({ path: normalizePath(span), line: i + 1, section: heading, lineText: line });
      }
    }
  });
  return refs;
}

function pathResolves(repo, p) {
  if (!repo) return true; // no repo to resolve against — do not manufacture a blocker
  return existsSync(path.join(repo, p));
}

/** Classify the context an unresolved path appears in (SR3 section-awareness):
 *  'existing' → a hard blocker (named as existing code), 'new'/'ambiguous' → advisory. */
export function classifyPathContext(ref) {
  const heading = ref.section || "";
  const text = ref.lineText || "";
  if (
    /\b(reuse|integrat|builds?\s+on|extend|existing|modif|touch)/i.test(heading) ||
    /\b(reuses?|extends?|builds?\s+on|based\s+on|integrat\w*|existing|modif\w*|already\s+in)\b/i.test(
      text
    )
  ) {
    return "existing";
  }
  if (
    /\b(implement|task|step|new\s+file|create|scaffold)/i.test(heading) ||
    /\b(new\s+file|creates?|adds?\b|writes?\b|scaffold|stub)\b/i.test(text)
  ) {
    return "new";
  }
  return "ambiguous";
}

function findArchitectureClaims(specText) {
  const lines = String(specText).split("\n");
  const claims = [];
  lines.forEach((line, i) => {
    if (!/\b(reuses?|extends?|builds?\s+on|based\s+on)\b/i.test(line)) return;
    const paths = backtickSpans(line).filter(isPathCandidate).map(normalizePath);
    if (paths.length) claims.push({ text: line.trim(), paths, line: i + 1 });
  });
  return claims;
}

// ── SR17: increment-bound (scope-size) assessment ─────────────────────────────────────────────
// A spec that enumerates many tasks AND spans many unrelated top-level surfaces deterministically
// becomes a large, multi-fix PR (the observed batch-size → fix-round curve). SR17 flags that shape
// structurally, before any code is written, and is model-agnostic (a Codex- or Claude-authored spec
// is held to the same bar).

export const SR17_TASK_LIMIT = 6; // enumerated tasks in the implementation/tasks section
export const SR17_SURFACE_LIMIT = 3; // distinct top-level code surfaces the spec touches

// A heading that introduces an enumerated build breakdown (tasks / steps / implementation / plan).
const SR17_TASK_HEADING_RE =
  /\b(tasks?|implementation|steps?|plan|deliverables?|work\s*items?|to-?dos?|milestones?)\b/i;

// Top-level surfaces of this toolkit. Mixing >SR17_SURFACE_LIMIT of these in one spec is the
// mixed-concern signal (e.g. PR #365: gui + inbox + scripts in one change). `.claude/`, config, and
// bare filenames are intentionally NOT surfaces — they are cross-cutting and would over-trip.
// `test/`, `docs/`, and `scaffold/` are also NOT surfaces: a thorough single-feature spec dutifully
// names its test file, docs page, and scaffold mirror — those references measure spec completeness,
// not mixed concerns, and counting them made SR17 hard-block well-bounded specs (2026-07-22).
const SR17_SURFACES = [
  ["gui/client", /^gui\/client\b/],
  ["gui/server", /^gui\/server\b/],
  ["scripts", /^scripts\b/],
  ["src/operator-loop", /^src\/operator-loop\b/],
  ["src", /^src\b(?!\/operator-loop)/],
  ["hooks", /^hooks\b/],
  ["validation", /^validation\b/],
];

// An explicit statement that the author has bounded the increment to one PR.
const SR17_INCREMENT_RE =
  /\b(one\s+pr|single\s+pr|this\s+pr\b|one\s+increment|line\s+budget|~?\d{2,4}\s*(loc|lines)\b|follow-?ups?\s+(are\s+)?deferred|sibling\s+spec|split\s+into\s+\w+\s+spec|first\s+slice|slice\s+\d|one\s+surface)\b/i;

/**
 * Structurally assess whether a spec is bounded to one reviewable PR. Pure + deterministic so it can
 * be unit-tested directly. Returns { taskCount, surfaces, incrementStated }.
 *   - taskCount: bullets under the largest task/implementation/steps section (0 if none).
 *   - surfaces: sorted distinct top-level code surfaces named by the spec's file references.
 *   - incrementStated: whether the spec explicitly declares a one-PR / deferred-follow-ups boundary.
 */
export function assessScopeBound(specText) {
  const sections = extractSections(specText);
  let taskCount = 0;
  for (const s of sections) {
    if (SR17_TASK_HEADING_RE.test(s.heading)) {
      taskCount = Math.max(taskCount, extractBullets(s.body).length);
    }
  }
  const surfaces = new Set();
  for (const ref of findReferencedPaths(specText)) {
    for (const [name, re] of SR17_SURFACES) {
      if (re.test(ref.path)) {
        surfaces.add(name);
        break;
      }
    }
  }
  return {
    taskCount,
    surfaces: [...surfaces].sort(),
    incrementStated: SR17_INCREMENT_RE.test(specText),
  };
}

// ── deterministic layer ─────────────────────────────────────────────────────────────────────

/**
 * Run the deterministic readiness checks. Returns findings [{ ruleId, severity, detail, line?,
 * layer:'deterministic' }]. `severity:'blocker'` is a must-fail (drives exit 1); `'minor'` is
 * advisory. `repo` roots real-path resolution (SR3/SR16); omit it to skip path checks.
 */
export function runDeterministicChecks(specText, { repo } = {}) {
  const findings = [];
  const add = (ruleId, severity, detail, extra = {}) =>
    findings.push({ ruleId, severity, detail, layer: "deterministic", ...extra });
  const sections = extractSections(specText);
  const hasHeading = (re) => sections.some((s) => re.test(s.heading));

  // SR1 — what / why present
  const whyPresent =
    hasHeading(
      /\b(why|purpose|motivation|rationale|overview|summary|goal|what|context|problem)\b/i
    ) || /^\s*(why|what)\b\s*[:—-]/im.test(specText);
  if (!whyPresent) {
    add("SR1", "blocker", "no what/why: the behavior and the reason it matters are not stated");
  }

  // SR2 — acceptance criteria present + observable
  const acceptanceSection = sections.find((s) =>
    /\b(accept|success crit|done when|definition of done|acceptance)\b/i.test(s.heading)
  );
  const acceptanceInline =
    /\b(acceptance criteria|success criteria|definition of done|done when)\b/i.test(specText);
  if (!acceptanceSection && !acceptanceInline) {
    add("SR2", "blocker", "no acceptance criteria: nothing a builder can self-verify against");
  } else {
    const body = acceptanceSection
      ? acceptanceSection.body
      : specText.slice(
          specText.search(
            /\b(acceptance criteria|success criteria|definition of done|done when)\b/i
          )
        );
    const bullets = extractBullets(body);
    if (bullets.length === 0) {
      add("SR2", "blocker", "acceptance section present but has no itemized criteria");
    } else if (!bullets.some(looksObservable)) {
      add(
        "SR2",
        "blocker",
        `acceptance criteria present but none appear observable (e.g. "${bullets[0].slice(0, 60)}") — state exit codes, outputs, or named tests`
      );
    }
  }

  // SR3 — integration points resolve to real files (section-aware)
  for (const ref of findReferencedPaths(specText)) {
    if (pathResolves(repo, ref.path)) continue;
    if (classifyPathContext(ref) === "existing") {
      add(
        "SR3",
        "blocker",
        `integration point does not resolve: \`${ref.path}\` is named as existing code but no such file is in the repo`,
        { line: ref.line }
      );
    } else {
      add(
        "SR3",
        "minor",
        `path \`${ref.path}\` does not resolve — fine if it is a new file to create, but verify the path/parent dir`,
        { line: ref.line }
      );
    }
  }

  // SR16 — no ungrounded architecture claims ("reuses X / extends Y" → real file)
  for (const claim of findArchitectureClaims(specText)) {
    for (const p of claim.paths) {
      if (!pathResolves(repo, p)) {
        add(
          "SR16",
          "blocker",
          `ungrounded architecture claim: "${claim.text.slice(0, 70)}" references \`${p}\`, which does not resolve to a real file`,
          { line: claim.line }
        );
      }
    }
  }

  // SR4 — dependencies declared (or "none" explicit)
  const depsPresent =
    hasHeading(/\bdep(s|endenc)/i) ||
    /\b(deps?|dependenc\w*)\b\s*[:—-]/i.test(specText) ||
    /\bdepends on\b/i.test(specText) ||
    /\b(no dependencies|deps?:?\s*none|dependencies:?\s*none)\b/i.test(specText);
  if (!depsPresent) {
    add(
      "SR4",
      "blocker",
      'dependencies not declared — state which slices must land first, or "Deps: none" explicitly'
    );
  }

  // SR5 — scope + deferred stated
  const scopePresent =
    hasHeading(/\b(scope|deferred|out of scope|non-?goals|not doing)\b/i) ||
    /\b(out of scope|deferred|non-?goals?|in scope)\b/i.test(specText);
  if (!scopePresent) {
    add("SR5", "blocker", "scope/deferred not stated — declare what is in and what is cut");
  }

  // SR17 — increment-bounded: the spec is one reviewable PR. Blocks only when BOTH structural
  // heuristics trip (unambiguously oversized — the mixed-concern, many-task shape) AND the author
  // has not explicitly bounded the increment; an explicit one-PR statement downgrades the block to
  // advisory (the author has made the call — the gate informs, it doesn't overrule). A single trip
  // is advisory, and a bounded spec that simply omits an increment statement is a gentle nudge.
  {
    const scope = assessScopeBound(specText);
    const tooManyTasks = scope.taskCount > SR17_TASK_LIMIT;
    const tooManySurfaces = scope.surfaces.length > SR17_SURFACE_LIMIT;
    if (tooManyTasks && tooManySurfaces) {
      add(
        "SR17",
        scope.incrementStated ? "minor" : "blocker",
        `scope too broad for one reviewable PR: ${scope.taskCount} enumerated tasks across ${scope.surfaces.length} surfaces (${scope.surfaces.join(", ")})${scope.incrementStated ? " — increment statement present, verify the split holds" : " — split into sequential one-PR specs, each landing on its own"}`
      );
    } else if (tooManyTasks) {
      add(
        "SR17",
        "minor",
        `${scope.taskCount} enumerated tasks (> ${SR17_TASK_LIMIT}) — consider splitting into sequential specs so each lands as one small PR`
      );
    } else if (tooManySurfaces) {
      add(
        "SR17",
        "minor",
        `spec spans ${scope.surfaces.length} top-level surfaces (${scope.surfaces.join(", ")}) — mixed-concern specs become large PRs; consider one surface per spec`
      );
    } else if (!scope.incrementStated && (scope.taskCount >= 4 || scope.surfaces.length >= 3)) {
      // Only nudge for a missing increment statement once the spec is moderately sized — a small,
      // single-surface spec is self-evidently one PR and does not need the ceremony.
      add(
        "SR17",
        "minor",
        'no explicit increment statement — add a line budget or "one PR; follow-ups deferred to a sibling spec" so scope stays bounded'
      );
    }
  }

  // SR6 — build-with tier present
  const buildWithPresent =
    hasHeading(/build-?with/i) ||
    /\bbuild-?with\b\s*[:—-]/i.test(specText) ||
    /\b(build-?with|model\/effort|effort tier)\b/i.test(specText) ||
    /\b(claude-?opus|claude-?sonnet|claude-?haiku|opus|sonnet|haiku|fable)\b[^.\n]*\b(low|medium|high|xhigh|max)\b/i.test(
      specText
    );
  if (!buildWithPresent) {
    add(
      "SR6",
      "blocker",
      "build-with tier missing — state the model/effort the work deserves (e.g. opus / high)"
    );
  }

  // SR7 — tier-safety posture when a sync/brain surface is touched (conditional)
  if (touchesSyncSurface(specText)) {
    const tierStated =
      /\b(tier|admin|team|external|access:|default-deny|422|tier-?tag\w*|tier-?safe\w*|never syncs?)\b/i.test(
        specText
      );
    if (!tierStated) {
      add(
        "SR7",
        "blocker",
        "touches a sync/brain surface but states no tier-safety posture (admin/team/external, default-deny)"
      );
    }
  }

  // SR10 — signal-contract reference when signals are emitted (conditional)
  if (
    /\bemit\w*\b[^.\n]*\bsignal|tier-?tagged\s+signal|manifest\.signals|signal contract/i.test(
      specText
    )
  ) {
    const contractRef =
      /\b(signal\.ts|evidenceref|signal shape|tier-?tagged|manifest\.signals|signal contract|src\/operator-loop\/signal)\b/i.test(
        specText
      );
    if (!contractRef) {
      add(
        "SR10",
        "blocker",
        "emits signals but does not reference the tier-tagged signal contract/shape"
      );
    }
  }

  return findings;
}

// ── adversarial layer ───────────────────────────────────────────────────────────────────────

const EVAL_SYSTEM = [
  "You are a spec-readiness checklist reviewer. Your job is to evaluate a spec against each",
  "LLM-read rubric criterion below. For EACH criterion that applies, return PASS or FAIL with",
  "evidence quoted from the spec. Do NOT summarize the spec. Do NOT assign an overall score",
  "— the score is derived mechanically from your per-criterion results.",
  "",
  "Process every criterion in order. For each one:",
  "1. Determine if the criterion's trigger fires (for conditional criteria like SR7, SR10).",
  "2. If it does not fire, record `trigger:false` — no finding needed.",
  "3. If it fires, read the spec for evidence and return PASS or FAIL.",
  "4. For FAIL: include the exact quote and a one-sentence why + suggestion.",
  "5. For PASS: include the exact quote that proves the criterion is met.",
  "",
  "Severity mapping:",
  '- A criterion marked `must` that FAILs → `severity:"blocker"`',
  "- A criterion marked `must` that PASSes → no finding",
  '- A criterion marked `advisory` that FAILs → `severity:"minor"`',
  '- A criterion marked `conditional` with trigger fired that FAILs → `severity:"blocker"`',
  "- A criterion marked `conditional` with trigger not fired → `trigger:false`, no finding",
  "",
  "A blocker finding on any `must` or triggered `conditional` criterion forces NOT_READY.",
  "Recoverability principle: a choice the builder makes whose output is human-reviewed before merge",
  "is RECOVERABLE — do not FAIL a criterion merely because the builder must design something. Reserve",
  "blockers for gaps with no downstream catch (unstated targets, missing prerequisites, ambiguous",
  "external contracts).",
  "Deterministic findings are given in-context — do NOT repeat those rule IDs.",
  "",
  "Return a SINGLE JSON object and nothing else (no prose, no code fence):",
  '{"verdict":"SPEC_READY"|"NOT_READY","score":0-100,"findings":[',
  '{"ruleId":"SR8","severity":"blocker"|"major"|"minor","quote":"…","why":"…","suggestion":"…"}]}',
].join(" ");

function buildEvalPrompt(specText, rubric, deterministic, decisions) {
  const detText = deterministic.length
    ? deterministic.map((f) => `- [${f.ruleId}/${f.severity}] ${f.detail}`).join("\n")
    : "- (none)";
  const decText =
    decisions && decisions.length
      ? decisions
          .map((d) => `- ${d.question}${d.choice?.length ? ` → ${d.choice.join(", ")}` : ""}`)
          .join("\n")
      : "- (none)";
  return [
    "## Checklist — evaluate each criterion that applies",
    "",
    "For each SR criterion below, read the spec and return a pass/fail judgment with evidence.",
    "Skip criteria whose trigger does not fire (record trigger:false).",
    "",
    "| ID | What to check | Must |",
    "|----|---------------|------|",
    "| SR2-quality | Are acceptance criteria observable and specific — not vague? Does each criterion state a concrete exit code, file check, or grep-able output? | yes |",
    "| SR7-adequacy | If the spec touches a sync/brain surface: is the tier-safety posture specific (names tiers, states default-deny, references 422)? | conditional |",
    "| SR8 | Is the spec well-bounded — one narrow public surface, no reach into sibling domains? Are the integration points the right ones, or does the spec pull in unrelated concerns? | yes |",
    "| SR9 | Are contracts/types named before implementation steps? Does the spec declare interfaces (file paths, schemas, table columns, API shapes) before describing how to build them? | yes |",
    "| SR11 | Is acceptance demonstrable by named tests? Can a builder run a specific command and get exit 0? Are the test commands complete (no missing variables, date substitutions explained)? | yes |",
    "| SR15 | Are all must-paths decidable? A cold-start builder MAY exercise bounded design latitude — choosing a structure, schema, or name whose output is human-reviewed before merge — and that is a PASS, because a reviewed PR is recoverable. FAIL (blocker) ONLY for a decision with no downstream catch: an unstated performance/SLA target, a prerequisite with no 'what if missing' branch, or an ambiguous EXTERNAL contract a reviewer could not detect from the diff. Designing the deliverable is not itself an unrecoverable decision. | yes |",
    "| SR12 | Is there spec → plan → tasks traceability? Is the relationship to Linear issues or parent epics clear? | advisory |",
    "| SR13 | Are structural signals captured with zero-LLM code before model-driven steps? | advisory |",
    "| SR14 | Is durable-state discipline stated where state persists? Append-only stores, writer-honored locks? | advisory |",
    "| SR16-claims | Are architecture claims ('reuses X', 'extends Y', 'builds on Z') backed by real file paths? Does each named dependency resolve to something verifiable? | must |",
    "",
    "## Rubric (full reference)",
    "",
    rubric.raw,
    "",
    "## Deterministic findings already reported (do not repeat these)",
    "",
    detText,
    "",
    "## Recent operator decisions (context only)",
    "",
    decText,
    "",
    "## Spec under review",
    "",
    specText,
  ].join("\n");
}

// Pinned sampling for the adversarial evaluator. A grading judge must be as reproducible as the
// provider allows: temperature 0 + top_p 1 removes the run-to-run PASS/FAIL drift that let one spec
// score 86 → 100 → 0. Only the evaluator uses this; agentic build/plan/fix calls keep defaults.
export const EVAL_SAMPLING = Object.freeze({ temperature: 0, top_p: 1 });

/** Default adversarial evaluator. Honors AIOS_SPEC_EVAL_STUB. Routes via callPromptModel. */
async function defaultEvalFn({ specText, rubric, deterministic, decisions, evalCfg }) {
  const stub = process.env.AIOS_SPEC_EVAL_STUB;
  if (stub != null) return existsSync(stub) ? readFileSync(stub, "utf8") : stub;
  const model = evalCfg?.model ?? "deepseek-v4-pro";
  const prompt = `${EVAL_SYSTEM}\n\n${buildEvalPrompt(specText, rubric, deterministic, decisions)}`;
  return callPromptModel({
    model,
    prompt,
    timeoutMs: evalCfg?.timeoutMs ?? SPEC_PROMPT_TIMEOUT_MS,
    opts: { ...EVAL_SAMPLING },
  });
}

const VALID_SEVERITY = new Set(["blocker", "major", "minor"]);

/** Parse the evaluator's JSON defensively. Junk / malformed output → one synthetic blocker
 *  (never throws) so a broken evaluator fails CLOSED, not open. */
export function parseAdversarial(text) {
  const synthetic = (why) => ({
    verdict: "NOT_READY",
    score: 0,
    findings: [
      {
        ruleId: "SR15",
        severity: "blocker",
        quote: "",
        why,
        suggestion: "re-run the evaluator or inspect its raw output",
        layer: "adversarial",
      },
    ],
    parseError: true,
    raw: String(text ?? ""),
  });
  const s = String(text ?? "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return synthetic("adversarial evaluator returned no JSON object");
  let obj;
  try {
    obj = JSON.parse(s.slice(start, end + 1));
  } catch {
    return synthetic("adversarial evaluator returned unparseable JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return synthetic("adversarial evaluator returned a non-object");
  }
  const verdictRaw = String(obj.verdict ?? "").toUpperCase();
  if (verdictRaw !== "SPEC_READY" && verdictRaw !== "NOT_READY") {
    return synthetic(`adversarial evaluator returned an invalid verdict: ${obj.verdict}`);
  }
  const findings = Array.isArray(obj.findings)
    ? obj.findings.map((f) => ({
        ruleId: String(f?.ruleId ?? "SR?"),
        severity: VALID_SEVERITY.has(f?.severity) ? f.severity : "major",
        quote: String(f?.quote ?? ""),
        why: String(f?.why ?? ""),
        suggestion: String(f?.suggestion ?? ""),
        layer: "adversarial",
      }))
    : [];
  const score = Number.isFinite(Number(obj.score)) ? Number(obj.score) : 0;
  // Verdict is the gate — but a blocker finding forces NOT_READY even if the model said READY.
  const hasBlocker = findings.some((f) => f.severity === "blocker");
  const verdict = hasBlocker ? "NOT_READY" : verdictRaw;
  return { verdict, score, findings, parseError: false };
}

/**
 * Run the adversarial evaluation. `evalFn` is injectable (tests pass a mock); it defaults to the
 * SDK evaluator and returns raw text, parsed defensively here. Findings that duplicate a
 * deterministic blocker (same ruleId) are dropped — the deterministic layer already owns them.
 */
export async function runAdversarialEval({
  specText,
  rubric,
  deterministic = [],
  evalCfg = null,
  decisions = [],
  evalFn = defaultEvalFn,
}) {
  let text;
  try {
    text = await evalFn({ specText, rubric, deterministic, decisions, evalCfg });
  } catch (e) {
    return {
      verdict: "NOT_READY",
      score: 0,
      findings: [
        {
          ruleId: "SR15",
          severity: "blocker",
          quote: "",
          why: `adversarial evaluator threw: ${e.message}`,
          suggestion: "check the model/network and re-run",
          layer: "adversarial",
        },
      ],
      error: true,
    };
  }
  const parsed = parseAdversarial(text);
  const detBlockerIds = new Set(
    deterministic.filter((f) => f.severity === "blocker").map((f) => f.ruleId)
  );
  parsed.findings = parsed.findings.filter((f) => !detBlockerIds.has(f.ruleId));
  return parsed;
}

// ── quorum (confirm-before-fail) ──────────────────────────────────────────────────────────────

/** Normalize a requested quorum to an odd integer ≥ 1. Even counts round up so a strict majority
 *  always exists; 1 (or less) disables quorum entirely (single pass). */
export function normalizeQuorum(k) {
  const n = Number.isFinite(Number(k)) ? Math.floor(Number(k)) : DEFAULT_QUORUM;
  if (n <= 1) return 1;
  return n % 2 === 0 ? n + 1 : n;
}

/**
 * Fold K independent adversarial samples into one verdict by majority vote. A stochastic judge can
 * flip on a single unlucky roll; quorum keeps only signal that recurs.
 *   - verdict is NOT_READY iff ≥⌈K/2⌉ samples voted NOT_READY. parseError/thrown samples already
 *     carry a NOT_READY verdict, so a persistently broken evaluator still fails CLOSED, while a lone
 *     bad roll is outvoted.
 *   - a blocker finding is GATING only if its ruleId recurs in ≥⌈K/2⌉ samples; a non-recurring
 *     blocker is demoted to `minor` (kept for the report, but it no longer blocks).
 *   - score is the median of sample scores (advisory only).
 */
export function aggregateQuorum(samples) {
  const k = samples.length;
  const majority = Math.ceil(k / 2);
  const notReadyVotes = samples.filter((s) => s.verdict === "NOT_READY").length;
  const verdict = notReadyVotes >= majority ? "NOT_READY" : "SPEC_READY";

  // Count blocker occurrences per ruleId across samples (once per sample); keep the richest instance.
  const blockerCounts = new Map();
  const bestBlocker = new Map();
  for (const s of samples) {
    const seen = new Set();
    for (const f of s.findings ?? []) {
      if (f.severity !== "blocker" || seen.has(f.ruleId)) continue;
      seen.add(f.ruleId);
      blockerCounts.set(f.ruleId, (blockerCounts.get(f.ruleId) ?? 0) + 1);
      const prev = bestBlocker.get(f.ruleId);
      if (!prev || (f.why?.length ?? 0) > (prev.why?.length ?? 0)) bestBlocker.set(f.ruleId, f);
    }
  }
  const findings = [];
  for (const [ruleId, count] of blockerCounts) {
    const f = bestBlocker.get(ruleId);
    if (count >= majority) findings.push(f);
    else
      findings.push({
        ...f,
        severity: "minor",
        why: `${f.why} (non-recurring: ${count}/${k} samples — not gated)`,
      });
  }
  // Non-blocker findings never gate; keep one per ruleId for the report.
  const nonBlockers = new Map();
  for (const s of samples) {
    for (const f of s.findings ?? []) {
      if (f.severity !== "blocker" && !nonBlockers.has(f.ruleId)) nonBlockers.set(f.ruleId, f);
    }
  }
  for (const f of nonBlockers.values()) findings.push(f);

  const scores = samples.map((s) => (Number.isFinite(s.score) ? s.score : 0)).sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  const score = scores.length % 2 ? scores[mid] : Math.round((scores[mid - 1] + scores[mid]) / 2);

  return { verdict, score, findings, samples: k, notReadyVotes };
}

/**
 * Confirm-before-fail quorum around runAdversarialEval. The common (ready) path costs ONE call — a
 * first SPEC_READY sample returns immediately. Only a first sample that would BLOCK escalates to K
 * total samples + a majority vote, so cost lands on the boundary case where variance actually bites.
 */
export async function runAdversarialQuorum(args) {
  const quorum = normalizeQuorum(args.quorum ?? args.evalCfg?.quorum ?? DEFAULT_QUORUM);
  const first = await runAdversarialEval(args);
  if (quorum <= 1 || first.verdict === "SPEC_READY") return first;
  const samples = [first];
  for (let i = 1; i < quorum; i++) samples.push(await runAdversarialEval(args));
  return { ...aggregateQuorum(samples), parseError: false };
}

// ── composite evaluation ────────────────────────────────────────────────────────────────────

/**
 * Evaluate a spec through both layers. Returns { verdict, exitCode, score, deterministic,
 * adversarial, findings }. Exit-code precedence: a deterministic must-fail (1) dominates an
 * adversarial blocker (2); a clean deterministic pass with no LLM run is NOT_EVALUATED (3).
 */
export async function evaluateSpec({
  specText,
  repo,
  rubric,
  useLlm = true,
  evalCfg = null,
  evalFn,
  decisions = [],
}) {
  const deterministic = runDeterministicChecks(specText, { repo });
  const detBlockers = deterministic.filter((f) => f.severity === "blocker");
  let adversarial = null;
  let verdict;
  let exitCode;
  let score = null;

  if (useLlm) {
    const quorum = normalizeQuorum(evalCfg?.quorum ?? DEFAULT_QUORUM);
    adversarial = await runAdversarialQuorum({
      specText,
      rubric,
      deterministic,
      evalCfg,
      decisions,
      evalFn,
      quorum,
    });
    // One "output ONLY JSON" retry for the single-pass path (quorum disabled or a lone parseError
    // with no injected evalFn). Quorum ≥ 3 already tolerates a minority parseError by majority vote,
    // so runAdversarialQuorum clears parseError on the aggregated path and this retry stays dormant.
    if (adversarial.parseError && !evalFn) {
      const model = evalCfg?.model ?? "deepseek-v4-pro";
      const retryEvalFn = async (args) => {
        const prompt = `${EVAL_SYSTEM}\n\nCRITICAL: output ONLY the JSON object. No markdown fences.\n\n${buildEvalPrompt(args.specText, args.rubric, args.deterministic, args.decisions)}`;
        return callPromptModel({
          model,
          prompt,
          timeoutMs: evalCfg?.timeoutMs ?? SPEC_PROMPT_TIMEOUT_MS,
          opts: { ...EVAL_SAMPLING },
        });
      };
      adversarial = await runAdversarialQuorum({
        specText,
        rubric,
        deterministic,
        evalCfg,
        decisions,
        evalFn: retryEvalFn,
        quorum,
      });
    }
    score = adversarial.score;
    if (detBlockers.length) {
      verdict = "NOT_READY";
      exitCode = 1;
    } else if (adversarial.verdict === "NOT_READY") {
      verdict = "NOT_READY";
      exitCode = 2;
    } else {
      verdict = "SPEC_READY";
      exitCode = 0;
    }
  } else if (detBlockers.length) {
    verdict = "NOT_READY";
    exitCode = 1;
  } else {
    verdict = "NOT_EVALUATED";
    exitCode = 3;
  }

  const findings = [...deterministic, ...(adversarial?.findings ?? [])];
  return { verdict, exitCode, score, deterministic, adversarial, findings };
}

/** Read the small, flat frontmatter surface used by the evaluator.  This intentionally accepts
 * only scalar keys: the spec itself remains Markdown, while evaluator policy stays auditable. */
export function specEvalHints(specText) {
  const block = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(specText)?.[1] ?? "";
  const values = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "").toLowerCase();
  }
  const tier = values.eval_tier ?? "full";
  if (tier !== "full" && tier !== "deterministic") {
    throw new Error(`invalid eval_tier '${tier}' (expected full|deterministic)`);
  }
  // spec_gate is the ENFORCEMENT policy (does a NOT_READY verdict block?), orthogonal to eval_tier
  // (which LAYERS run). Unset → undefined so the caller's flag/config default wins; block | advisory
  // | off when declared. Validated here so a typo fails loudly rather than silently blocking.
  const specGate = values.spec_gate;
  if (specGate != null && !SPEC_GATE_POLICIES.has(specGate)) {
    throw new Error(
      `invalid spec_gate '${specGate}' (expected ${[...SPEC_GATE_POLICIES].join("|")})`
    );
  }
  const provenance = [
    values.eval_provenance,
    values.parent_plan_reviewed,
    values.plan_reviewed,
    values.adversarial_parent_plan,
  ];
  const planTraceable = provenance.some((value) =>
    ["true", "yes", "adversarial-reviewed", "adversarially-reviewed", "reviewed"].includes(value)
  );
  return { tier, planTraceable, specGate };
}

function collectSpecPaths(input) {
  const absolute = path.resolve(input);
  if (existsSync(absolute)) {
    try {
      readdirSync(absolute);
    } catch (error) {
      if (error?.code === "ENOTDIR") return [absolute];
      throw error;
    }
    const found = [];
    const visit = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(child);
        else if (entry.isFile() && entry.name.endsWith(".md")) found.push(child);
      }
    };
    visit(absolute);
    return found.sort();
  }
  // Shell glob expansion is not guaranteed for the Node CLI. Support the common ** / * form
  // without bringing in a dependency, relative to cwd.
  if (!/[?*[]/.test(input)) return [];
  const escaped = input
    .split(/(\*\*|\*|\?)/)
    .map((part) =>
      part === "**"
        ? ".*"
        : part === "*"
          ? "[^/]*"
          : part === "?"
            ? "[^/]"
            : part.replace(/[.+^${}()|[\]\\]/g, "\\$&")
    )
    .join("");
  const matcher = new RegExp(`^${escaped}$`);
  const root = process.cwd();
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && matcher.test(path.relative(root, child)) && child.endsWith(".md"))
        found.push(child);
    }
  };
  visit(root);
  return found.sort();
}

// ── fix loop ────────────────────────────────────────────────────────────────────────────────

function buildFixPrompt(specText, findings, rubric) {
  const list = findings.length
    ? findings.map((f) => `- [${f.ruleId}/${f.severity}] ${f.detail ?? f.why ?? ""}`).join("\n")
    : "- (none)";
  return [
    "Revise the spec below so it passes the spec-readiness rubric. Address every finding without",
    "inventing facts: if an integration path is phantom, either correct it to a real file or move",
    "it under an explicit 'new file to create' heading; make acceptance criteria observable; add",
    "any missing Deps / Scope / Build-with / tier-safety sections.",
    "Output ONLY the full revised spec markdown — no preamble, no commentary.",
    "",
    "## Rubric",
    "",
    rubric.raw,
    "",
    "## Findings to fix",
    "",
    list,
    "",
    "## Current spec",
    "",
    specText,
  ].join("\n");
}

/** Default reviser. Honors AIOS_SPEC_FIX_STUB. Routes via callPromptModel. */
async function defaultReviseFn({ specText, findings, rubric, fixCfg }) {
  const stub = process.env.AIOS_SPEC_FIX_STUB;
  if (stub != null) return existsSync(stub) ? readFileSync(stub, "utf8") : stub;
  const model = fixCfg?.model ?? "deepseek-v4-pro";
  const prompt = buildFixPrompt(specText, findings, rubric);
  const text = await callPromptModel({
    model,
    prompt,
    timeoutMs: fixCfg?.timeoutMs ?? SPEC_PROMPT_TIMEOUT_MS,
  });
  return text.trim() || specText;
}

/**
 * Bounded fix loop (mirrors the C3 verifier's verify → correct → re-verify controller):
 *   evaluate → (NOT_READY && budget left) ? revise → re-evaluate : stop.
 * Both evalFn and reviseFn are injectable (tests pass mocks). Returns the before/after
 * evaluations, iteration count, and the revised spec. NOT_EVALUATED (deterministic-clean under
 * --no-llm) counts as converged.
 */
export async function runFixLoop({
  specText,
  repo,
  rubric,
  budget,
  useLlm = true,
  evalCfg = null,
  fixCfg = null,
  evalFn,
  reviseFn = defaultReviseFn,
  decisions = [],
  provenanceAware = false,
}) {
  const cap =
    Number.isInteger(budget) && budget >= 0
      ? budget
      : (rubric?.frontmatter?.budget ?? DEFAULT_FIX_BUDGET);
  let current = specText;
  // The fix loop is an iterative revision aid, not the authoritative gate: it re-evaluates after
  // every revision, so per-iteration quorum would triple cost for no added signal. Run its internal
  // evals single-pass (quorum=1); the real quorum-stable verdict comes from the downstream
  // `aios spec eval` / ship gate that runs on the revised spec.
  const singlePassCfg = { ...(evalCfg ?? {}), quorum: 1 };
  const evalOnce = (text, withLlm = useLlm) =>
    evaluateSpec({
      specText: text,
      repo,
      rubric,
      useLlm: withLlm,
      evalCfg: singlePassCfg,
      evalFn,
      decisions,
    });

  const before = await evalOnce(current);
  let result = before;
  let iterations = 0;
  let reviseError = null;
  while (result.verdict === "NOT_READY" && iterations < cap) {
    let revised;
    try {
      revised = await reviseFn({
        specText: current,
        findings: result.findings,
        rubric,
        fixCfg,
      });
    } catch (e) {
      // The reviser failed (e.g. an SDK/billing/network error). Degrade gracefully: keep the last
      // spec + evaluation and stop, rather than crashing the loop. Mirrors the evaluator's
      // never-throw posture.
      reviseError = e.message;
      break;
    }
    current = revised;
    iterations++;
    // A reviewed parent plan is stable provenance. Revision turns only need the mandatory
    // deterministic gate; one independent LLM confirmation runs after the loop below.
    result = await evalOnce(current, provenanceAware ? false : useLlm);
  }
  if (provenanceAware && useLlm) result = await evalOnce(current, true);
  const status =
    result.verdict === "NOT_READY" ? (reviseError ? "error" : "exhausted") : "converged"; // SPEC_READY | NOT_EVALUATED
  const exitCode = result.verdict === "NOT_READY" ? result.exitCode : 0;
  return {
    status,
    exitCode,
    iterations,
    budget: cap,
    reviseError,
    before,
    after: result,
    revisedSpec: current,
    beforeScore: before.score,
    afterScore: result.score,
  };
}

// ── formatting ──────────────────────────────────────────────────────────────────────────────

export function formatFindings(findings) {
  if (!findings.length) return c.green("  no findings");
  const sevColor = { blocker: c.red, major: c.yellow, minor: c.dim };
  return findings
    .map((f) => {
      const paint = sevColor[f.severity] ?? ((s) => s);
      const where = f.line ? c.dim(` (line ${f.line})`) : "";
      const msg = f.detail ?? f.why ?? "";
      return `  ${paint(`[${f.ruleId}/${f.severity}]`)} ${msg}${where}`;
    })
    .join("\n");
}

export function formatScorecard(loop) {
  const b = loop.before;
  const a = loop.after;
  const scoreStr = (s) => (s == null ? "n/a" : String(s));
  const statusLine =
    loop.status === "converged"
      ? c.green("converged")
      : loop.status === "error"
        ? c.red(`error (reviser failed: ${loop.reviseError})`)
        : c.red("exhausted (budget spent)");
  return [
    c.blue("── spec fix scorecard ───────────────────────────────────────"),
    `  before:     ${b.verdict}   score ${scoreStr(loop.beforeScore)}`,
    `  after:      ${a.verdict}   score ${scoreStr(loop.afterScore)}`,
    `  iterations: ${loop.iterations}/${loop.budget}`,
    `  status:     ${statusLine}`,
  ].join("\n");
}

// ── soft EE4 decision enrichment ──────────────────────────────────────────────────────────────

/** Read the recent human-in-the-loop decision corpus (EE4) as soft context for the evaluator.
 *  Never blocks: returns [] on any error (unbuilt loop, missing store, read failure). */
export async function loadRecentDecisions(repo, limit = 5) {
  try {
    const distPath = path.join(SCRIPT_DIR, "..", "dist", "operator-loop", "index.js");
    if (!existsSync(distPath)) return [];
    const mod = await import(pathToFileURL(distPath).href);
    if (typeof mod.readDecisions !== "function") return [];
    const { decisions } = mod.readDecisions(repo);
    return Array.isArray(decisions) ? decisions.slice(-limit) : [];
  } catch {
    return [];
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

const SPEC_VALUE_FLAGS = ["--rubric", "--out", "--budget", "--tier", "--concurrency"];

const HELP = [
  "",
  c.blue("aios spec — spec/plan readiness harness (rubric: .claude/rubrics/spec-readiness.md)"),
  "",
  "usage:",
  "  aios spec eval <file|dir|glob> [--tier full|deterministic] [--concurrency N] [--json] [--no-llm] [--rubric <path>]",
  "  aios spec fix  <file> [--tier full|deterministic] [--budget N] [--write | --out <path>] [--no-llm] [--rubric <path>]",
  "  aios spec author <plan> --slices <dir> [--out <dir>] [--concurrency N] [--model <id>] [--effort <level>] [--json]",
  "",
  "eval:  score a spec against the rubric (deterministic + adversarial LLM layers).",
  "fix:   iterate the spec through the bounded fix loop until it is ready (budget from rubric).",
  "       default writes <name>.improved.md; --write overwrites in place; --out <path> is explicit.",
  "",
  "exit codes:",
  "  0 SPEC_READY · 1 deterministic must-fail · 2 adversarial blocker ·",
  "  3 NOT_EVALUATED (--no-llm, deterministic clean) · 4 usage/IO",
].join("\n");

function specArgv(rest) {
  const flag = (n) => {
    const i = rest.indexOf(n);
    return i >= 0 ? rest[i + 1] : null;
  };
  const has = (n) => rest.includes(n);
  const file = rest.find((a, i) => !a.startsWith("--") && !SPEC_VALUE_FLAGS.includes(rest[i - 1]));
  return { flag, has, file };
}

/** `aios spec eval|fix`. Emits the exact exit code via process.exit (0/1/2/3 verdict, 4 usage/IO).
 *  --json output always carries exitCode (and, for fix, the output path). */
export async function cmdSpec(repo, args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return;
  }
  const sub = args[0];
  const rest = args.slice(1);
  if (sub !== "eval" && sub !== "fix" && sub !== "author") {
    console.error(c.red(`error: unknown subcommand '${sub}' (expected eval|fix|author)`));
    process.exit(4);
  }
  if (sub === "author") {
    const models = resolveLoopModels({ repo });
    const { cmdSpecAuthor } = await import("./spec-author.mjs");
    process.exit(await cmdSpecAuthor(repo, args.slice(1), { models }));
  }
  const { flag, has, file } = specArgv(rest);
  const asJson = has("--json");
  const noLlm = has("--no-llm");

  if (!file) {
    console.error(c.red("error: a spec file is required"));
    process.exit(4);
  }
  const specPaths = collectSpecPaths(file);
  if (!specPaths.length) {
    console.error(c.red(`error: no spec files found: ${file}`));
    process.exit(4);
  }
  if (sub === "fix" && specPaths.length !== 1) {
    console.error(c.red("error: spec fix accepts exactly one file"));
    process.exit(4);
  }
  const specPath = specPaths[0];
  let specText;
  try {
    specText = readFileSync(specPath, "utf8");
  } catch (e) {
    console.error(c.red(`error: cannot read ${file}: ${e.message}`));
    process.exit(4);
  }

  const rubricPath = resolveRubricPath(repo, flag("--rubric"));
  let rubric;
  try {
    rubric = loadRubric(rubricPath);
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    process.exit(4);
  }

  let hints;
  try {
    hints = specEvalHints(specText);
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    process.exit(4);
  }
  const requestedTier = flag("--tier") ?? hints.tier;
  if (!["full", "deterministic"].includes(requestedTier)) {
    console.error(c.red(`error: invalid --tier '${requestedTier}' (expected full|deterministic)`));
    process.exit(4);
  }
  const deterministicTier = requestedTier === "deterministic";
  let hasFullTier = !deterministicTier;
  if (sub === "eval" && !flag("--tier")) {
    try {
      hasFullTier = specPaths.some(
        (candidate) => specEvalHints(readFileSync(candidate, "utf8")).tier === "full"
      );
    } catch (e) {
      console.error(c.red(`error: ${e.message}`));
      process.exit(4);
    }
  }

  // A model call is needed only when the LLM layer runs without a stub.
  const evalStubbed = process.env.AIOS_SPEC_EVAL_STUB != null;
  const fixStubbed = process.env.AIOS_SPEC_FIX_STUB != null;
  // With --no-llm neither the evaluator nor the reviser runs, so no key is ever needed.
  const needsKey =
    (sub === "eval" && !noLlm && hasFullTier && !evalStubbed) ||
    (sub === "fix" && !noLlm && !deterministicTier && (!evalStubbed || !fixStubbed));

  const models = resolveLoopModels({ repo });
  if (needsKey) {
    try {
      requirePromptModelKey(models.spec_eval.model, "spec_eval");
      if (sub === "fix" && !fixStubbed) {
        requirePromptModelKey(models.spec_fix.model, "spec_fix");
      }
    } catch (e) {
      console.error(c.red(`error: ${e.message}`));
      process.exit(4);
    }
  }

  const decisions = await loadRecentDecisions(repo);

  if (sub === "eval") {
    const evaluateOne = async (candidate) => {
      const text = readFileSync(candidate, "utf8");
      const candidateHints = specEvalHints(text);
      const tier = flag("--tier") ?? candidateHints.tier;
      const res = await evaluateSpec({
        specText: text,
        repo,
        rubric,
        useLlm: !noLlm && tier !== "deterministic",
        evalCfg: models.spec_eval,
        decisions,
      });
      // deterministic is a declared tier, not an incomplete evaluation; its clean result passes.
      if (tier === "deterministic" && res.exitCode === 3) {
        res.verdict = "SPEC_READY";
        res.exitCode = 0;
      }
      return { file: candidate, tier, ...res };
    };
    const concurrency = Math.min(
      SPEC_BATCH_CONCURRENCY_MAX,
      Math.max(1, Number(flag("--concurrency") ?? 6) || 6)
    );
    const results = [];
    for (let index = 0; index < specPaths.length; index += concurrency) {
      results.push(
        ...(await Promise.all(specPaths.slice(index, index + concurrency).map(evaluateOne)))
      );
    }
    const res = results[0];
    // Exit codes are categories, not a severity ordinal (3 is an incomplete full-tier eval,
    // not worse than a deterministic blocker). Preserve the single-spec gate precedence.
    const exitCode = results.some((item) => item.exitCode === 1)
      ? 1
      : results.some((item) => item.exitCode === 2)
        ? 2
        : results.some((item) => item.exitCode === 3)
          ? 3
          : 0;
    if (asJson) {
      console.log(
        JSON.stringify(
          results.length === 1
            ? {
                verdict: res.verdict,
                exitCode,
                score: res.score,
                findings: res.findings,
                tier: res.tier,
              }
            : {
                exitCode,
                results: results.map(
                  ({ file: itemFile, verdict, exitCode: itemExit, score, tier }) => ({
                    file: itemFile,
                    verdict,
                    exitCode: itemExit,
                    score,
                    tier,
                  })
                ),
              },
          null,
          2
        )
      );
    } else {
      if (results.length === 1) {
        console.log(c.blue(`\n── spec eval: ${file} ─────────────────────────────────────`));
        console.log(formatFindings(res.findings));
        const verdictColor = res.verdict === "SPEC_READY" ? c.green : c.red;
        console.log(
          `\n  verdict: ${verdictColor(res.verdict)}   score: ${res.score == null ? "n/a" : res.score}   exit: ${res.exitCode}`
        );
      } else {
        console.log(c.blue("\n── spec eval batch ─────────────────────────────────────"));
        console.log("  file\tverdict\texit\tscore");
        for (const item of results)
          console.log(
            `  ${path.relative(process.cwd(), item.file)}\t${item.verdict}\t${item.exitCode}\t${item.score ?? "n/a"}`
          );
      }
    }
    process.exit(exitCode);
  }

  // sub === "fix"
  const budget = flag("--budget") != null ? parseInt(flag("--budget"), 10) : undefined;
  const loop = await runFixLoop({
    specText,
    repo,
    rubric,
    budget: Number.isFinite(budget) ? budget : undefined,
    useLlm: !noLlm && !deterministicTier,
    evalCfg: models.spec_eval,
    fixCfg: models.spec_fix,
    decisions,
    provenanceAware: hints.planTraceable,
  });

  // Resolve the output path: --write (in place) | --out <path> | default <name>.improved.md
  let outPath;
  if (has("--write")) outPath = specPath;
  else if (flag("--out")) outPath = path.resolve(flag("--out"));
  else outPath = specPath.replace(/\.md$/i, "") + ".improved.md";

  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, loop.revisedSpec);
  } catch (e) {
    console.error(c.red(`error: cannot write ${outPath}: ${e.message}`));
    process.exit(4);
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          status: loop.status,
          exitCode: loop.exitCode,
          iterations: loop.iterations,
          budget: loop.budget,
          beforeScore: loop.beforeScore,
          afterScore: loop.afterScore,
          beforeVerdict: loop.before.verdict,
          afterVerdict: loop.after.verdict,
          outputPath: outPath,
        },
        null,
        2
      )
    );
  } else {
    console.log("");
    console.log(formatScorecard(loop));
    console.log(c.dim(`\n  wrote: ${outPath}`));
  }
  process.exit(loop.exitCode);
}
