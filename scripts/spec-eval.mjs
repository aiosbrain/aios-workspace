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
 * 3 NOT_EVALUATED (the LLM layer was ASKED for and did not run) · 4 usage/IO.
 *
 * Test seams (documented, PATH-fake analog for an SDK-backed CLI):
 *   AIOS_SPEC_EVAL_STUB — raw evaluator text (or a file path to it); bypasses the SDK call.
 *   AIOS_SPEC_FIX_STUB  — revised-spec text (or a file path to it); bypasses the SDK reviser.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { c } from "./relay-core.mjs";
import { getToolkit, loadToolkitModule } from "./toolkit-locate.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { callPromptModel, requirePromptModelKey } from "./model-call.mjs";
import {
  loadSkillContext,
  loadSkillSuite,
  parseDeclaredSkills,
  skillSha256,
  validateSkillSelection,
} from "./skill-context.mjs";
import { cmdSpecPublish } from "./spec-publish.mjs";
import {
  DEFAULT_FIX_BUDGET,
  loadRubric,
  resolveRubricPath,
  runDeterministicChecks,
  SPEC_BATCH_CONCURRENCY_MAX,
} from "./spec-checks.mjs";

// The deterministic (zero-LLM) layer — rubric loading + text/path helpers + structural SR checks —
// moved VERBATIM to the core-staying scripts/spec-checks.mjs barrel (AIO-594): spec-author.mjs
// (core) consumes it, while this file is in the devtools path set moving to the aios-devtools
// repo. Re-exported here so every existing `from "./spec-eval.mjs"` call site (ship.mjs,
// relay.mjs, the test suite) is unchanged.
export {
  loadRubric,
  resolveRubricPath,
  extractSections,
  looksObservable,
  touchesSyncSurface,
  findReferencedPaths,
  classifyPathContext,
  SR17_TASK_LIMIT,
  SR17_SURFACE_LIMIT,
  assessScopeBound,
  runDeterministicChecks,
  DETERMINISTIC_CHECK_IDS,
  SPEC_BATCH_CONCURRENCY_MAX,
} from "./spec-checks.mjs";

const TRUSTED_GIT_BIN = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
  existsSync
);

