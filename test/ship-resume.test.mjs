#!/usr/bin/env node
// test/ship-resume.test.mjs — checkpoint/resume + async gates (AIO-239).
// Covers: a blocked plan gate persists state + GATE-plan.pending and exits 22; `--resume
// --approve-plan` re-enters WITHOUT re-running recon/plan and completes; a blocked merge gate
// persists and `--resume --approve-merge` merges without re-running build/PR/review; the full
// plan file referenced in planner stdout is captured inline; the plan reviewer receives the
// prior round's required changes with a regression-check instruction; resolveGates 'approved'.
// Run: node test/ship-resume.test.mjs

import {
  runShip,
  resolveGates,
  findPlanFilePath,
  expandHomePath,
  buildPlanReviewPrompt,
  SHIP_EXIT,
} from "../scripts/ship.mjs";
import { resolveLoopModels } from "../scripts/loop-models.mjs";
import { EXIT as BUILD_EXIT } from "../scripts/build.mjs";
import { stubSpecRubric } from "./ship-test-helpers.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
const LOCAL_BUGBOT_ARTIFACT = path.join(
  REPO_ROOT,
  "test",
  "fixtures",
  "consolidate",
  "local-bugbot-clear.md"
);

function withExactReviewEvidence(state, { head = "fakehead", baseSha = "test-base" } = {}) {
  return {
    ...state,
    reviewClear: true,
    reviewHead: head,
    reviewBaseSha: baseSha,
    reviewSafetyRequired: false,
    reviewCodeRabbitRequired: false,
    reviewers: ["gpt-5.5"],
    localBugbotReviewPath: LOCAL_BUGBOT_ARTIFACT,
    localBugbotHead: head,
    localBugbotBaseSha: baseSha,
  };
}

function makeIssue() {
  return {
    identifier: "AIO-163",
    title: "Add ship command",
    description: "Build it.",
    state: { name: "Todo", type: "unstarted" },
    children: [],
    comments: [],
    blockedBy: [],
  };
}

// In-memory state store shared across "runs" to model --resume.
function makeStateStore() {
  const store = { state: null, gates: {}, removed: [] };
  return {
    store,
    readState: () => store.state,
    writeState: (_issue, st) => {
      store.state = JSON.parse(JSON.stringify(st));
    },
    writeGate: (_issue, name, text) => {
      store.gates[name] = text;
    },
    removeGate: (_issue, name) => {
      store.removed.push(name);
      delete store.gates[name];
    },
  };
}

function makeDeps(over = {}) {
  const repo = mkdtempSync(path.join(tmpdir(), "ship-resume-"));
  seedRubric(repo);
  const counters = { recon: 0, plan: 0, specEval: 0, build: 0, pr: 0, review: 0, local: 0 };
  const ghCalls = [];
  const gitCalls = [];
  const greenChecks = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]);
  const deps = {
    repo,
    counters,
    ghCalls,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async () => ({ identifier: "AIO-901" }),
      addComment: async () => ({ ok: true }),
    },
    resolveModels: resolveLoopModels,
    resolveBugbotBase: () => ({ ok: true, baseSha: "test-base" }),
    runLocalPrePrReview: async () => (counters.local++, { ok: true, output: "BUGBOT_CLEAR" }),
    runBuild: async () => (counters.build++, BUILD_EXIT.OK),
    cmdPr: async () => (counters.pr++, 77),
    cmdConsolidateFindings: async () => (counters.review++, 0), // CLEAR
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return (counters.recon++, "RECON CONTEXT");
      if (/implementation plan/.test(prompt)) return (counters.plan++, PLAN_TEXT);
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
      if (argv[0] === "rev-parse") return "fakehead\n"; // stable branch head for review checkpoints
      return "";
    },
    ghExec: (argv) => {
      const a = argv.join(" ");
      ghCalls.push(a);
      if (a.includes("pr checks")) return { code: 0, stdout: greenChecks, stderr: "" };
      if (a.includes("pr view") && a.includes("--json labels")) {
        return { code: 0, stdout: "ready-for-review\n", stderr: "" };
      }
      if (a.includes("--name-only")) return { code: 0, stdout: "README.md", stderr: "" };
      if (a.includes("pr diff")) return { code: 0, stdout: "diff --git a b", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    gitLsFiles: () => new Set(["README.md"]),
    statFile: () => ({ size: 10 }),
    readFile: () => "file contents",
    confirm: async () => true,
    isTty: false, // async-gate territory
    writeAudit: (issue, name, text) => {
      const dir = path.join(repo, ".aios", "loop", issue);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, name), String(text));
    },
    slug: "acme/repo",
    evaluateSpec: async () => {
      counters.specEval++;
      return {
        verdict: "SPEC_READY",
        exitCode: 0,
        score: 100,
        deterministic: [],
        adversarial: { findings: [] },
        findings: [],
      };
    },
    loadRecentDecisions: async () => [],
    loadSpecRubric: () => stubSpecRubric(),
    makeAnthropic: async () => ({ fake: true }),
  };
  return { ...deps, ...over, repo, counters, ghCalls, gitCalls };
}

