#!/usr/bin/env node
// test/ship-cursor-model.test.mjs — the configured reviewer models MUST reach the right
// backend (Cursor CLI or DeepSeek's own API, chosen by model family) with the resolved
// model attached. Regression for the PR #129 High: plan_review/code_review models were
// resolved but never passed to callCursorAgent, so reviews silently ran on Cursor's default
// model, voiding the cross-family diversity guarantee. Extended 2026-07-04 when the
// defaults moved to deepseek-v4-pro (Cursor Ultra usage cap) to also cover the DeepSeek
// dispatch path, and an explicit override to confirm the Cursor path still works.
// No network/git/gh/claude — injected fakes.
// Run: node test/ship-cursor-model.test.mjs

import { runShip, SHIP_EXIT } from "../scripts/ship.mjs";
import { resolveLoopModels, DEFAULT_MODELS } from "../scripts/loop-models.mjs";
import { EXIT as BUILD_EXIT } from "../scripts/build.mjs";
import { stubSpecRubric } from "./ship-test-helpers.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    identifier: "AIO-163",
    title: "Add ship command",
    description: "Build the thing.",
    state: { name: "Todo", type: "unstarted" },
    children: [],
    comments: [],
    blockedBy: [],
  };
}

const greenChecks = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]);

function modelArgOf(call) {
  const i = call.extraArgs.indexOf("--model");
  return i === -1 ? null : call.extraArgs[i + 1];
}

function makeDeps({ repo, cursorCalls, deepseekCalls }) {
  return {
    repo,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async () => ({ identifier: "AIO-901" }),
      addComment: async () => ({ ok: true }),
    },
    resolveModels: resolveLoopModels,
    runBuild: async () => BUILD_EXIT.OK,
    cmdPr: async () => 77,
    cmdConsolidateFindings: async () => 0, // CLEAR
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON CONTEXT";
      if (/implementation plan/.test(prompt)) return PLAN_TEXT;
      if (/safety reviewer/.test(prompt)) return "reviewed\nSAFETY_APPROVED";
      return "generic";
    },
    callCursorAgent: async (prompt, _timeoutMs, opts = {}) => {
      cursorCalls.push({ prompt, extraArgs: opts.extraArgs ?? [] });
      if (prompt.includes("/review-plan")) return "looks good\nPLAN_READY";
      return "- `Low` `f`: nit";
    },
    callDeepSeekDirect: async (prompt, _timeoutMs, opts = {}) => {
      deepseekCalls.push({ prompt, model: opts.model });
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
      const dir = path.join(repo, ".aios", "loop", issue);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), String(text));
    },
    slug: "acme/repo",
    evaluateSpec: async () => ({
      verdict: "SPEC_READY",
      exitCode: 0,
      score: 100,
      deterministic: [],
      adversarial: { findings: [] },
      findings: [],
    }),
    loadRecentDecisions: async () => [],
    loadSpecRubric: () => stubSpecRubric(),
    makeAnthropic: async () => ({ fake: true }),
  };
}

console.log("reviewer models reach DeepSeek by default (plan_review + code_review)");
{
  const repo = mkdtempSync(path.join(tmpdir(), "ship-cursor-model-"));
  const cursorCalls = [];
  const deepseekCalls = [];
  try {
    const { code } = await runShip({
      repo,
      issue: "AIO-163",
      opts: {
        auto: true,
        autoMerge: true,
        maxFixRounds: 3,
        reviewers: ["bugbot", "gpt-5.5"],
        planRunner: "cli",
        dryRun: false,
      },
      deps: makeDeps({ repo, cursorCalls, deepseekCalls }),
    });
    check("run completes OK", code === SHIP_EXIT.OK);
    check("no calls went to the Cursor CLI", cursorCalls.length === 0);

    const planReviewCalls = deepseekCalls.filter((c) => c.prompt.includes("/review-plan"));
    const codeReviewCalls = deepseekCalls.filter((c) => !c.prompt.includes("/review-plan"));
    check("at least one plan-review DeepSeek call", planReviewCalls.length >= 1);
    check("at least one code-review DeepSeek call", codeReviewCalls.length >= 1);
    check(
      "plan-review call carries model = resolved plan_review model",
      planReviewCalls.every((c) => c.model === DEFAULT_MODELS.plan_review.model)
    );
    check(
      "code-review call carries model = resolved code_review model",
      codeReviewCalls.every((c) => c.model === DEFAULT_MODELS.code_review.model)
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log("an explicit Cursor-family override still reaches the Cursor argv");
{
  const repo = mkdtempSync(path.join(tmpdir(), "ship-cursor-model-cursor-"));
  const cursorCalls = [];
  const deepseekCalls = [];
  mkdirSync(path.join(repo, ".aios"), { recursive: true });
  writeFileSync(
    path.join(repo, ".aios", "loop-models.yaml"),
    "plan_review_model: cursor:gpt-5.5-high\ncode_review_model: cursor:gpt-5.5-high\n"
  );
  try {
    const { code } = await runShip({
      repo,
      issue: "AIO-163",
      opts: {
        auto: true,
        autoMerge: true,
        maxFixRounds: 3,
        reviewers: ["bugbot", "gpt-5.5"],
        planRunner: "cli",
        dryRun: false,
      },
      deps: makeDeps({ repo, cursorCalls, deepseekCalls }),
    });
    check("run completes OK", code === SHIP_EXIT.OK);
    check("no calls went to DeepSeek", deepseekCalls.length === 0);

    const planReviewCalls = cursorCalls.filter((c) => c.prompt.includes("/review-plan"));
    const codeReviewCalls = cursorCalls.filter((c) => !c.prompt.includes("/review-plan"));
    check("at least one plan-review cursor call", planReviewCalls.length >= 1);
    check("at least one GPT-review cursor call", codeReviewCalls.length >= 1);
    check(
      "plan-review call carries --model = gpt-5.5-high override",
      planReviewCalls.every((c) => modelArgOf(c) === "gpt-5.5-high")
    );
    check(
      "GPT-review call carries --model = gpt-5.5-high override",
      codeReviewCalls.every((c) => modelArgOf(c) === "gpt-5.5-high")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}ship-cursor-model tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}ship-cursor-model tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