function trustedGitBin() {
  if (!TRUSTED_GIT_BIN) throw new Error("git was not found in a trusted system directory");
  return TRUSTED_GIT_BIN;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const AIOS_ISSUE_TEMPLATE_REL = path.join(
  "docs",
  "agentic-ergonomics",
  "aios-issue-template.md"
);
const SPEC_PROMPT_TIMEOUT_MS = 300_000;

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

function buildEvalPrompt(specText, rubric, deterministic, decisions, skillContext) {
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
    "## Stage skill",
    "",
    skillContext?.prompt ?? "(none)",
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
  const prompt = `${EVAL_SYSTEM}\n\n${buildEvalPrompt(specText, rubric, deterministic, decisions, evalCfg?.skillContext)}`;
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
    ? obj.findings.map((f) => {
        const severity = String(f?.severity ?? "").toLowerCase();
        return {
          ruleId: String(f?.ruleId ?? "SR?"),
          // An unrecognised or missing severity means the model did not classify this record —
          // most often because it is a per-criterion PASS note rather than an objection.
          // Defaulting those to `major` (as this did until AIO-573) manufactured near-blocking
          // noise and tanked the advisory score: one observed run reported seven `major` findings
          // whose `why` text was positive. `minor` cannot change the gate either way — only
          // `blocker` gates — so this is purely a report-fidelity fix, not a weakening.
          severity: VALID_SEVERITY.has(severity) ? severity : "minor",
          quote: String(f?.quote ?? ""),
          why: String(f?.why ?? ""),
          suggestion: String(f?.suggestion ?? ""),
          layer: "adversarial",
        };
      })
    : [];
  const score = Number.isFinite(Number(obj.score)) ? Number(obj.score) : 0;
  // Verdict is the gate — but a blocker finding forces NOT_READY even if the model said READY.
  const hasBlocker = findings.some((f) => f.severity === "blocker");
  if (hasBlocker) return { verdict: "NOT_READY", score, findings, parseError: false };

  // …and the converse (AIO-573): a NOT_READY that cites no blocker is an uncited refusal. The
  // report cannot say what to fix, so the author's only move is to re-run and hope. This sample
  // does not get to cast a blocking vote. Every genuine fail-closed path — a thrown evaluator,
  // unparseable JSON, an invalid verdict — routes through `synthetic()` and carries a blocker, so
  // none of them are affected.
  if (verdictRaw === "NOT_READY") {
    return {
      verdict: "SPEC_READY",
      score,
      findings: [
        ...findings,
        {
          ruleId: "SR15",
          severity: "minor",
          quote: "",
          why: "adversarial sample returned NOT_READY without citing a blocking finding — an unjustified refusal, so it does not gate",
          suggestion: "",
          layer: "adversarial",
        },
      ],
      parseError: false,
      uncitedRefusal: true,
    };
  }
  return { verdict: verdictRaw, score, findings, parseError: false };
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

  // A refusal must name what it refused (AIO-573).
  //
  // The vote above and the blocker-recurrence test above it are independent, so the quorum could
  // return NOT_READY while every blocker was demoted for non-recurrence — or while the samples
  // raised no blocker at all. That verdict is unfalsifiable: the report cannot say what to fix,
  // and the author's only move is to re-run and hope. Observed on 2026-07-28, where a candidate
  // scored NOT_READY/30 with seven `major` findings whose `why` text was positive (they were
  // pass records), and the BYTE-IDENTICAL file re-evaluated to SPEC_READY/100.
  //
  // So NOT_READY now requires at least one surviving gating blocker. This does NOT weaken any
  // fail-closed path: an evaluator that throws, returns unparseable JSON, or returns an invalid
  // verdict already synthesises a blocker-severity finding, and a blocker recurring in a majority
  // of samples still gates exactly as before. The only path removed is the uncited refusal.
  const gating = findings.filter((f) => f.severity === "blocker");
  if (verdict === "NOT_READY" && gating.length === 0) {
    findings.push({
      ruleId: "SR15",
      severity: "minor",
      quote: "",
      why:
        `${notReadyVotes}/${k} adversarial samples voted NOT_READY but none cited a blocking ` +
        `finding — an unjustified refusal, so it does not gate. Treated as SPEC_READY.`,
      suggestion:
        "If this recurs on the same candidate, read the sample findings: the evaluator is " +
        "objecting to something it is failing to name.",
      layer: "adversarial",
    });
    return {
      verdict: "SPEC_READY",
      score,
      findings,
      samples: k,
      notReadyVotes,
      uncitedRefusal: true,
    };
  }

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
 * adversarial, findings, tier }. Exit-code precedence: a deterministic must-fail (1) dominates an
 * adversarial blocker (2). A clean deterministic pass is NOT_EVALUATED (3) only when the LLM layer
 * was asked for and suppressed; on a DECLARED deterministic tier it is a complete SPEC_READY (0).
 */
export async function evaluateSpec({
  specText,
  repo,
  rubric,
  // The DECLARED tier (`full` | `deterministic`), when the caller has one. It does two things a
  // bare `useLlm` cannot: it supplies the default for `useLlm`, and it marks a deterministic run
  // as a COMPLETE evaluation so its clean result is SPEC_READY/0 rather than NOT_EVALUATED/3.
  // Both the CLI and `aios ship` pass it, so the two can no longer disagree about what a clean
  // deterministic pass means — they did, and ship rejected every spec the CLI called ready.
  tier = undefined,
  useLlm = tier === undefined ? true : tier === "full",
  evalCfg = null,
  evalFn,
  decisions = [],
  skillContext = null,
  skillDeclarationText = null,
  requireCleanRepo = false,
  resolveRepoState,
}) {
  const candidateSha256 = skillSha256(specText);
  let repoSha = null;
  let repoDirty = null;
  try {
    if (resolveRepoState) {
      ({ repoSha, repoDirty } = resolveRepoState(repo));
    } else {
      repoSha = execFileSync(trustedGitBin(), ["rev-parse", "HEAD"], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      repoDirty =
        execFileSync(trustedGitBin(), ["status", "--porcelain"], {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim().length > 0;
    }
  } catch {
    repoSha = null;
    repoDirty = null;
  }
  let resolvedSkillContext = skillContext;
  const suitePath = path.join(repo, ".claude", "skill-suite.json");
  if (existsSync(suitePath)) {
    const suite = loadSkillSuite({ repo });
    validateSkillSelection({
      suite,
      ids: parseDeclaredSkills(skillDeclarationText ?? specText),
      stage: "builder",
      source: "spec",
    });
    resolvedSkillContext ??= loadSkillContext({
      repo,
      ids: ["evaluate-spec-readiness"],
      stage: "spec-eval",
      source: "workflow",
    });
  }
  const resolvedEvalCfg = resolvedSkillContext
    ? { ...(evalCfg ?? {}), skillContext: resolvedSkillContext }
    : evalCfg;
  const deterministic = runDeterministicChecks(specText, { repo });
  if (requireCleanRepo && repoDirty !== false) {
    deterministic.push({
      ruleId: "SR0",
      severity: "blocker",
      detail:
        repoDirty === true
          ? "repository has uncommitted changes; SPEC_READY requires a clean evaluated tree"
          : "repository cleanliness could not be verified; SPEC_READY requires a clean evaluated tree",
    });
  }
  const detBlockers = deterministic.filter((f) => f.severity === "blocker");
  let adversarial = null;
  let verdict;
  let exitCode;
  let score = null;

  if (useLlm) {
    const quorum = normalizeQuorum(resolvedEvalCfg?.quorum ?? DEFAULT_QUORUM);
    adversarial = await runAdversarialQuorum({
      specText,
      rubric,
      deterministic,
      evalCfg: resolvedEvalCfg,
      decisions,
      evalFn,
      quorum,
    });
    // One "output ONLY JSON" retry for the single-pass path (quorum disabled or a lone parseError
    // with no injected evalFn). Quorum ≥ 3 already tolerates a minority parseError by majority vote,
    // so runAdversarialQuorum clears parseError on the aggregated path and this retry stays dormant.
    if (adversarial.parseError && !evalFn) {
      const model = resolvedEvalCfg?.model ?? "deepseek-v4-pro";
      const retryEvalFn = async (args) => {
        const prompt = `${EVAL_SYSTEM}\n\nCRITICAL: output ONLY the JSON object. No markdown fences.\n\n${buildEvalPrompt(args.specText, args.rubric, args.deterministic, args.decisions, resolvedSkillContext)}`;
        return callPromptModel({
          model,
          prompt,
          timeoutMs: resolvedEvalCfg?.timeoutMs ?? SPEC_PROMPT_TIMEOUT_MS,
          opts: { ...EVAL_SAMPLING },
        });
      };
      adversarial = await runAdversarialQuorum({
        specText,
        rubric,
        deterministic,
        evalCfg: resolvedEvalCfg,
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

  // A declared deterministic tier is a complete evaluation, not an incomplete one.
  if (tier === "deterministic" && exitCode === 3) {
    verdict = "SPEC_READY";
    exitCode = 0;
  }

  const findings = [...deterministic, ...(adversarial?.findings ?? [])];
  return {
    verdict,
    exitCode,
    score,
    // The tier this run actually evaluated at, so downstream consumers can tell a deterministic
    // pass from an adversarially-reviewed one. `spec publish` gates on it: before AIO-573 a
    // publishable artifact implied an LLM pass (deterministic-only exited 3, never SPEC_READY),
    // and that guarantee has to be asserted explicitly now that it is no longer structural.
    tier: useLlm ? "full" : "deterministic",
    deterministic,
    adversarial,
    findings,
    injectedSkills: resolvedSkillContext?.audit ?? [],
    candidateSha256,
    repoSha,
    repoDirty,
    publishable:
      requireCleanRepo && repoDirty === false && verdict === "SPEC_READY" && exitCode === 0,
  };
}

/** Read the small, flat frontmatter surface used by the evaluator.  This intentionally accepts
 * only scalar keys: the spec itself remains Markdown, while evaluator policy stays auditable. */
export function specEvalHints(specText) {
  // Tolerant of leading whitespace/BOM and CRLF, and deliberately IDENTICAL to `specSafetyFlag`
  // (ship/prompts.mjs) — the two read the same frontmatter block off the same issue bodies, and
  // when they disagreed about whether a block existed at all, `safety: true` was seen while
  // `eval_tier: full` was silently discarded. That mattered little while the tier default was
  // `full` (a missed parse still ran the adversarial layer, so it failed SAFE); since AIO-573
  // flipped the default to `deterministic`, the same missed parse fails OPEN — it drops the very
  // opt-in the author wrote, and skips the `invalid eval_tier` throw below, so a typo'd key in
  // such a body would be silently ignored rather than refused. Keep these two regexes in step.
  const block = /^\s*---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(specText ?? ""))?.[1] ?? "";
  const values = {};
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^['"]|['"]$/g, "").toLowerCase();
  }
  // DEFAULT: deterministic (AIO-573). The adversarial LLM layer is OPT-IN — a spec asks for it
  // with `eval_tier: full`, or a caller with `--adversarial` / `--tier full`.
  //
  // Why the default moved: the adversarial layer costs ~2-3 min per spec and is a stochastic
  // judge, so it was the slowest and least predictable part of authoring. The deterministic
  // layer — what/why present, acceptance criteria present, dependencies declared, scope stated,
  // paths resolve — is fast, offline, reproducible, and catches the omissions that actually
  // strand a cold-start builder. It STILL BLOCKS (exit 1). The gate did not get weaker; it got
  // predictable, and the expensive second opinion is now requested rather than imposed.
  const tier = values.eval_tier ?? "deterministic";
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

function buildFixPrompt(specText, findings, rubric, skillContext) {
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
    "## Stage skill",
    "",
    skillContext?.prompt ?? "(none)",
    "",
    `## Original candidate SHA-256\n\n${skillSha256(specText)}`,
    "",
    `## Declared builder skills\n\n${parseDeclaredSkills(specText).join(", ") || "(none)"}`,
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
  const prompt = buildFixPrompt(specText, findings, rubric, fixCfg?.skillContext);
  const text = await callPromptModel({
    model,
    prompt,
    timeoutMs: fixCfg?.timeoutMs ?? SPEC_PROMPT_TIMEOUT_MS,
  });
  return text.trim() || specText;
}

function renderSpecRevisionDiff(original, revised) {
  if (original === revised) return "";
  return [
    "--- original-spec.md",
    "+++ revised-spec.md",
    ...original.split("\n").map((line) => `-${line}`),
    ...revised.split("\n").map((line) => `+${line}`),
  ].join("\n");
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
  // Threaded into every internal evaluateSpec so the fix loop agrees with `aios spec eval` about
  // what a clean deterministic run means. Without it the loop reported NOT_EVALUATED on the
  // default (deterministic) path while the CLI called the same revised file SPEC_READY.
  tier = undefined,
  // Same tier-derived default as evaluateSpec — the two must not disagree about what an
  // undeclared tier means, which is the whole point of threading `tier` through here.
  useLlm = tier === undefined ? true : tier === "full",
  evalCfg = null,
  fixCfg = null,
  evalFn,
  reviseFn = defaultReviseFn,
  decisions = [],
  provenanceAware = false,
}) {
  const suitePath = path.join(repo, ".claude", "skill-suite.json");
  const skillContext = existsSync(suitePath)
    ? loadSkillContext({
        repo,
        ids: ["repair-spec-safely"],
        stage: "spec-fix",
        source: "workflow",
      })
    : null;
  if (existsSync(suitePath)) {
    const suite = loadSkillSuite({ repo });
    validateSkillSelection({
      suite,
      ids: parseDeclaredSkills(specText),
      stage: "builder",
      source: "spec",
    });
  }
  const resolvedFixCfg = skillContext ? { ...(fixCfg ?? {}), skillContext } : fixCfg;
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
      tier,
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
        fixCfg: resolvedFixCfg,
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
  const afterFindingKeys = new Set(
    result.findings.map((finding) =>
      JSON.stringify([finding.ruleId, finding.severity, finding.detail ?? finding.why ?? ""])
    )
  );
  const resolutionMap = before.findings.map((finding) => {
    const key = JSON.stringify([
      finding.ruleId,
      finding.severity,
      finding.detail ?? finding.why ?? "",
    ]);
    return {
      ruleId: finding.ruleId,
      severity: finding.severity,
      status:
        current === specText || afterFindingKeys.has(key)
          ? "unchanged"
          : "not-reported-after-revision",
    };
  });
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
    originalSha256: skillSha256(specText),
    revisedSha256: skillSha256(current),
    resolutionMap,
    revisionDiff: renderSpecRevisionDiff(specText, current),
    injectedSkills: skillContext?.audit ?? [],
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
 *  Never blocks — but never degrades SILENTLY either (AIO-594 F5): when the toolkit's compiled
 *  operator loop is unavailable, one stderr line names the cause and the fix, then [] is
 *  returned (the enrichment is advisory context, not a gate). The dist belongs to the TOOLKIT
 *  checkout (resolved via the toolkit seam), not the repo being evaluated. */
let warnedNoDecisionStore = false;
export async function loadRecentDecisions(repo, limit = 5) {
  const degrade = (reason) => {
    if (!warnedNoDecisionStore) {
      warnedNoDecisionStore = true;
      console.error(
        c.yellow(`spec-eval: EE4 decision enrichment unavailable — ${reason}. Evaluating on.`)
      );
    }
    return [];
  };
  try {
    const distPath = path.join(getToolkit().dir, "dist", "operator-loop", "index.js");
    if (!existsSync(distPath))
      return degrade(`${distPath} is missing (run \`npm run build:loop\` in the toolkit)`);
    const mod = await import(pathToFileURL(distPath).href);
    if (typeof mod.readDecisions !== "function")
      return degrade(`${distPath} exports no readDecisions()`);
    const { decisions } = mod.readDecisions(repo);
    return Array.isArray(decisions) ? decisions.slice(-limit) : [];
  } catch (e) {
    return degrade(e?.message ?? String(e));
  }
}

// ── aios issue template ─────────────────────────────────────────────────────────────────────

/** Resolve the canonical AIOS issue template for a repo checkout. */
export function resolveAiosIssueTemplate(repo) {
  const candidates = [
    path.join(repo, AIOS_ISSUE_TEMPLATE_REL),
    path.join(SCRIPT_DIR, "..", AIOS_ISSUE_TEMPLATE_REL),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** Render the AIOS issue template, optionally substituting the H1 title. */
export function renderAiosIssueTemplate(repo, { title } = {}) {
  const templatePath = resolveAiosIssueTemplate(repo);
  if (!templatePath) {
    throw new Error(`aios issue template not found (expected ${AIOS_ISSUE_TEMPLATE_REL})`);
  }
  let text = readFileSync(templatePath, "utf8");
  if (title) {
    text = text.replace(/^# TITLE — outcome-oriented slice name/m, `# ${title}`);
  }
  return text;
}

/** `aios spec init <path> [--title "..."]` — write an AIOS issue scaffold. */
export async function cmdSpecInit(repo, args) {
  const rest = args.slice();
  let title = null;
  let outPath = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--title" && rest[i + 1]) {
      title = rest[++i];
      continue;
    }
    if (!rest[i].startsWith("--") && !outPath) {
      outPath = rest[i];
    }
  }
  if (!outPath) {
    console.error(c.red('error: output path required — aios spec init <path> [--title "..."]'));
    process.exit(4);
  }
  const abs = path.isAbsolute(outPath) ? outPath : path.join(repo, outPath);
  if (existsSync(abs)) {
    console.error(c.red(`error: ${outPath} already exists`));
    process.exit(4);
  }
  const text = renderAiosIssueTemplate(repo, { title });
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
  console.log(`wrote ${outPath} (${text.length} chars)`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────

const SPEC_VALUE_FLAGS = ["--rubric", "--out", "--budget", "--tier", "--concurrency"];

const HELP = [
  "",
  c.blue("aios spec — spec/plan readiness harness (rubric: .claude/rubrics/spec-readiness.md)"),
  "",
  "usage:",
  "  aios spec eval <file|dir|glob> [--adversarial] [--tier full|deterministic] [--concurrency N] [--publishable] [--json] [--no-llm] [--rubric <path>]",
  "  aios spec fix  <file> [--adversarial] [--tier full|deterministic] [--budget N] [--write | --out <path>] [--no-llm] [--rubric <path>]",
  '  aios spec init <path> [--title "..."]  write aios-issue-template.md scaffold',
  "  aios spec author <plan> --slices <dir> [--out <dir>] [--concurrency N] [--model <id>] [--effort <level>] [--json]",
  "  aios spec publish AIO-<n> <candidate> --eval-artifact <json> --expected-remote-sha <sha256> [--dry-run]",
  "",
  "eval:  score a spec against the rubric (deterministic by default; --adversarial adds the LLM layer).",
  "       --publishable also requires a clean repository and emits a publishable artifact.",
  "fix:   iterate the spec through the bounded fix loop until it is ready (budget from rubric).",
  "       default writes <name>.improved.md; --write overwrites in place; --out <path> is explicit.",
  "",
  "exit codes:",
  "  0 SPEC_READY · 1 deterministic must-fail · 2 adversarial blocker ·",
  "  3 NOT_EVALUATED (asked for the LLM layer, e.g. --adversarial, and it did not run) · 4 usage/IO",
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
  if (sub === "publish") {
    try {
      process.exit(await cmdSpecPublish(repo, args));
    } catch (error) {
      console.error(c.red(`error: ${error.message}`));
      process.exit(4);
    }
    return;
  }
  const rest = args.slice(1);
  if (sub === "init") {
    await cmdSpecInit(repo, rest);
    return;
  }
  if (sub !== "eval" && sub !== "fix" && sub !== "author") {
    console.error(c.red(`error: unknown subcommand '${sub}' (expected eval|fix|init|author)`));
    process.exit(4);
  }
  if (sub === "author") {
    const models = resolveLoopModels({ repo });
    // Stays-core spec-author.mjs loads via the toolkit seam (AIO-594 F4).
    const { cmdSpecAuthor } = await loadToolkitModule("spec-author.mjs");
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
  // `--adversarial` is the ergonomic opt-in: it means "run the LLM layer too" without the caller
  // having to remember that the layer is spelled `--tier full`. An explicit --tier still wins.
  const adversarial = has("--adversarial");
  const requestedTier = flag("--tier") ?? (adversarial ? "full" : hints.tier);
  if (!["full", "deterministic"].includes(requestedTier)) {
    console.error(c.red(`error: invalid --tier '${requestedTier}' (expected full|deterministic)`));
    process.exit(4);
  }
  const deterministicTier = requestedTier === "deterministic";
  let hasFullTier = !deterministicTier;
  if (sub === "eval" && !flag("--tier") && !adversarial) {
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
    // `fix` needs a key regardless of eval tier: `eval_tier` selects the EVALUATOR layer, but the
    // REVISER is an LLM either way, and runFixLoop calls it on any NOT_READY. Gating this on the
    // tier let a default-tier fix skip the upfront exit-4 check and die later inside the model
    // call with a much worse error (AIO-573).
    (sub === "fix" && !noLlm && (!evalStubbed || !fixStubbed));

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
      // Precedence per candidate: explicit --tier > --adversarial > the spec's own declaration.
      const tier = flag("--tier") ?? (adversarial ? "full" : candidateHints.tier);
      const res = await evaluateSpec({
        specText: text,
        repo,
        rubric,
        tier,
        useLlm: !noLlm && tier !== "deterministic",
        evalCfg: models.spec_eval,
        decisions,
        requireCleanRepo: args.includes("--publishable"),
      });
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
                injectedSkills: res.injectedSkills,
                candidateSha256: res.candidateSha256,
                repoSha: res.repoSha,
                repoDirty: res.repoDirty,
                publishable: res.publishable,
              }
            : {
                exitCode,
                results: results.map(
                  ({
                    file: itemFile,
                    verdict,
                    exitCode: itemExit,
                    score,
                    tier,
                    injectedSkills,
                    candidateSha256,
                    repoSha,
                    repoDirty,
                    publishable,
                  }) => ({
                    file: itemFile,
                    verdict,
                    exitCode: itemExit,
                    score,
                    tier,
                    injectedSkills,
                    candidateSha256,
                    repoSha,
                    repoDirty,
                    publishable,
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
    tier: requestedTier,
    // `eval_provenance: adversarial-reviewed` is itself an opt-in: the documented behaviour is an
    // LLM pass before revisions, deterministic per-revision, then a final LLM confirmation. Those
    // bookends only run when useLlm is set, so a provenance-aware spec keeps them on the new
    // deterministic default rather than silently losing the contract it declared. It may only
    // rescue a tier that DEFAULTED to deterministic — an explicit `--tier deterministic` outranks
    // frontmatter here as everywhere else, and must not be talked out of making no model call.
    useLlm: !noLlm && (!deterministicTier || (!flag("--tier") && hints.planTraceable)),
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

  const resolutionPath = `${outPath}.resolution.json`;
  const diffPath = `${outPath}.diff`;
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, loop.revisedSpec);
    writeFileSync(
      resolutionPath,
      `${JSON.stringify(
        {
          originalSha256: loop.originalSha256,
          revisedSha256: loop.revisedSha256,
          findings: loop.resolutionMap,
        },
        null,
        2
      )}\n`
    );
    writeFileSync(diffPath, `${loop.revisionDiff}\n`);
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
          resolutionPath,
          diffPath,
          originalSha256: loop.originalSha256,
          revisedSha256: loop.revisedSha256,
          injectedSkills: loop.injectedSkills,
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