function optsFor(o = {}) {
  return {
    auto: false,
    autoMerge: false,
    maxFixRounds: 3,
    reviewers: ["gpt-5.5"],
    planRunner: "cli",
    dryRun: false,
    resume: false,
    approvePlan: false,
    approveMerge: false,
    skipSpecGate: false,
    ...o,
  };
}

console.log("resolveGates: --approve-* yields 'approved'; --auto still wins");
{
  const g1 = resolveGates({ auto: false, autoMerge: false, approvePlan: true, isTty: false });
  check("plan approved via flag", g1.plan === "approved");
  check("merge still blocked", g1.merge === "blocked");
  const g2 = resolveGates({ auto: true, approvePlan: true, isTty: false });
  check("--auto wins over --approve-plan (skip)", g2.plan === "skip");
}

console.log("blocked plan gate → exit 22, state + GATE-plan.pending persisted, work done once");
console.log("…then --resume --approve-plan → completes WITHOUT re-running recon/plan");
{
  const ss = makeStateStore();
  const deps = makeDeps({ ...ss });
  const r1 = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("first run exits PLAN_GATE_BLOCKED", r1.code === SHIP_EXIT.PLAN_GATE_BLOCKED);
  check("recon ran once", deps.counters.recon === 1);
  check("plan ran once", deps.counters.plan === 1);
  check("state persisted with reviewer-approved plan", ss.store.state?.planReviewed === true);
  check("state records the gate as NOT operator-approved", ss.store.state?.planApproved === false);
  check(
    "GATE-plan.pending written with resume instructions",
    /--resume --approve-plan/.test(ss.store.gates.plan ?? "")
  );
  check("build never ran", deps.counters.build === 0);

  // Second "run": resume with the pending gate approved. Merge gate is auto to reach OK.
  const deps2 = makeDeps({ ...ss });
  const r2 = await runShip({
    repo: deps2.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, approvePlan: true, autoMerge: true }),
    deps: deps2,
  });
  check("resumed run reaches OK", r2.code === SHIP_EXIT.OK);
  check("recon NOT re-run", deps2.counters.recon === 0);
  check("spec eval NOT re-run", deps2.counters.specEval === 0);
  check("plan NOT re-run", deps2.counters.plan === 0);
  check("build ran on the resumed run", deps2.counters.build === 1);
  check("plan pending gate removed on approval", ss.store.removed.includes("plan"));
  check("merge recorded in state", ss.store.state?.merged === true);
  rmSync(deps.repo, { recursive: true, force: true });
  rmSync(deps2.repo, { recursive: true, force: true });
}

