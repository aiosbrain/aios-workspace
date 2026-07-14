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
  const evaluateResult = over.evaluateResult;
  const deps = {
    repo,
    evalCalls: () => evalCalls,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async () => ({ identifier: "AIO-9" }),
    },
    resolveModels: resolveLoopModels,
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
    evaluateSpec: async () => {
      evalCalls++;
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
      readState: () => ({ specReady: true, recon: "RECON", plan: PLAN_TEXT, planReviewed: true }),
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

if (failed) {
  console.error(`\n${RED}${failed} failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all ship-spec-eval tests passed${NC}`);
