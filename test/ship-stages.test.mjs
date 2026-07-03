#!/usr/bin/env node
// test/ship-stages.test.mjs — runShip end-to-end with injected fakes (no network/git/gh/claude).
// Covers: happy path → OK; deferred children created + deduped; audit files written; fix-loop
// non-convergence → REVIEW_NONCONVERGENCE (merge never called); CI-red at the gate →
// MERGE_BLOCKED; safety surface + withheld token → SAFETY_BLOCKED; non-TTY gates →
// PLAN_GATE_BLOCKED / MERGE_GATE_BLOCKED (confirm never called).
// Run: node test/ship-stages.test.mjs

import { runShip, SHIP_EXIT } from "../scripts/ship.mjs";
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
  return { auto: false, autoMerge: false, maxFixRounds: 3, reviewers: ["bugbot", "gpt-5.5"], planRunner: "cli", dryRun: false, ...o };
}

console.log("happy path → OK, deferred deduped, audit written, merge issued");
{
  const deps = makeDeps();
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor(), deps });
  check("code OK", code === SHIP_EXIT.OK);
  check("only 'Follow up B' created (A deduped)", JSON.stringify(deps.created) === JSON.stringify(["Follow up B"]));
  check("merge issued (gh pr merge)", deps.ghCalls.some((c) => c.includes("pr merge")));
  const issueDir = path.join(deps.repo, ".aios", "loop", "AIO-163");
  for (const f of ["task.md", "recon.md", "plan.md", "deferred.md", "ship-transcript.md"]) {
    check(`audit ${f} written`, existsSync(path.join(issueDir, f)));
  }
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log("fix-loop non-convergence → REVIEW_NONCONVERGENCE, merge never called");
{
  const deps = makeDeps({ cmdConsolidateFindings: async () => 3 }); // always BLOCKED
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor({ maxFixRounds: 1 }), deps });
  check("code REVIEW_NONCONVERGENCE", code === SHIP_EXIT.REVIEW_NONCONVERGENCE);
  check("merge never issued", !deps.ghCalls.some((c) => c.includes("pr merge")));
  check("no worktree removal (worktree preserved)", !deps.gitCalls.some((c) => c.startsWith("worktree remove")));
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
  check("merge never issued when safety withheld", !deps.ghCalls.some((c) => c.includes("pr merge")));
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
  const { code } = await runShip({ repo: deps.repo, issue: "AIO-163", opts: optsFor({ auto: true }), deps });
  check("code MERGE_GATE_BLOCKED", code === SHIP_EXIT.MERGE_GATE_BLOCKED);
  check("confirm never called", confirmCalled === false);
  check("merge never issued", !deps.ghCalls.some((c) => c.includes("pr merge")));
  rmSync(deps.repo, { recursive: true, force: true });
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