console.log(
  "blocked merge gate → exit 62 with state; --resume --approve-merge merges without re-work"
);
{
  const ss = makeStateStore();
  const deps = makeDeps({ ...ss });
  const r1 = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ auto: true }), // plan gate skipped; merge gate blocks (non-TTY)
    deps,
  });
  check("first run exits MERGE_GATE_BLOCKED", r1.code === SHIP_EXIT.MERGE_GATE_BLOCKED);
  check("PR number checkpointed", ss.store.state?.prNumber === 77);
  check("review CLEAR checkpointed", ss.store.state?.reviewClear === true);
  check("GATE-merge.pending written", /--resume --approve-merge/.test(ss.store.gates.merge ?? ""));
  check("merge never issued on the blocked run", !deps.ghCalls.some((a) => a.includes("pr merge")));

  const deps2 = makeDeps({ ...ss });
  const r2 = await runShip({
    repo: deps2.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, auto: true, approveMerge: true }),
    deps: deps2,
  });
  check("resumed run reaches OK", r2.code === SHIP_EXIT.OK);
  check("build NOT re-run", deps2.counters.build === 0);
  check("PR NOT re-opened", deps2.counters.pr === 0);
  check("consolidator NOT re-run", deps2.counters.review === 0);
  check(
    "merge issued on the resumed run",
    deps2.ghCalls.some((a) => a.includes("pr merge"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
  rmSync(deps2.repo, { recursive: true, force: true });
}

console.log("full plan file referenced in planner stdout is captured inline (R5b)");
{
  const ss = makeStateStore();
  const FULL = "# The full plan\n\nEvery detail lives here.";
  const deps = makeDeps({
    ...ss,
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON CONTEXT";
      if (/implementation plan/.test(prompt))
        return "Summary only. Full plan at /Users/x/.claude/plans/some-plan.md.";
      if (/safety reviewer/.test(prompt)) return "reviewed\nSAFETY_APPROVED";
      return "generic";
    },
    readFile: (p) => (p.includes(".claude/plans") ? FULL : "file contents"),
  });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ auto: true, autoMerge: true }),
    deps,
  });
  check("run OK", r.code === SHIP_EXIT.OK);
  check("captured full plan into state/plan text", (ss.store.state?.plan ?? "").includes(FULL));
  check(
    "capture is labeled with its source path",
    /Full plan \(captured from/.test(ss.store.state?.plan ?? "")
  );
}

console.log("findPlanFilePath: absolute + ~ forms; no false positive");
{
  check(
    "absolute path found",
    findPlanFilePath("saved to /Users/a/.claude/plans/x-y.md, done") ===
      "/Users/a/.claude/plans/x-y.md"
  );
  check(
    "~ path found",
    findPlanFilePath("wrote ~/.claude/plans/tidy-bubble.md") === "~/.claude/plans/tidy-bubble.md"
  );
  check("no match in plain prose", findPlanFilePath("no plans path here") === null);
}

console.log("plan review round ≥2 carries prior required changes + regression instruction (R5a)");
{
  const prompt = buildPlanReviewPrompt("PLAN v2", 2, 3, "- [Blocker] fix X\n- [Major] fix Y");
  check("prior review embedded", prompt.includes("[Blocker] fix X"));
  check("regression instruction present", /Regression check/.test(prompt));
  const r1 = buildPlanReviewPrompt("PLAN v1", 1, 3, null);
  check("round 1 has no regression section", !/Regression check/.test(r1));
}

console.log("expandHomePath: ~ expands against home (path.join keeps the prefix) — r1 evidence");
{
  check(
    "~/.claude path expands correctly",
    expandHomePath("~/.claude/plans/x.md", "/Users/alice") === "/Users/alice/.claude/plans/x.md"
  );
  check("absolute path untouched", expandHomePath("/etc/hosts", "/Users/alice") === "/etc/hosts");
}

