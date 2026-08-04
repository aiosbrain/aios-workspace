/**
 * spec-checks/deterministic.mjs — the zero-LLM, offline spec-readiness layer: structural
 * presence/shape checks + real-path resolution against the repo tree. Extracted VERBATIM from
 * scripts/spec-eval.mjs (AIO-594, devtools-lane decoupling). A deterministic must-fail is a hard
 * blocker. Import via the scripts/spec-checks.mjs barrel (R1).
 */

import {
  classifyPathContext,
  collectAcceptanceBullets,
  extractBullets,
  extractSections,
  findArchitectureClaims,
  findReferencedPaths,
  looksObservable,
  pathResolves,
  touchesSyncSurface,
} from "./spec-text.mjs";

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
  "SR18",
]);

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
  ["scripts", /^scripts\b/],
  ["src/operator-loop", /^src\/operator-loop\b/],
  ["src", /^src\b(?!\/operator-loop)/],
  ["hooks", /^hooks\b/],
  ["validation", /^validation\b/],
];

// An explicit statement that the author has bounded the increment to one PR.
const SR17_INCREMENT_RE =
  /\b(one\s+pr|single\s+pr|this\s+pr\b|one\s+increment|line\s+budget|~?\d{2,4}\s*(loc|lines)\b|follow-?ups?\s+(are\s+)?deferred|sibling\s+spec|split\s+into\s+\w+\s+spec|first\s+slice|slice\s+\d|one\s+surface)\b/i;

// ── SR18: scope-fence accounting ──────────────────────────────────────────────────────────────
//
// A blanket constraint ("no change to any file that `/` renders", "must be byte-identical") is the
// cheapest way to lose work. It reads as discipline, it passes SR5 because a Scope section still
// exists, and everything the fence quietly excludes simply never appears in the spec at all. Not
// hypothetical: a website rebuild spec fenced with "No change to any file that / renders" and
// seven items from its own source audit were never re-homed, because nothing in the gate required
// the author to say where fenced work goes.
//
// The deterministic half is narrow on purpose. It cannot know WHAT a fence excludes, so it does
// not try; it only requires that a spec raising a fence names a destination for what the fence
// pushes out. The adversarial layer judges whether that accounting is actually complete.
const SR18_DIRECT_FENCE_PATTERNS = [
  /\bno changes? to any\b/i,
  /\bmust (?:be|remain) (?:byte-)?identical\b/i,
  /\bbyte-identical\b/i,
  /\bmust not be (?:modified|changed|touched)\b/i,
  /\bnot modified by this (?:slice|spec|pr)\b/i,
  /\bdo not (?:modify|touch|change) [^.\n]{0,40}/i,
  /\bunchanged (?:against|from) /i,
];

// "Leave it unchanged" describes one item and is not a blanket scope fence. Treat a leave-clause
// as a fence only when its target is explicitly class-wide (a quantifier or a plural surface).
const SR18_LEAVE_RE = /\bleave\s+([^.\n]{1,80}?)\s+(?:untouched|unchanged)\b/gi;
const SR18_CLASS_WIDE_TARGET_RE =
  /\b(?:all|any|every|everything|anything|entire|files|pages|routes|outputs|artifacts|content)\b/i;

// Naming where the excluded work goes. A "Deferred:" list alone does NOT count: the spec that
// prompted this criterion had one, and the fenced items still were not in it.
const SR18_DESTINATION_RE =
  /\b(sibling spec|follow-?up spec|separate spec|its own spec|a later spec|tracked (as|in|under)\b|deferred to\b|filed as\b|raised as\b|follow-?up issue|nothing is excluded|excludes nothing|fenced out)/i;

// Only scope-bearing sections can raise a scope fence. "leave it unchanged" written against one
// entry in an integration list is a per-file note, not a constraint that excludes a class of work,
// and conflating the two made SR18 fire on well-formed specs.
const SR18_SCOPE_SECTION_RE =
  /\b(scope|outcomes?|acceptance|success crit|done when|non-?goals?|not doing|deferred)\b/i;

/**
 * Does the spec raise a blanket scope fence, and if so does it say where the fenced work goes?
 * The fence is looked for only in scope-bearing sections; the destination may be stated anywhere.
 * Pure + deterministic so it can be unit-tested directly.
 */
export function assessScopeFence(specText) {
  const ancestry = [];
  const scopeBodies = [];
  for (const sec of extractSections(specText)) {
    if (sec.level === 0) continue;
    while (ancestry.length && ancestry.at(-1).level >= sec.level) ancestry.pop();
    const inScope = SR18_SCOPE_SECTION_RE.test(sec.heading) || Boolean(ancestry.at(-1)?.inScope);
    if (inScope) scopeBodies.push(sec.body);
    ancestry.push({ level: sec.level, inScope });
  }
  const scopeText = scopeBodies.join("\n");
  let phrase = null;
  for (const pattern of SR18_DIRECT_FENCE_PATTERNS) {
    const match = scopeText.match(pattern);
    if (match) {
      phrase = match[0].trim();
      break;
    }
  }
  if (!phrase) {
    for (const match of scopeText.matchAll(SR18_LEAVE_RE)) {
      if (SR18_CLASS_WIDE_TARGET_RE.test(match[1])) {
        phrase = match[0].trim();
        break;
      }
    }
  }
  return {
    fenced: Boolean(phrase),
    phrase,
    destinationNamed: SR18_DESTINATION_RE.test(specText),
  };
}

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
    const bullets = acceptanceSection
      ? collectAcceptanceBullets(sections)
      : extractBullets(
          specText.slice(
            specText.search(
              /\b(acceptance criteria|success criteria|definition of done|done when)\b/i
            )
          )
        );
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

  // SR5 — scope + deferred stated (Outcomes section counts as target-state scope)
  const scopePresent =
    hasHeading(/\b(scope|deferred|out of scope|non-?goals|not doing|outcomes?)\b/i) ||
    /\b(out of scope|deferred|non-?goals?|in scope)\b/i.test(specText);
  if (!scopePresent) {
    add(
      "SR5",
      "blocker",
      "scope/deferred not stated — declare what is in and what is cut (## Scope or ## Outcomes)"
    );
  }

  // SR2 advisory — Automated subsection should name observable checks when present
  const automatedSection = sections.find((s) => /^automated$/i.test(s.heading.trim()));
  if (automatedSection) {
    const autoBullets = extractBullets(automatedSection.body);
    if (autoBullets.length > 0 && !autoBullets.some(looksObservable)) {
      add(
        "SR2",
        "minor",
        "### Automated has bullets but none look observable — prefer exit codes, named tests, or concrete commands"
      );
    }
  }

  // SR18 — a blanket scope fence must name a destination for what it excludes (conditional:
  // fires only when a fence is actually raised). Without this, "do not touch X" silently drops
  // every item that lives in X and the spec still passes SR5, because a Scope section exists.
  {
    const fence = assessScopeFence(specText);
    if (fence.fenced && !fence.destinationNamed) {
      add(
        "SR18",
        "blocker",
        `scope fence "${fence.phrase}" excludes work but names nowhere for it to go — list what the fence pushes out and where it lands (a sibling spec, a follow-up issue), or state that it excludes nothing`
      );
    }
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

  // SR6 — build-with tier present ("build-with", "build with", and "buildwith" all count:
  // the natural space spelling failing the gate was a pure format gotcha)
  const buildWithPresent =
    hasHeading(/build[-\s]?with/i) ||
    /\bbuild[-\s]?with\b\s*[:—-]/i.test(specText) ||
    /\b(build[-\s]?with|model\/effort|effort tier)\b/i.test(specText) ||
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
