#!/usr/bin/env node
// test/ship-spec-eval.test.mjs — spec-readiness gate in runShip (EE5 wired before plan).
// Run: node test/ship-spec-eval.test.mjs

import {
  runShip,
  SHIP_EXIT,
  buildSpecTextFromIssue,
  buildLightPlanFromSpec,
  formatSpecEvalAudit,
  specSafetyFlag,
} from "../scripts/ship.mjs";
import { resolveLoopModels } from "../scripts/loop-models.mjs";
import { specEvalHints, evaluateSpec, runFixLoop } from "../scripts/spec-eval.mjs";
import {
  usableFrontmatterGate,
  auditSpecText,
  readSpecFrontmatter,
  badSpecFrontmatter,
  specEvalTier,
} from "../scripts/ship/gates.mjs";
import { EXIT as BUILD_EXIT } from "../scripts/build.mjs";
import { stubSpecRubric } from "./ship-test-helpers.mjs";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function seedRubric(repo) {
  const rubricSrc = path.join(REPO_ROOT, ".claude", "rubrics", "spec-readiness.md");
  const rubricDst = path.join(repo, ".claude", "rubrics", "spec-readiness.md");
  mkdirSync(path.dirname(rubricDst), { recursive: true });
  writeFileSync(rubricDst, readFileSync(rubricSrc, "utf8"));
}

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

const PLAN_TEXT = "# Plan\n1. do the thing\n";

function makeIssue() {
  return {
    identifier: "AIO-262",
    title: "Wire spec eval into ship",
    description:
      "## What\nShip must gate on spec readiness.\n\n## Acceptance criteria\n- `aios ship` exits 15 when NOT_READY.",
    state: { name: "Todo", type: "unstarted" },
    children: [],
    comments: [{ body: "BUILD PLAN: add tests.", author: { name: "agent" } }],
    blockedBy: [],
  };
}

function makeDeps(over = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "ship-spec-eval-"));
  seedRubric(repo);
  let evalCalls = 0;
  let evalInput = null;
  const evaluateResult = over.evaluateResult;
  const deps = {
    repo,
    evalCalls: () => evalCalls,
    evalInput: () => evalInput,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async () => ({ identifier: "AIO-9" }),
    },
    resolveModels: resolveLoopModels,
    resolveBugbotBase: () => ({ ok: true, baseSha: "test-base" }),
    runLocalPrePrReview: async () => ({ ok: true, output: "BUGBOT_CLEAR" }),
    runBuild: async () => BUILD_EXIT.OK,
    cmdPr: async () => 77,
    cmdConsolidateFindings: async () => 0,
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON";
      if (/implementation plan/.test(prompt)) return PLAN_TEXT;
      return "generic";
    },
    callCursorAgent: async (prompt) => (prompt.includes("/review-plan") ? "ok\nPLAN_READY" : "nit"),
    callDeepSeekDirect: async () => "ok\nPLAN_READY",
    waitForBots: () => 0,
    gitExec: (argv) => {
      if (argv[0] === "rev-parse") return "fakehead\n";
      return "";
    },
    ghExec: (argv) => {
      const a = argv.join(" ");
      if (a.includes("headRefOid")) return { code: 0, stdout: "fakehead\n", stderr: "" };
      if (a.includes("pr checks"))
        return {
          code: 0,
          stdout: JSON.stringify([{ name: "t", state: "SUCCESS", bucket: "pass" }]),
          stderr: "",
        };
      if (a.includes("--name-only")) return { code: 0, stdout: "README.md", stderr: "" };
      if (a.includes("pr diff")) return { code: 0, stdout: "diff --git a b", stderr: "" };
      if (a.includes("pr merge")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    gitLsFiles: () => new Set(["README.md"]),
    statFile: () => ({ size: 10 }),
    readFile: () => "file contents",
    confirm: async () => true,
    isTty: true,
    makeAnthropic: async () => ({ fake: true }),
    evaluateSpec: async (input) => {
      evalCalls++;
      evalInput = input;
      return (
        evaluateResult ?? {
          verdict: "SPEC_READY",
          exitCode: 0,
          score: 92,
          deterministic: [],
          adversarial: { findings: [] },
          findings: [],
        }
      );
    },
    loadRecentDecisions: async () => [],
    loadSpecRubric: () => stubSpecRubric(),
    writeAudit: (issue, name, text) => {
      const dir = path.join(repo, ".aios", "loop", issue);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), String(text));
    },
    slug: "acme/repo",
  };
  return { ...deps, ...over, repo };
}

