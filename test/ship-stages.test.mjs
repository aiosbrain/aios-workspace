#!/usr/bin/env node
// test/ship-stages.test.mjs — runShip end-to-end with injected fakes (no network/git/gh/claude).
// Covers: happy path → OK; deferred children created + deduped; audit files written; fix-loop
// non-convergence → REVIEW_NONCONVERGENCE (merge never called); CI-red at the gate →
// MERGE_BLOCKED; safety surface + withheld token → SAFETY_BLOCKED; non-TTY gates →
// PLAN_GATE_BLOCKED / MERGE_GATE_BLOCKED (confirm never called).
// Run: node test/ship-stages.test.mjs

import { runShip, SHIP_EXIT, SHIP_VERIFY_CMD, NO_TOOLS } from "../scripts/ship.mjs";
import { PLAN_DISALLOWED } from "../scripts/relay-core.mjs";
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

const PLAN_TEXT = [
  "# Plan",
  "1. do the thing",
  "",
  "## Deferred (out of scope)",
  "- Follow up A",
  "- Follow up B",
].join("\n");

// An issue whose only existing child is "Follow up A" (so A dedups, B is created).
function makeIssue() {
  return {
    identifier: "AIO-163",
    title: "Add ship command",
    description: "Build `docs/brain-api.md` awareness.",
    state: { name: "Todo", type: "unstarted" },
    children: [{ identifier: "AIO-900", title: "Follow up A", stateType: "unstarted" }],
    comments: [],
    blockedBy: [],
  };
}

// Build a full deps set; per-test overrides win. ghState controls the check board + merge.
function makeDeps(over = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "ship-stages-"));
  seedRubric(repo);
  const created = [];
  const auditFiles = [];
  const ghCalls = [];
  const gitCalls = [];

  const greenChecks = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]);

  const deps = {
    repo,
    created,
    auditFiles,
    ghCalls,
    gitCalls,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async ({ title }) => {
        created.push(title);
        return { identifier: `AIO-${900 + created.length}` };
      },
      addComment: async () => ({ ok: true }),
    },
    resolveModels: resolveLoopModels,
    resolveBugbotBase: () => ({ ok: true, baseSha: "test-base" }),
    runLocalPrePrReview: async () => ({ ok: true, output: "BUGBOT_CLEAR" }),
    runBuild: async () => BUILD_EXIT.OK,
    cmdPr: async () => 77,
    cmdConsolidateFindings: async () => 0, // CLEAR
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
    gitExec: (argv) => {
      gitCalls.push(argv.join(" "));
      if (argv[0] === "status") return ""; // clean primary
      if (argv[0] === "rev-parse") return "fakehead\n";
      return "";
    },
    ghExec: (argv) => {
      ghCalls.push(argv.join(" "));
      const a = argv.join(" ");
      if (a.includes("headRefOid")) return { code: 0, stdout: "fakehead\n", stderr: "" };
      if (a.includes("pr checks")) return { code: 0, stdout: greenChecks, stderr: "" };
      if (a.includes("pr view") && a.includes("--json labels")) {
        return { code: 0, stdout: "ready-for-review\n", stderr: "" };
      }
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
  // Apply overrides (shallow, but linear/nested handled by callers passing full objects).
  return { ...deps, ...over, repo, created, auditFiles, ghCalls, gitCalls };
}

function optsFor(o = {}) {
  return {
    auto: false,
    autoMerge: false,
    maxFixRounds: 3,
    reviewers: ["gpt-5.5"],
    planRunner: "cli",
    dryRun: false,
    skipSpecGate: false,
    ...o,
  };
}

