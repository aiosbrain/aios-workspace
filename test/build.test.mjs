#!/usr/bin/env node
// test/build.test.mjs — pure-function unit tests for the build phase (scripts/build.mjs).
// Zero-dep, no network, no Cursor. Run: node test/build.test.mjs
//
// Covers arg parsing, plan extraction from a relay --log, the MERGE_READY token
// matcher (incl. the PLAN_READY/MERGE_READY split that the loop keys on), branch
// slugging, and diff classification. The full loop is exercised in build-loop.test.mjs.

import {
  parseBuildArgs,
  extractPlanFromLog,
  detectMergeToken,
  slugify,
  classifyDiff,
  buildCodeReviewPrompt,
  buildImplementPrompt,
  EXIT,
} from "../scripts/build.mjs";
import { PLAN_READY_TOKEN, MERGE_READY_TOKEN } from "../scripts/relay-core.mjs";

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

console.log("parseBuildArgs");
{
  const a = parseBuildArgs([
    "plan.md",
    "feat/x",
    "--rounds",
    "6",
    "--merge",
    "--verify",
    "npm test",
    "--base",
    "main",
    "--build-timeout",
    "60",
  ]);
  check("plan-source positional", a.planSource === "plan.md");
  check("branch positional", a.branch === "feat/x");
  check("rounds parsed", a.rounds === 6);
  check("merge flag", a.merge === true);
  check("verify value", a.verify === "npm test");
  check("base value", a.base === "main");
  check("build-timeout → ms", a.buildTimeout === 60000);
  check("defaults: review timeout 300s", a.cursorTimeout === 300000);
  check("defaults: skill /ai-code-review", a.skill === "/ai-code-review");
  check("defaults: no merge off", parseBuildArgs(["p.md"]).merge === false);
  check("default rounds 4", parseBuildArgs(["p.md"]).rounds === 4);
  check("--task flag", parseBuildArgs(["do it", "--task"]).isTask === true);
  check(
    "value-flag value not taken as branch",
    parseBuildArgs(["p.md", "--base", "main"]).branch === undefined
  );
}

console.log("extractPlanFromLog");
{
  const log =
    "# aios relay plan\n\nTask: x\n\n---\n## Round 1 — Opus plan\n\nDRAFT\n\n---\n## Approved plan (round 2)\n\nFINAL PLAN BODY\n\n---\n## trailing\n\nz\n";
  check("prefers Approved plan section", extractPlanFromLog(log) === "FINAL PLAN BODY");
  const lastOnly =
    "# h\n\n---\n## Round 1 — Opus plan\n\nDRAFT\n\n---\n## Last plan (round limit reached — unapproved)\n\nPARTIAL\n";
  check("falls back to Last plan", extractPlanFromLog(lastOnly) === "PARTIAL");
  check(
    "uses whole file when no sections",
    extractPlanFromLog("just a raw task") === "just a raw task"
  );
  let threw = false;
  try {
    extractPlanFromLog("   \n  ");
  } catch {
    threw = true;
  }
  check("throws on empty", threw);
}

console.log("detectMergeToken");
{
  check("approves on trailing token", detectMergeToken("findings...\nMERGE_READY") === true);
  check(
    "tolerates trailing whitespace/blank lines",
    detectMergeToken("ok\n  MERGE_READY  \n\n") === true
  );
  check("rejects token mid-text", detectMergeToken("MERGE_READY\nmore text") === false);
  check("rejects when absent", detectMergeToken("Not ready to merge") === false);
  check(
    "build keys on MERGE_READY, not PLAN_READY",
    detectMergeToken("x\n" + PLAN_READY_TOKEN) === false
  );
  check("tokens are distinct", PLAN_READY_TOKEN !== MERGE_READY_TOKEN);
}

console.log("slugify");
{
  check(
    "lowercases + hyphenates",
    slugify("Add an aios Build Phase!! (v2)") === "add-an-aios-build-phase-v2"
  );
  check("empty → task", slugify("") === "task");
  check("caps length", slugify("x".repeat(100)).length <= 40);
}

console.log("classifyDiff");
{
  check("no-commits", classifyDiff({ totalCommits: 0, newCommits: 0 }) === "no-commits");
  check("no-progress", classifyDiff({ totalCommits: 3, newCommits: 0 }) === "no-progress");
  check("has-changes", classifyDiff({ totalCommits: 3, newCommits: 2 }) === "has-changes");
}

console.log("buildCodeReviewPrompt");
{
  const p = buildCodeReviewPrompt({
    skill: "/ai-code-review",
    plan: "PLAN",
    diff: "DIFF",
    diffStat: "STAT",
    logOneline: "abc commit",
    secretsResult: "clean",
    branch: "feat/x",
    round: 1,
    maxRounds: 4,
  });
  check("includes the skill", p.includes("/ai-code-review"));
  check("includes the original plan", p.includes("PLAN"));
  check("includes the diff", p.includes("DIFF"));
  check("includes the secrets evidence", p.includes("clean"));
  check("asks for MERGE_READY", p.includes(MERGE_READY_TOKEN));
  const last = buildCodeReviewPrompt({
    skill: "/ai-code-review",
    plan: "P",
    diff: "D",
    diffStat: "",
    logOneline: "",
    secretsResult: "",
    branch: "b",
    round: 4,
    maxRounds: 4,
  });
  check("final round still withholds on Critical/High", /Critical\/High/.test(last));
}

console.log("buildImplementPrompt");
{
  const base = buildImplementPrompt("PLAN BODY", { branch: "feat/x" });
  check("includes the plan", base.includes("PLAN BODY"));
  check("forbids secrets/abs paths", base.includes("/Users/"));
  check("forbids weakening validation/hooks", base.includes("validation/"));
  const fb = buildImplementPrompt("PLAN", { branch: "b", review: "FIX THIS" });
  check("appends reviewer feedback", fb.includes("FIX THIS"));
  const resume = buildImplementPrompt("PLAN", { branch: "b", resumeLog: "abc earlier work" });
  check(
    "includes resume context",
    resume.includes("abc earlier work") && resume.includes("do NOT redo")
  );
}

console.log("EXIT codes");
{
  check(
    "contract is stable",
    EXIT.OK === 0 &&
      EXIT.NONCONVERGENCE === 2 &&
      EXIT.NO_DIFF === 3 &&
      EXIT.GATE_FAILED === 4 &&
      EXIT.TIMEOUT === 124
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