function optsFor(o = {}) {
  return {
    auto: true,
    autoMerge: true,
    maxFixRounds: 3,
    reviewers: ["bugbot", "gpt-5.5"],
    planRunner: "cli",
    loop: "full",
    dryRun: false,
    resume: false,
    skipSpecGate: false,
    specGate: null,
    ...o,
  };
}

console.log("light-loop helpers preserve only the approved spec contract");
{
  const spec = `---\nsafety: true\n---\n\n## Interfaces\n- public API\n\n## Implementation\n- wire the route\n\n## Acceptance\n- command exits 0\n\n## Notes\nignore me`;
  const plan = buildLightPlanFromSpec(spec, { issue: "AIO-398" });
  check("frontmatter safety flag is recognized", specSafetyFlag(spec) === true);
  check(
    "safety flag only reads leading frontmatter",
    specSafetyFlag("# title\n---\nsafety: true\n---") === false
  );
  // H5 regression: ship must read the flag from the RAW issue body, because
  // buildSpecTextFromIssue prepends a `# <id>: <title>` heading that would push the
  // frontmatter off the start of the string (masking safety: true → fail-open).
  {
    const safetyIssue = { identifier: "AIO-999", title: "risky", description: spec };
    check(
      "buildSpecTextFromIssue masks the leading frontmatter (why the caller must not use it)",
      specSafetyFlag(buildSpecTextFromIssue(safetyIssue)) === false
    );
    check(
      "reading the flag from issue.description sees safety: true",
      specSafetyFlag(safetyIssue.description) === true
    );
  }
  check("includes interfaces", plan.includes("## Interfaces") && plan.includes("public API"));
  check(
    "includes implementation",
    plan.includes("## Implementation") && plan.includes("wire the route")
  );
  check("includes acceptance", plan.includes("## Acceptance") && plan.includes("command exits 0"));
  check("excludes unrelated sections", !plan.includes("ignore me"));
}

console.log("buildSpecTextFromIssue includes title, description, comments");
{
  const text = buildSpecTextFromIssue(makeIssue());
  check("title present", text.includes("AIO-262"));
  check("description present", text.includes("Ship must gate"));
  check("comment present", text.includes("BUILD PLAN"));
}

console.log("formatSpecEvalAudit renders verdict + findings");
{
  const md = formatSpecEvalAudit({
    verdict: "SPEC_READY",
    exitCode: 0,
    score: 88,
    findings: [],
  });
  check("verdict line", md.includes("verdict: SPEC_READY"));
  check("score line", md.includes("score: 88"));
}