console.log("happy path → OK, deferred deduped, audit written, merge issued");
{
  const deps = makeDeps();
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code OK", code === SHIP_EXIT.OK);
  check(
    "only 'Follow up B' created (A deduped)",
    JSON.stringify(deps.created) === JSON.stringify(["Follow up B"])
  );
  check(
    "merge issued (gh pr merge)",
    deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  const issueDir = path.join(deps.repo, ".aios", "loop", "AIO-163");
  for (const f of ["task.md", "recon.md", "plan.md", "deferred.md", "ship-transcript.md"]) {
    check(`audit ${f} written`, existsSync(path.join(issueDir, f)));
  }
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("local pre-PR Bugbot evidence is visible when it blocks");
{
  const evidence = "- Medium: operator-visible regression";
  const deps = makeDeps({
    runLocalPrePrReview: async () => ({
      ok: false,
      error: false,
      pass: "security",
      output: evidence,
    }),
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let code;
  try {
    ({ code } = await runShip({
      repo: deps.repo,
      issue: "AIO-163",
      opts: optsFor(),
      deps,
    }));
  } finally {
    console.error = originalError;
  }
  check("pre-PR finding blocks merge", code === SHIP_EXIT.MERGE_BLOCKED);
  check("pre-PR evidence is printed", errors.join("\n").includes(evidence));
  check("PR was not opened", !deps.ghCalls.some((call) => call.includes("pr create")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("--plan-runner sdk → plans via callOpus (SDK), not callClaudeAgent; still OK");
{
  let opusCalls = 0;
  let claudePlanCalls = 0;
  let anthropicMade = 0;
  const deps = makeDeps({
    callClaudeAgent: async (prompt) => {
      if (/implementation plan/.test(prompt)) claudePlanCalls++; // must NOT happen under sdk
      if (/recon context pack/.test(prompt)) return "RECON CONTEXT";
      if (/safety reviewer/.test(prompt)) return "reviewed\nSAFETY_APPROVED";
      return "generic";
    },
    makeAnthropic: async () => (anthropicMade++, { fake: true }),
    callOpus: async (_client, messages) => {
      opusCalls++;
      // The plan prompt is delivered as the single user message.
      check("callOpus got the plan prompt", /implementation plan/.test(messages[0].content));
      return PLAN_TEXT;
    },
  });
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ planRunner: "sdk" }),
    deps,
  });
  check("sdk run reaches OK", code === SHIP_EXIT.OK);
  check("callOpus drove the plan (>=1 call)", opusCalls >= 1);
  check("Anthropic client constructed once (lazy)", anthropicMade === 1);
  check("callClaudeAgent NOT used for the plan under sdk", claudePlanCalls === 0);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("fix-loop non-convergence → REVIEW_NONCONVERGENCE, merge never called");
{
  const deps = makeDeps({ cmdConsolidateFindings: async () => 3 }); // always BLOCKED
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ maxFixRounds: 1 }),
    deps,
  });
  check("code REVIEW_NONCONVERGENCE", code === SHIP_EXIT.REVIEW_NONCONVERGENCE);
  check("merge never issued", !deps.ghCalls.some((c) => c.includes("pr merge")));
  check(
    "no worktree removal (worktree preserved)",
    !deps.gitCalls.some((c) => c.startsWith("worktree remove"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("CI red at merge gate → MERGE_BLOCKED");
{
  const redChecks = JSON.stringify([{ name: "test", state: "FAILURE", bucket: "fail" }]);
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    if (argv.join(" ").includes("pr checks")) {
      deps.ghCalls.push(argv.join(" "));
      return { code: 1, stdout: redChecks, stderr: "" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code MERGE_BLOCKED", code === SHIP_EXIT.MERGE_BLOCKED);
  check("merge never issued on red CI", !deps.ghCalls.some((c) => c.includes("pr merge")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("safety surface + withheld token → SAFETY_BLOCKED");
{
  const deps = makeDeps({
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON";
      if (/implementation plan/.test(prompt)) return PLAN_TEXT;
      if (/safety reviewer/.test(prompt)) return "this diff weakens the leak gate — unsafe"; // no token
      return "generic";
    },
  });
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("--name-only")) {
      deps.ghCalls.push(a);
      return { code: 0, stdout: "hooks/pretooluse-secrets.sh", stderr: "" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code SAFETY_BLOCKED", code === SHIP_EXIT.SAFETY_BLOCKED);
  check(
    "merge never issued when safety withheld",
    !deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("non-TTY plan gate → PLAN_GATE_BLOCKED, confirm never called");
{
  let confirmCalled = false;
  const deps = makeDeps({ isTty: false, confirm: async () => ((confirmCalled = true), true) });
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code PLAN_GATE_BLOCKED", code === SHIP_EXIT.PLAN_GATE_BLOCKED);
  check("confirm never called", confirmCalled === false);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("non-TTY merge gate (plan auto) → MERGE_GATE_BLOCKED");
{
  let confirmCalled = false;
  const deps = makeDeps({ isTty: false, confirm: async () => ((confirmCalled = true), true) });
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ auto: true }),
    deps,
  });
  check("code MERGE_GATE_BLOCKED", code === SHIP_EXIT.MERGE_GATE_BLOCKED);
  check("confirm never called", confirmCalled === false);
  check("merge never issued", !deps.ghCalls.some((c) => c.includes("pr merge")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("failed `gh pr merge` (code≠0) → MERGE_BLOCKED, cleanup never runs");
{
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("pr merge")) {
      deps.ghCalls.push(a);
      return { code: 1, stdout: "", stderr: "Pull request is not mergeable" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code MERGE_BLOCKED on failed merge", code === SHIP_EXIT.MERGE_BLOCKED);
  check(
    "merge WAS attempted",
    deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  check(
    "worktree never removed after a failed merge",
    !deps.gitCalls.some((c) => c.startsWith("worktree remove"))
  );
  check(
    "local branch never deleted after a failed merge",
    !deps.gitCalls.some((c) => c.startsWith("branch -D"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("build runs the repo verify chain (verify wired into runBuild opts)");
{
  const capturedOpts = [];
  const deps = makeDeps({
    runBuild: async ({ opts }) => {
      capturedOpts.push(opts);
      return BUILD_EXIT.OK;
    },
  });
  await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("runBuild was called", capturedOpts.length > 0);
  check(
    "verify = the repo verify chain (not null)",
    capturedOpts.every((o) => o.verify === SHIP_VERIFY_CMD)
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("changed-path metadata unavailable at merge gate → MERGE_BLOCKED (fail closed)");
{
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("--name-only")) {
      deps.ghCalls.push(a);
      return { code: 1, stdout: "", stderr: "could not resolve PR" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code MERGE_BLOCKED when name-only unavailable", code === SHIP_EXIT.MERGE_BLOCKED);
  check(
    "merge never issued when changed paths unavailable",
    !deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("merge-time safety reclassification cannot bypass CodeRabbit");
{
  let nameOnlyReads = 0;
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("--name-only")) {
      deps.ghCalls.push(a);
      nameOnlyReads++;
      return {
        code: 0,
        stdout: nameOnlyReads === 1 ? "scripts/aios.mjs" : "hooks/pretooluse-secrets.sh",
        stderr: "",
      };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("safety policy drift blocks", code === SHIP_EXIT.SAFETY_BLOCKED);
  check("merge is never issued", !deps.ghCalls.some((call) => call.includes("pr merge")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("deprecated bugbot alias is a no-op; CodeRabbit is explicitly selectable");
{
  const deps = makeDeps();
  let wfbCalled = false;
  deps.waitForBots = () => ((wfbCalled = true), 0);
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ reviewers: ["bugbot"] }),
    deps,
  });
  check("deprecated-alias-only run still keeps mandatory local review", code === SHIP_EXIT.OK);
  check("deprecated alias does not select a remote bot", wfbCalled === false);
  check(
    "no GPT review audit file when gpt-5.5 dropped",
    !deps.auditFiles.some((n) => n.startsWith("review-gpt"))
  );
  rmSync(deps.repo, { recursive: true, force: true });

  const deps2 = makeDeps();
  let wfb2 = false;
  deps2.waitForBots = () => ((wfb2 = true), 0);
  const { code: code2 } = await runShip({
    repo: deps2.repo,
    issue: "AIO-163",
    opts: optsFor({ reviewers: ["coderabbit", "gpt-5.5"] }),
    deps: deps2,
  });
  check("CodeRabbit + GPT run still OK", code2 === SHIP_EXIT.OK);
  check("CodeRabbit selection runs wait-for-bots", wfb2 === true);
  check(
    "GPT review audit file written when gpt-5.5 kept",
    deps2.auditFiles.some((n) => n.startsWith("review-gpt"))
  );
  rmSync(deps2.repo, { recursive: true, force: true });
}

console.log("CodeRabbit gate: wait-for-bots gets --repo <slug>; timeout fails closed");
{
  let waitCalls = 0;
  const deps = makeDeps({
    cmdPr: async () => ({ number: 77, reused: true }),
  });
  let wfbArgs = null;
  deps.waitForBots = (argv) => {
    wfbArgs = argv;
    waitCalls++;
    return waitCalls === 1 ? 2 : 0;
  }; // first timeout → missing evidence → fail closed; resume succeeds
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ reviewers: ["coderabbit"] }),
    deps,
  });
  check(
    "timeout (exit 2) blocks merge (requested reviewer missing)",
    code === SHIP_EXIT.MERGE_BLOCKED
  );
  check("wait-for-bots received --repo slug", wfbArgs.join(" ").includes("--repo acme/repo"));
  check(
    "wait-for-bots gates only on CodeRabbit",
    wfbArgs.join(" ").includes("--bots coderabbitai[bot]")
  );
  check(
    "merge never issued when CodeRabbit timed out",
    !deps.ghCalls.some((c) => c.includes("pr merge"))
  );

  const resumed = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({
      resume: true,
      auto: true,
      autoMerge: true,
      reviewers: ["coderabbit"],
    }),
    deps,
  });
  const refreshRequests = deps.ghCalls.filter(
    (call) => call.includes("pr comment") && call.includes("@coderabbitai review")
  );
  check("resume succeeds once substantive evidence arrives", resumed.code === SHIP_EXIT.OK);
  check("timed-out refresh is requested again on resume", refreshRequests.length === 2);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("explicit CodeRabbit without ready-for-review label blocks immediately");
{
  const deps = makeDeps();
  let waited = false;
  const baseGh = deps.ghExec;
  deps.waitForBots = () => ((waited = true), 0);
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("pr view") && a.includes("--json labels")) {
      deps.ghCalls.push(a);
      return { code: 0, stdout: "", stderr: "" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ reviewers: ["coderabbit"] }),
    deps,
  });
  check("missing label blocks", code === SHIP_EXIT.MERGE_BLOCKED);
  check("wait command is not started without the trigger label", waited === false);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("safety surface rejects --auto-merge before review evidence can bypass the operator");
{
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("--name-only")) {
      deps.ghCalls.push(a);
      return { code: 0, stdout: "hooks/pretooluse-secrets.sh", stderr: "" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ autoMerge: true }),
    deps,
  });
  check("safety auto-merge is rejected", code === SHIP_EXIT.SAFETY_BLOCKED);
  check("merge is never issued", !deps.ghCalls.some((call) => call.includes("pr merge")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("fix push requests a fresh CodeRabbit review on the next round");
{
  let consolidationRound = 0;
  let waits = 0;
  const deps = makeDeps({
    cmdConsolidateFindings: async () => (++consolidationRound === 1 ? 3 : 0),
    waitForBots: () => (waits++, 0),
  });
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ reviewers: ["coderabbit"] }),
    deps,
  });
  check("ship converges after the fix", code === SHIP_EXIT.OK);
  check("CodeRabbit is awaited for both reviewed heads", waits === 2);
  check(
    "fresh review is explicitly requested after the push",
    deps.ghCalls.some(
      (call) => call.includes("pr comment") && call.includes("@coderabbitai review")
    )
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("reused PR push requests a fresh CodeRabbit review on the first round");
{
  const deps = makeDeps({
    cmdPr: async () => ({ number: 77, reused: true }),
  });
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ reviewers: ["coderabbit"] }),
    deps,
  });
  const requestIndex = deps.ghCalls.findIndex(
    (call) => call.includes("pr comment") && call.includes("@coderabbitai review")
  );
  const labelIndex = deps.ghCalls.findIndex(
    (call) => call.includes("pr view") && call.includes("--json labels")
  );
  check("reused PR still converges", code === SHIP_EXIT.OK);
  check("fresh review is requested on round one", requestIndex >= 0);
  check(
    "request follows positive-label verification",
    labelIndex >= 0 && requestIndex > labelIndex
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("GPT review failure → MERGE_BLOCKED (requested reviewer evidence missing)");
{
  const deps = makeDeps({
    callCursorAgent: async (prompt) => {
      if (prompt.includes("/review-plan")) return "looks good\nPLAN_READY";
      throw new Error("cursor GPT review crashed");
    },
    callDeepSeekDirect: async (prompt) => {
      if (prompt.includes("/review-plan")) return "looks good\nPLAN_READY";
      throw new Error("deepseek review crashed");
    },
  });
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code MERGE_BLOCKED on GPT review failure", code === SHIP_EXIT.MERGE_BLOCKED);
  check(
    "merge never issued when GPT review failed",
    !deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("GPT review with unavailable diff → MERGE_BLOCKED (fail closed)");
{
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    // Full `pr diff` (not --name-only) fails → no content for the GPT reviewer.
    if (a.includes("pr diff") && !a.includes("--name-only")) {
      deps.ghCalls.push(a);
      return { code: 1, stdout: "", stderr: "could not fetch diff" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code MERGE_BLOCKED when GPT diff unavailable", code === SHIP_EXIT.MERGE_BLOCKED);
  check("merge never issued", !deps.ghCalls.some((c) => c.includes("pr merge")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("CodeRabbit gate: unexpected non-zero exit → MERGE_BLOCKED");
{
  const deps = makeDeps();
  deps.waitForBots = () => 1; // usage/auth/repo-detection failure → gate could not run
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ reviewers: ["coderabbit"] }),
    deps,
  });
  check("code MERGE_BLOCKED on wait-for-bots exit 1", code === SHIP_EXIT.MERGE_BLOCKED);
  check(
    "merge never issued when CodeRabbit gate could not run",
    !deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("recon + safety run with NO filesystem tools (prompt-injection blast radius = 0)");
{
  // Recon/safety_review synthesize over untrusted, pre-injected content (Linear text; PR diff).
  // They must be handed a default-deny tool stance so a prompt-injection payload cannot make the
  // agent read arbitrary repo files (e.g. `.env`) outside the tracked-only allow list.
  const seen = [];
  const deps = makeDeps({
    callClaudeAgent: async (prompt, _timeout, opts = {}) => {
      const extra = (opts.extraArgs ?? []).join(" ");
      if (/recon context pack/.test(prompt)) {
        seen.push({ step: "recon", extra });
        return "RECON CONTEXT";
      }
      if (/implementation plan/.test(prompt)) return PLAN_TEXT;
      if (/safety reviewer/.test(prompt)) {
        seen.push({ step: "safety", extra });
        return "reviewed\nSAFETY_APPROVED";
      }
      return "generic";
    },
  });
  // Force the safety surface so safety_review actually runs.
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("--name-only")) {
      deps.ghCalls.push(a);
      return { code: 0, stdout: "hooks/pretooluse-secrets.sh", stderr: "" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("run reaches OK with restricted recon/safety", code === SHIP_EXIT.OK);
  const recon = seen.find((s) => s.step === "recon");
  const safety = seen.find((s) => s.step === "safety");
  check("recon step observed", !!recon);
  check("safety step observed", !!safety);
  const restricted = (s) =>
    s &&
    s.extra.includes("--permission-mode plan") &&
    s.extra.includes("--disallowedTools") &&
    NO_TOOLS.every((t) => s.extra.includes(t));
  check("recon gets --permission-mode plan + every tool disallowed", restricted(recon));
  check("safety gets --permission-mode plan + every tool disallowed", restricted(safety));
  // A read/exec tool must NOT be handed to these steps as allowed.
  check("recon never passes --allowedTools", recon && !recon.extra.includes("--allowedTools"));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("plan (cli runner) runs at the read-only PLAN_DISALLOWED tier (F4)");
{
  // The plan prompt embeds recon (derived from untrusted Linear text). The planner may READ the
  // repo (Read/Grep/Glob stay allowed) but must not Bash/Write/Edit/WebFetch/WebSearch/Task —
  // stricter than the old bare `--permission-mode plan`. Guard against a silent revert.
  let planExtra = null;
  const deps = makeDeps({
    callClaudeAgent: async (prompt, _timeout, opts = {}) => {
      if (/recon context pack/.test(prompt)) return "RECON CONTEXT";
      if (/implementation plan/.test(prompt)) {
        planExtra = (opts.extraArgs ?? []).join(" ");
        return PLAN_TEXT;
      }
      if (/safety reviewer/.test(prompt)) return "reviewed\nSAFETY_APPROVED";
      return "generic";
    },
  });
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ planRunner: "cli" }),
    deps,
  });
  check("run reaches OK with plan-tier planner", code === SHIP_EXIT.OK);
  check("plan step observed", planExtra != null);
  check(
    "plan gets --permission-mode plan",
    planExtra && planExtra.includes("--permission-mode plan")
  );
  check("plan gets --disallowedTools", planExtra && planExtra.includes("--disallowedTools"));
  check(
    "plan disallows every exfil/mutate/delegate tool",
    planExtra && PLAN_DISALLOWED.every((t) => planExtra.includes(t))
  );
  // Read/Grep/Glob must remain AVAILABLE — they are NOT in the disallow list.
  for (const allowed of ["Read", "Grep", "Glob"]) {
    check(`plan keeps ${allowed} available (not disallowed)`, !PLAN_DISALLOWED.includes(allowed));
  }
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("simplify stage (8b): runs after review CLEAR, before the merge gate");
{
  const order = [];
  const deps = makeDeps({
    runSimplify: async ({ worktree, verify, constitution }) => {
      order.push("simplify");
      check("simplify gets the ship verify chain", verify === SHIP_VERIFY_CMD);
      check("simplify gets a worktree path", typeof worktree === "string" && worktree.length > 0);
      void constitution; // may be null in the temp repo (no constitution doc) — that's valid
      return { changed: false, ok: true, reverted: false, output: "noop" };
    },
    cmdConsolidateFindings: async () => (order.push("review"), 0),
  });
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    if (argv.join(" ").includes("pr merge")) order.push("merge");
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("run reaches OK", code === SHIP_EXIT.OK);
  check(
    "order is review → simplify → merge",
    JSON.stringify(order) === JSON.stringify(["review", "simplify", "merge"])
  );
  check("simplify.md audit written", deps.auditFiles.includes("simplify.md"));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("simplify --no-simplify → stage skipped entirely");
{
  let called = 0;
  const deps = makeDeps({
    runSimplify: async () => (called++, { changed: false, ok: true, reverted: false, output: "" }),
  });
  const { code } = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ noSimplify: true }),
    deps,
  });
  check("run reaches OK", code === SHIP_EXIT.OK);
  check("runSimplify never called", called === 0);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("simplify kept a cleanup → re-push + exact-head review invalidated");
{
  let prCalls = 0;
  const states = [];
  const deps = makeDeps({
    runSimplify: async () => ({ changed: true, ok: true, reverted: false, output: "tidied" }),
    cmdPr: async () => (prCalls++, 77),
    writeState: (_issue, st) => states.push(JSON.parse(JSON.stringify(st))),
    gitExec: (argv) => (argv[0] === "rev-parse" ? "newhead" : ""),
  });
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("run pauses for a fresh review", code === SHIP_EXIT.MERGE_BLOCKED);
  check("PR re-pushed after cleanup (pr called twice)", prCalls === 2);
  const last = states.findLast((s) => s.simplifyDone);
  check("simplifyDone persisted", last?.simplifyDone === true);
  check("prior CLEAR head is invalidated", last?.reviewClear === false && last?.reviewHead == null);
  check("prior local artifact is invalidated", last?.localBugbotReviewPath == null);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("simplify reverted (verify failed downstream) → ship still merges (advisory)");
{
  const deps = makeDeps({
    runSimplify: async () => ({ changed: false, ok: false, reverted: true, output: "bad pass" }),
  });
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("run reaches OK despite discarded pass", code === SHIP_EXIT.OK);
  check(
    "merge still issued",
    deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("simplify push failure → cleanup dropped, ship proceeds from the reviewed head");
{
  let prCalls = 0;
  const gitCalls = [];
  const deps = makeDeps({
    runSimplify: async () => ({ changed: true, ok: true, reverted: false, output: "tidied" }),
    cmdPr: async () => {
      prCalls++;
      if (prCalls >= 2) throw new Error("push rejected");
      return 77;
    },
    gitExec: (argv) => {
      gitCalls.push(argv.join(" "));
      if (argv[0] === "rev-parse") return "fakehead";
      return "";
    },
  });
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("run still reaches OK", code === SHIP_EXIT.OK);
  check(
    "stranded local cleanup reset to the reviewed head",
    gitCalls.some((c) => c.startsWith("reset --hard fakehead"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("remote PR head drift after review → MERGE_BLOCKED (merge never issued)");
{
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("headRefOid")) {
      deps.ghCalls.push(a);
      // Someone pushed to the PR branch on GitHub after the local review.
      return { code: 0, stdout: "remotedrifthead\n", stderr: "" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("remote head drift blocks the merge", code === SHIP_EXIT.MERGE_BLOCKED);
  check("merge never issued on remote drift", !deps.ghCalls.some((c) => c.includes("pr merge")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("unreadable remote PR head → MERGE_BLOCKED (fail closed)");
{
  const deps = makeDeps();
  const baseGh = deps.ghExec;
  deps.ghExec = (argv) => {
    const a = argv.join(" ");
    if (a.includes("headRefOid")) {
      deps.ghCalls.push(a);
      return { code: 1, stdout: "", stderr: "api unavailable" };
    }
    return baseGh(argv);
  };
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("unverifiable remote head blocks the merge", code === SHIP_EXIT.MERGE_BLOCKED);
  check(
    "merge never issued when the remote head cannot be read",
    !deps.ghCalls.some((c) => c.includes("pr merge"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
