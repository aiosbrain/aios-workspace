#!/usr/bin/env node
// test/ship-stages.test.mjs — runShip end-to-end with injected fakes (no network/git/gh/claude).
// Covers: happy path → OK; deferred children created + deduped; audit files written; fix-loop
// non-convergence → REVIEW_NONCONVERGENCE (merge never called); CI-red at the gate →
// MERGE_BLOCKED; safety surface + withheld token → SAFETY_BLOCKED; non-TTY gates →
// PLAN_GATE_BLOCKED / MERGE_GATE_BLOCKED (confirm never called).
// Run: node test/ship-stages.test.mjs

import { runShip, SHIP_EXIT, SHIP_VERIFY_CMD, NO_TOOLS } from "../scripts/ship.mjs";
import { resolveLoopModels } from "../scripts/loop-models.mjs";
import { EXIT as BUILD_EXIT } from "../scripts/build.mjs";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
    waitForBots: () => 0,
    gitExec: (argv) => {
      gitCalls.push(argv.join(" "));
      if (argv[0] === "status") return ""; // clean primary
      return "";
    },
    ghExec: (argv) => {
      ghCalls.push(argv.join(" "));
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
    slug: "acme/repo",
  };
  // Apply overrides (shallow, but linear/nested handled by callers passing full objects).
  return { ...deps, ...over, repo, created, auditFiles, ghCalls, gitCalls };
}

function optsFor(o = {}) {
  return {
    auto: false,
    autoMerge: false,
    maxFixRounds: 3,
    reviewers: ["bugbot", "gpt-5.5"],
    planRunner: "cli",
    dryRun: false,
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

console.log("--reviewers bugbot → GPT review skipped; --reviewers gpt-5.5 → bugbot wait skipped");
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
  check("bugbot-only run still OK", code === SHIP_EXIT.OK);
  check("wait-for-bots ran for bugbot", wfbCalled === true);
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
    opts: optsFor({ reviewers: ["gpt-5.5"] }),
    deps: deps2,
  });
  check("gpt-only run still OK", code2 === SHIP_EXIT.OK);
  check("wait-for-bots skipped when bugbot dropped", wfb2 === false);
  check(
    "GPT review audit file written when gpt-5.5 kept",
    deps2.auditFiles.some((n) => n.startsWith("review-gpt"))
  );
  rmSync(deps2.repo, { recursive: true, force: true });
}

console.log(
  "bugbot gate: wait-for-bots gets --repo <slug>; timeout (2) fails closed → MERGE_BLOCKED"
);
{
  const deps = makeDeps();
  let wfbArgs = null;
  deps.waitForBots = (argv) => ((wfbArgs = argv), 2); // timeout → missing evidence → fail closed
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check(
    "timeout (exit 2) blocks merge (requested reviewer missing)",
    code === SHIP_EXIT.MERGE_BLOCKED
  );
  check("wait-for-bots received --repo slug", wfbArgs.join(" ").includes("--repo acme/repo"));
  check("wait-for-bots gated on cursor[bot]", wfbArgs.join(" ").includes("--bots cursor[bot]"));
  check(
    "merge never issued when Bugbot timed out",
    !deps.ghCalls.some((c) => c.includes("pr merge"))
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

console.log("bugbot gate: unexpected non-zero exit (1) → MERGE_BLOCKED, merge never issued");
{
  const deps = makeDeps();
  deps.waitForBots = () => 1; // usage/auth/repo-detection failure → gate could not run
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code MERGE_BLOCKED on wait-for-bots exit 1", code === SHIP_EXIT.MERGE_BLOCKED);
  check(
    "merge never issued when Bugbot gate could not run",
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

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