console.log("fresh --approve-plan (no pending gate) → treated as pending, never a silent bypass");
{
  const ss = makeStateStore();
  const deps = makeDeps({ ...ss });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ approvePlan: true }), // NOT a resume; nothing pending
    deps,
  });
  check("exits PLAN_GATE_BLOCKED", r.code === SHIP_EXIT.PLAN_GATE_BLOCKED);
  check("pending gate written", !!ss.store.gates.plan);
  check("pending marker persisted", ss.store.state?.planGatePending === true);
  check("build never ran", deps.counters.build === 0);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("resume with state.merged → merge NOT re-attempted; cleanup still runs; exits OK");
{
  const ss = makeStateStore();
  ss.store.state = {
    recon: "RECON",
    specReady: true,
    plan: PLAN_TEXT,
    planReviewed: true,
    planApproved: true,
    followUpDone: true,
    buildDone: true,
    branch: "feat/AIO-163-old-title", // ALSO proves the checkpointed branch wins (r1 High)
    worktreePath: "/tmp/wt-old",
    prNumber: 77,
    reviewRound: 1,
    reviewClear: true,
    reviewHead: "fakehead",
    merged: true,
  };
  const deps = makeDeps({ ...ss });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, auto: true, autoMerge: true }),
    deps,
  });
  check("exits OK", r.code === SHIP_EXIT.OK);
  check("gh pr merge NOT re-issued", !deps.ghCalls.some((a) => a.includes("pr merge")));
  check(
    "cleanup targeted the CHECKPOINTED branch, not one recomputed from the title",
    deps.gitCalls.some((a) => a === "branch -D feat/AIO-163-old-title")
  );
  check(
    "cleanup targeted the checkpointed worktree",
    deps.gitCalls.some((a) => a.includes("worktree remove --force /tmp/wt-old"))
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("stale reviewClear (branch moved since checkpoint) → review re-runs before merge");
{
  const ss = makeStateStore();
  ss.store.state = {
    recon: "RECON",
    specReady: true,
    plan: PLAN_TEXT,
    planReviewed: true,
    planApproved: true,
    followUpDone: true,
    buildDone: true,
    branch: "feat/AIO-163-add-ship-command",
    worktreePath: "/tmp/wt",
    prNumber: 77,
    reviewRound: 1,
    reviewClear: true,
    reviewHead: "STALE-HEAD", // fake gitExec reports "fakehead" → mismatch
  };
  const deps = makeDeps({ ...ss });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, auto: true, autoMerge: true }),
    deps,
  });
  check("exits OK", r.code === SHIP_EXIT.OK);
  check("consolidator re-ran (stale CLEAR not honored)", deps.counters.review === 1);
  check(
    "fresh CLEAR re-checkpointed with the current head",
    ss.store.state?.reviewHead === "fakehead"
  );
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("verified base movement invalidates otherwise exact local evidence");
{
  const ss = makeStateStore();
  ss.store.state = withExactReviewEvidence({
    recon: "RECON",
    specReady: true,
    plan: PLAN_TEXT,
    planReviewed: true,
    planApproved: true,
    followUpDone: true,
    buildDone: true,
    branch: "feat/AIO-163-add-ship-command",
    worktreePath: "/tmp/wt",
    prNumber: 77,
    reviewRound: 1,
    simplifyDone: true,
  });
  const deps = makeDeps({
    ...ss,
    resolveBugbotBase: () => ({ ok: true, baseSha: "moved-base" }),
  });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, auto: true, autoMerge: true }),
    deps,
  });
  check("exits OK after refreshing evidence", r.code === SHIP_EXIT.OK);
  check("local Bugbot reruns once for the moved base", deps.counters.local === 1);
  check("consolidation reruns once", deps.counters.review === 1);
  check("new base SHA is checkpointed", ss.store.state?.reviewBaseSha === "moved-base");
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("stale CodeRabbit head cannot satisfy a resumed CLEAR checkpoint");
{
  const ss = makeStateStore();
  const reviewed = withExactReviewEvidence({
    recon: "RECON",
    specReady: true,
    plan: PLAN_TEXT,
    planReviewed: true,
    planApproved: true,
    followUpDone: true,
    buildDone: true,
    branch: "feat/AIO-163-add-ship-command",
    worktreePath: "/tmp/wt",
    prNumber: 77,
    reviewRound: 1,
    simplifyDone: true,
  });
  Object.assign(reviewed, {
    reviewers: ["coderabbit"],
    reviewCodeRabbitRequired: true,
    codeRabbitHead: "stale-head",
  });
  ss.store.state = reviewed;
  let waits = 0;
  const deps = makeDeps({ ...ss, waitForBots: () => (waits++, 0) });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, auto: true, autoMerge: true, reviewers: ["coderabbit"] }),
    deps,
  });
  check("exits OK after current-head CodeRabbit evidence", r.code === SHIP_EXIT.OK);
  check("exact local Bugbot evidence remains reusable", deps.counters.local === 0);
  check("CodeRabbit wait reruns", waits === 1);
  check(
    "stale CodeRabbit evidence triggers an explicit current-head review request",
    deps.ghCalls.some(
      (call) => call.includes("pr comment") && call.includes("@coderabbitai review")
    )
  );
  check("consolidation reruns", deps.counters.review === 1);
  check("fresh CodeRabbit head is checkpointed", ss.store.state?.codeRabbitHead === "fakehead");
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("resume with state.simplifyDone → simplify NOT re-run; ship completes");
{
  const ss = makeStateStore();
  ss.store.state = withExactReviewEvidence({
    recon: "RECON",
    specReady: true,
    plan: PLAN_TEXT,
    planReviewed: true,
    planApproved: true,
    followUpDone: true,
    buildDone: true,
    branch: "feat/AIO-163-add-ship-command",
    worktreePath: "/tmp/wt",
    prNumber: 77,
    reviewRound: 1,
    simplifyDone: true,
  });
  let simplifyCalls = 0;
  const deps = makeDeps({
    ...ss,
    runSimplify: async () => (
      simplifyCalls++,
      { changed: false, ok: true, reverted: false, output: "" }
    ),
  });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, auto: true, autoMerge: true }),
    deps,
  });
  check("exits OK", r.code === SHIP_EXIT.OK);
  check("simplify skipped on resume (checkpoint honored)", simplifyCalls === 0);
  check("exact-head local Bugbot artifact is reused", deps.counters.local === 0);
  check("consolidation is not re-run", deps.counters.review === 0);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("resume without simplifyDone but reviewClear intact → simplify DOES run");
{
  const ss = makeStateStore();
  ss.store.state = withExactReviewEvidence({
    recon: "RECON",
    specReady: true,
    plan: PLAN_TEXT,
    planReviewed: true,
    planApproved: true,
    followUpDone: true,
    buildDone: true,
    branch: "feat/AIO-163-add-ship-command",
    worktreePath: "/tmp/wt",
    prNumber: 77,
    reviewRound: 1,
  });
  let simplifyCalls = 0;
  const deps = makeDeps({
    ...ss,
    runSimplify: async () => (
      simplifyCalls++,
      { changed: false, ok: true, reverted: false, output: "noop" }
    ),
  });
  const r = await runShip({
    repo: deps.repo,
    issue: "AIO-163",
    opts: optsFor({ resume: true, auto: true, autoMerge: true }),
    deps,
  });
  check("exits OK", r.code === SHIP_EXIT.OK);
  check("simplify ran once (exact review was reused)", simplifyCalls === 1);
  check("local Bugbot did not rerun", deps.counters.local === 0);
  check("consolidation did not rerun", deps.counters.review === 0);
  check("simplifyDone checkpointed after the pass", ss.store.state?.simplifyDone === true);
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
