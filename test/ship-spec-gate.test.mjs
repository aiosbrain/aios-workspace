#!/usr/bin/env node
// test/ship-spec-gate.test.mjs — EE5 spec-readiness gate wired into ship (recon → spec_eval → plan).
// Covers: NOT_READY exits SPEC_NOT_READY + audit artifact; SPEC_READY proceeds; --skip-spec-gate
// bypasses; resume skips re-eval when checkpointed.
// Run: node test/ship-spec-gate.test.mjs

import {
  runShip,
  SHIP_EXIT,
  formatSpecEvalAudit,
} from "../scripts/ship.mjs";
import { resolveLoopModels } from "../scripts/loop-models.mjs";
import { EXIT as BUILD_EXIT } from "../scripts/build.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedSpecRubric } from "./helpers/seed-spec-rubric.mjs";

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

function makeIssue(description = "Build the thing with observable AC.") {
  return {
    identifier: "AIO-300",
    title: "Spec gate test",
    description,
    state: { name: "Todo", type: "unstarted" },
    children: [],
    comments: [],
    blockedBy: [],
  };
}

function makeDeps(over = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "ship-spec-gate-"));
  seedSpecRubric(repo);
  const auditFiles = [];
  const specEvalCalls = [];
  const greenChecks = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]);
  const deps = {
    repo,
    auditFiles,
    specEvalCalls,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async () => ({ identifier: "AIO-901" }),
      addComment: async () => ({ ok: true }),
    },
    resolveModels: resolveLoopModels,
    runBuild: async () => BUILD_EXIT.OK,
    cmdPr: async () => 77,
    cmdConsolidateFindings: async () => 0,
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON CONTEXT";
      if (/implementation plan/.test(prompt)) return PLAN_TEXT;
      if (/safety reviewer/.test(prompt)) return "reviewed\nSAFETY_APPROVED";
      return "generic";
    },
    callCursorAgent: async (prompt) => {
      if (prompt.includes("/review-plan")) return "looks good\nPLAN_READY";
      return "- `Low` `f`: nit";
    },
    callDeepSeekDirect: async (prompt) => {
      if (prompt.includes("/review-plan")) return "looks good\nPLAN_READY";
      return "- `Low` `f`: nit";
    },
    waitForBots: () => 0,
    gitExec: () => "",
    ghExec: (argv) => {
      const a = argv.join(" ");
      if (a.includes("pr checks")) return { code: 0, stdout: greenChecks, stderr: "" };
      if (a.includes("--name-only")) return { code: 0, stdout: "scripts/aios.mjs", stderr: "" };
      if (a.includes("pr diff")) return { code: 0, stdout: "diff --git a b", stderr: "" };
      if (a.includes("pr merge")) return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    gitLsFiles: () => new Set(["docs/brain-api.md", "scripts/aios.mjs"]),
    statFile: () => ({ size: 100 }),
    readFile: () => "file contents",
    confirm: async () => true,
    isTty: true,
    writeAudit: (issue, name, text) => {
      auditFiles.push(name);
      const dir = path.join(repo, ".aios", "loop", issue);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), String(text));
    },
    evaluateSpec: async (args) => {
      specEvalCalls.push(args);
      return {
        verdict: "SPEC_READY",
        exitCode: 0,
        score: 9,
        findings: [],
      };
    },
    loadRecentDecisions: async () => [],
    slug: "acme/repo",
  };
  return { ...deps, ...over, repo, auditFiles, specEvalCalls };
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

console.log("formatSpecEvalAudit — plain markdown audit body");
{
  const md = formatSpecEvalAudit(
    {
      verdict: "NOT_READY",
      score: 4,
      findings: [{ ruleId: "SR2", severity: "blocker", detail: "no observable AC" }],
    },
    "AIO-300"
  );
  check("includes verdict", /verdict: NOT_READY/.test(md));
  check("includes finding", /\[SR2\/blocker\]/.test(md));
}

console.log("NOT_READY → SPEC_NOT_READY + spec-eval-r1.md, plan never runs");
{
  let evalCalls = 0;
  const deps = makeDeps({
    evaluateSpec: async (args) => {
      evalCalls++;
      return {
        verdict: "NOT_READY",
        exitCode: 2,
        score: 3,
        findings: [{ ruleId: "SR2", severity: "blocker", detail: "missing AC" }],
      };
    },
    callClaudeAgent: async (prompt) => {
      if (/implementation plan/.test(prompt)) throw new Error("plan must not run");
      if (/recon context pack/.test(prompt)) return "RECON";
      return "generic";
    },
  });
  const { code, records } = await runShip({
    repo: deps.repo,
    issue: "AIO-300",
    opts: optsFor(),
    deps,
  });
  check("exit SPEC_NOT_READY", code === SHIP_EXIT.SPEC_NOT_READY);
  check("spec_eval stage recorded", records.stages.some((s) => s.stage === "spec_eval"));
  check("spec-eval-r1.md written", deps.auditFiles.includes("spec-eval-r1.md"));
  check("evaluateSpec called once", evalCalls === 1);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("SPEC_READY → proceeds to OK");
{
  const deps = makeDeps();
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-300",
    opts: optsFor(),
    deps,
  });
  check("exit OK", code === SHIP_EXIT.OK);
  check("spec-eval-r1.md written", deps.auditFiles.includes("spec-eval-r1.md"));
  check("evaluateSpec called", deps.specEvalCalls.length === 1);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("--skip-spec-gate bypasses evaluateSpec");
{
  const deps = makeDeps({
    evaluateSpec: async () => {
      throw new Error("must not run");
    },
  });
  const { code, records } = await runShip({
    repo: deps.repo,
    issue: "AIO-300",
    opts: optsFor({ skipSpecGate: true }),
    deps,
  });
  check("exit OK", code === SHIP_EXIT.OK);
  check("spec_eval skipped in records", records.stages.some((s) => s.stage === "spec_eval" && s.skipped));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("resume skips re-eval when specEval checkpointed");
{
  const store = { state: null };
  const deps = makeDeps({
    readState: () => store.state,
    writeState: (_issue, st) => {
      store.state = JSON.parse(JSON.stringify(st));
    },
    evaluateSpec: async () => {
      throw new Error("must not re-run on resume");
    },
  });
  store.state = {
    recon: "RECON FROM CHECKPOINT",
    specEval: { verdict: "SPEC_READY", score: 8 },
  };
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-300",
    opts: optsFor({ resume: true }),
    deps,
  });
  check("exit OK on resume", code === SHIP_EXIT.OK);
  rmSync(deps.repo, { recursive: true, force: true });
}

if (failed) {
  console.error(`\n${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`\n${GREEN}all ship-spec-gate checks passed${NC}`);