console.log("NOT_READY → SPEC_NOT_READY (15), spec.md + spec-eval-r1.md written");
{
  const deps = makeDeps({
    evaluateResult: {
      verdict: "NOT_READY",
      exitCode: 2,
      score: 40,
      deterministic: [{ ruleId: "SR2", severity: "blocker", detail: "missing AC" }],
      adversarial: { findings: [] },
      findings: [{ ruleId: "SR2", severity: "blocker", detail: "missing AC" }],
    },
  });
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-262",
    opts: optsFor(),
    deps,
  });
  check("exit SPEC_NOT_READY", code === SHIP_EXIT.SPEC_NOT_READY);
  check("eval ran once", deps.evalCalls() === 1);
  const dir = path.join(deps.repo, ".aios", "loop", "AIO-262");
  check("spec.md written", existsSync(path.join(dir, "spec.md")));
  check("spec-eval-r1.md written", existsSync(path.join(dir, "spec-eval-r1.md")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("--spec-gate advisory: NOT_READY runs the eval, warns, but proceeds to build");
{
  const deps = makeDeps({
    evaluateResult: {
      verdict: "NOT_READY",
      exitCode: 2,
      score: 40,
      deterministic: [{ ruleId: "SR2", severity: "blocker", detail: "missing AC" }],
      adversarial: { findings: [] },
      findings: [{ ruleId: "SR2", severity: "blocker", detail: "missing AC" }],
    },
  });
  const { code, records } = await runShip({
    repo: deps.repo,
    issue: "AIO-262",
    opts: optsFor({ specGate: "advisory" }),
    deps,
  });
  check("advisory NOT_READY still reaches OK", code === SHIP_EXIT.OK);
  check("eval still ran (advisory is not skipping)", deps.evalCalls() === 1);
  check(
    "records the gate result as advisory",
    records.stages.some((s) => s.stage === "spec-eval" && s.advisory === true)
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("--spec-gate off bypasses evaluateSpec (named alias of --skip-spec-gate)");
{
  const deps = makeDeps();
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-262",
    opts: optsFor({ specGate: "off" }),
    deps,
  });
  check("reaches OK", code === SHIP_EXIT.OK);
  check("eval never called", deps.evalCalls() === 0);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("--skip-spec-gate bypasses evaluateSpec");
{
  const deps = makeDeps();
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-262",
    opts: optsFor({ skipSpecGate: true }),
    deps,
  });
  check("still reaches OK", code === SHIP_EXIT.OK);
  check("eval never called", deps.evalCalls() === 0);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("resume with specReady skips evaluateSpec");
{
  const deps = makeDeps();
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-262",
    opts: optsFor({ resume: true }),
    deps: {
      ...deps,
      readState: () => ({
        builderSkillContext: { source: "none", bytes: 0, skills: [] },
        specReady: true,
        recon: "RECON",
        plan: PLAN_TEXT,
        planReviewed: true,
      }),
    },
  });
  check("reaches OK", code === SHIP_EXIT.OK);
  check("eval skipped on resume", deps.evalCalls() === 0);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("SPEC_READY proceeds to plan/build");
{
  const deps = makeDeps();
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-262",
    opts: optsFor(),
    deps,
  });
  check("exit OK", code === SHIP_EXIT.OK);
  check("eval ran once", deps.evalCalls() === 1);
  check(
    "eval validates declarations from the raw issue frontmatter",
    deps.evalInput()?.skillDeclarationText === makeIssue().description
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("light loop skips recon + planner and resolves the pinned profile");
{
  let agentCalls = 0;
  let profile = null;
  let buildProfile = null;
  let consolidateArgs = null;
  const deps = makeDeps({
    resolveModels: (args) => {
      profile = args.profile;
      return resolveLoopModels(args);
    },
    callClaudeAgent: async () => {
      agentCalls++;
      return "unexpected planner or recon call";
    },
    runBuild: async ({ opts }) => {
      buildProfile = opts.profile;
      return BUILD_EXIT.OK;
    },
    cmdConsolidateFindings: async (_repo, args) => {
      consolidateArgs = args;
      return 0;
    },
  });
  const { code, records } = await runShip({
    repo: deps.repo,
    issue: "AIO-262",
    opts: optsFor({ loop: "light" }),
    deps,
  });
  check("reaches OK", code === SHIP_EXIT.OK);
  check("uses the light model profile", profile === "light");
  check("forwards the light profile to nested build dispatch", buildProfile === "light");
  check(
    "forwards --loop-profile light to consolidation",
    consolidateArgs?.[consolidateArgs.indexOf("--loop-profile") + 1] === "light"
  );
  check("does not call recon or planner agents", agentCalls === 0);
  check(
    "records recon as skipped",
    records.stages.some((s) => s.stage === "recon" && s.skipped)
  );
  check(
    "records a spec-derived plan",
    records.stages.some((s) => s.stage === "plan" && s.derived)
  );
  const plan = readFileSync(path.join(deps.repo, ".aios", "loop", "AIO-262", "plan.md"), "utf8");
  check("writes a spec-derived plan artifact", /light loop/.test(plan));
  rmSync(deps.repo, { recursive: true, force: true });
}

// ── AIO-573: ship honours the spec's declared eval tier, read from the RAW issue body ─────────
console.log("AIO-573 — eval tier + spec_gate are read from the raw issue body");
{
  // buildSpecTextFromIssue prepends `# <id>: <title>`, which pushes frontmatter off the start of
  // the string so `^---` never matches. That is the H5 trap already recorded above for `safety:`.
  // It was missed for `eval_tier`/`spec_gate`, so a `spec_gate:` declared in a Linear issue body
  // silently never reached ship. Pinned in both directions here.
  const body = "---\neval_tier: full\nspec_gate: advisory\n---\n\n## What\nx\n";
  const issue = { identifier: "AIO-1", title: "t", description: body, comments: [], children: [] };

  check(
    "the built spec text MASKS the frontmatter (this is why the raw body must be used)",
    specEvalHints(buildSpecTextFromIssue(issue)).tier === "deterministic" &&
      specEvalHints(buildSpecTextFromIssue(issue)).specGate === undefined
  );
  check(
    "the raw issue body exposes both keys",
    specEvalHints(body).tier === "full" && specEvalHints(body).specGate === "advisory"
  );
  check(
    "default (no frontmatter) is the deterministic tier — the layer is opt-in",
    specEvalHints("## What\nx\n").tier === "deterministic"
  );

  // Bugbot HIGH on the first cut: ship gates on `verdict !== "SPEC_READY"`, but a deterministic-
  // only run returns NOT_EVALUATED/3. The CLI normalised that and ship did not, so EVERY
  // default-tier spec the CLI called ready would have been rejected by ship. evaluateSpec now
  // owns the normalisation via `tier`, so both callers agree by construction.
  const det = await evaluateSpec({
    specText: "## What / why\nx\n\n## Acceptance criteria\n- `npm test` exits 0\n",
    repo: REPO_ROOT,
    rubric: { criteria: [], budget: 2 },
    tier: "deterministic",
  });
  check(
    "a clean deterministic run is SPEC_READY/0, not NOT_EVALUATED/3",
    det.verdict !== "NOT_EVALUATED" && det.exitCode !== 3
  );
  check(
    "tier alone drives useLlm — deterministic makes no model call",
    det.adversarial === undefined || det.adversarial === null
  );

  // Bugbot MEDIUM: `spec_gate: off` in the issue body only became reachable once ship started
  // reading the raw body, and validateShipArgs only blocks the CLI spellings.
  // Bugbot MEDIUM (round 2): `{}` on a parse error left tier undefined, which flips useLlm back
  // to true — a malformed spec would have silently re-opted INTO the adversarial layer.
  // Bugbot MEDIUM (round 3): specEvalHints is all-or-nothing, so a typo in ONE key discarded
  // every other key — `eval_tier: full` next to a bad `spec_gate` silently lost the adversarial
  // layer its author asked for. Refuse instead of guessing; `aios spec eval` exits 4 on the same
  // input, so this keeps ship consistent with the CLI.
  const bad = readSpecFrontmatter(specEvalHints, "---\neval_tier: full\nspec_gate: bogus\n---\n");
  check("malformed frontmatter is reported, not swallowed", typeof bad.invalid === "string");
  check(
    "…and ship refuses rather than running with a guessed tier",
    badSpecFrontmatter({ r: 1 }, { red: (x) => x }, bad.invalid).code === SHIP_EXIT.USAGE
  );
  check(
    "the returned defaults are still the parser's own, never `{}` (undefined tier ⇒ opt-IN)",
    bad.tier === "deterministic"
  );
  check(
    "valid frontmatter is still read through the helper",
    readSpecFrontmatter(specEvalHints, "---\neval_tier: full\n---\n").tier === "full"
  );

  // Bugbot round 4: runFixLoop never passed the declared tier, so `aios spec fix` on the default
  // path reported NOT_EVALUATED while `aios spec eval` called the same file SPEC_READY.
  // useLlm is deliberately NOT passed — the tier alone must derive it, exactly as evaluateSpec
  // does. Passing it explicitly made this assertion vacuous and hid the two defaults disagreeing.
  // reviseFn IS injected: the reviser is an LLM on ANY tier (it is not gated by useLlm), and this
  // spec evaluates NOT_READY, so the default would make a real network call from the test suite.
  const fixed = await runFixLoop({
    specText: "## What / why\nx\n\n## Acceptance criteria\n- `npm test` exits 0\n",
    repo: REPO_ROOT,
    rubric: { criteria: [], budget: 1 },
    tier: "deterministic",
    reviseFn: async ({ specText }) => specText,
  });
  check(
    "the fix loop agrees with `aios spec eval` on a clean deterministic run",
    fixed.afterVerdict !== "NOT_EVALUATED"
  );

  // Bugbot round 7: the audit copy is the documented recovery path
  // (`aios spec fix .aios/loop/<issue>/spec.md`), but buildSpecTextFromIssue hides the
  // frontmatter, so a spec declaring `eval_tier: full` would be re-run deterministic-only.
  const rawBody = "---\neval_tier: full\n---\n\n## What\nx\n";
  const audit = auditSpecText(rawBody, buildSpecTextFromIssue({ ...issue, description: rawBody }));
  check(
    "the audit spec.md stays re-runnable — its frontmatter survives",
    specEvalHints(audit).tier === "full"
  );
  check(
    "a spec with no frontmatter is passed through untouched",
    auditSpecText("## What\nx\n", "BODY") === "BODY"
  );

  // Bugbot round 5: the first cut of this guard ran BEFORE CLI precedence, so an issue body
  // saying `off` rejected the run even when the operator passed the very flag the error message
  // recommended. CLI always wins; frontmatter may soften, never disable, and never soften where
  // no human reads the warning.
  const quiet = { yellow: () => "" };
  check(
    "frontmatter `off` is not honoured (falls through to the config default)",
    usableFrontmatterGate("off", {}, quiet) === undefined
  );
  check(
    "an explicit --skip-spec-gate still wins over a frontmatter `off`",
    usableFrontmatterGate("off", { skipSpecGate: true }, quiet) === undefined
  );
  check(
    "an explicit --spec-gate outranks frontmatter entirely",
    usableFrontmatterGate("advisory", { specGate: "block" }, quiet) === undefined
  );
  check(
    "frontmatter `advisory` IS honoured interactively",
    usableFrontmatterGate("advisory", {}, quiet) === "advisory"
  );
  check(
    "frontmatter `advisory` is NOT honoured under --auto (nobody reads the warning)",
    usableFrontmatterGate("advisory", { auto: true }, quiet) === undefined
  );

  check(
    "`advisory` is still allowed from frontmatter — it RUNS and records, it just doesn't block",
    specEvalHints("---\nspec_gate: advisory\n---\n").specGate === "advisory"
  );

  // ── the parsers must agree that a frontmatter block EXISTS ────────────────────────────────
  // specSafetyFlag has always tolerated leading whitespace/CRLF; specEvalHints did not. While the
  // tier default was `full` that disagreement failed SAFE (a missed parse still ran the LLM
  // layer). Since the default is `deterministic` the same miss fails OPEN — it silently drops the
  // `eval_tier: full` the author wrote. Keep the two regexes in step.
  for (const [label, body] of [
    ["leading newline", "\n---\neval_tier: full\nsafety: true\n---\n\n## What\nx\n"],
    ["leading spaces", "  ---\neval_tier: full\nsafety: true\n---\n\n## What\nx\n"],
    ["CRLF", "---\r\neval_tier: full\r\nsafety: true\r\n---\r\n\r\n## What\r\nx\r\n"],
  ]) {
    check(
      `specEvalHints and specSafetyFlag agree a block exists (${label})`,
      specEvalHints(body).tier === "full" && specSafetyFlag(body) === true
    );
    check(
      `a bad eval_tier still REFUSES rather than silently defaulting (${label})`,
      (() => {
        try {
          specEvalHints(body.replace("eval_tier: full", "eval_tier: nonsense"));
          return false;
        } catch {
          return true;
        }
      })()
    );
  }

  // ── tier escalation: a spec may opt INTO full, never out of these two ─────────────────────
  check(
    "declared deterministic is honoured on a normal full-loop, non-safety ship",
    specEvalTier("deterministic", {}) === "deterministic"
  );
  check(
    "--loop light escalates to full — it has no planner, so this is the only model review",
    specEvalTier("deterministic", { lightLoop: true }) === "full"
  );
  check(
    "safety: true escalates to full",
    specEvalTier("deterministic", { safety: true }) === "full"
  );

  // ── auditSpecText must not mistake a leading horizontal rule for frontmatter ──────────────
  check(
    "auditSpecText re-emits a real frontmatter block",
    auditSpecText("---\neval_tier: full\n---\n\n## What\n", "# A: t\n\nbody").startsWith(
      "---\neval_tier: full\n---\n"
    )
  );
  check(
    "auditSpecText ignores a leading horizontal rule with no key: line",
    auditSpecText("---\n\nSome intro prose.\n\n---\n\n## What\n", "# A: t") === "# A: t"
  );

  // ── a malformed-frontmatter refusal must leave an audit trail ─────────────────────────────
  // SHIP_EXIT.USAGE is a `halt` in roadmap-run, and this returns before writeAudit, so the
  // record stream is the only place that says why an unattended run stopped.
  check(
    "badSpecFrontmatter records the aborted stage",
    (() => {
      const recs = { issue: "AIO-1", loop: "full", stages: [] };
      const r = badSpecFrontmatter(recs, { red: (x) => x }, "invalid eval_tier 'nonsense'");
      return (
        r.code === SHIP_EXIT.USAGE &&
        recs.stages.length === 1 &&
        recs.stages[0].stage === "spec-eval" &&
        /nonsense/.test(recs.stages[0].error)
      );
    })()
  );

  check(
    "readSpecFrontmatter survives an injected hints dep that always throws",
    (() => {
      const fm = readSpecFrontmatter(() => {
        throw new Error("boom");
      }, "anything");
      return fm.tier === "deterministic" && fm.invalid === "boom";
    })()
  );
}

if (failed) {
  console.error(`\n${RED}${failed} failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all ship-spec-eval tests passed${NC}`);
