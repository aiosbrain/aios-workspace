#!/usr/bin/env node
// test/ship-spec-eval.test.mjs — spec-readiness gate in runShip (EE5 wired before plan).
// Run: node test/ship-spec-eval.test.mjs

import {
  runShip,
  SHIP_EXIT,
  buildSpecTextFromIssue,
  formatSpecEvalAudit,
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
    description: "## What\nShip must gate on spec readiness.\n\n## Acceptance criteria\n- `aios ship` exits 15 when NOT_READY.",
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
    linear: { getIssue: async () => makeIssue(), createIssue: async () => ({ identifier: "AIO-9" }) },
    resolveModels: resolveLoopModels,
    runBuild: async () => BUILD_EXIT.OK,
    cmdPr: async () => 77,
    cmdConsolidateFindings: async () => 0,
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON";
      if (/implementation plan/.test(prompt)) return PLAN_TEXT;
      return "generic";
    },
    callCursorAgent: async (prompt) =>
      prompt.includes("/review-plan") ? "ok\nPLAN_READY" : "nit",
    callDeepSeekDirect: async () => "ok\nPLAN_READY",
    waitForBots: () => 0,
    gitExec: (argv) => {
      if (argv[0] === "rev-parse") return "fakehead\n";
      return "";
    },
    ghExec: (argv) => {
      const a = argv.join(" ");
      if (a.includes("pr checks"))
        return { code: 0, stdout: JSON.stringify([{ name: "t", state: "SUCCESS", bucket: "pass" }]), stderr: "" };
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
    dryRun: false,
    resume: false,
    skipSpecGate: false,
    ...o,
  };
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

if (failed) {
  console.error(`\n${RED}${failed} failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all ship-spec-eval tests passed${NC}`);
