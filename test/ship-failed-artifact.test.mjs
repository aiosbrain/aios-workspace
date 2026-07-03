#!/usr/bin/env node
// test/ship-failed-artifact.test.mjs — stage-runner deaths must fail LOUDLY into the audit
// trail, and the plan stage gets a realistic default timeout. Regression for AIO-194: the
// first real `aios ship` run was killed by the 600s plan timeout and left an audit directory
// that just stopped after recon — no artifact, no reason, indistinguishable from "never ran".
// No network/git/gh/claude — injected fakes. Run: node test/ship-failed-artifact.test.mjs

import { runShip, SHIP_EXIT, DEFAULT_PLAN_TIMEOUT_MS, failedArtifact } from "../scripts/ship.mjs";
import { resolveLoopModels } from "../scripts/loop-models.mjs";
import { EXIT as BUILD_EXIT } from "../scripts/build.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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

function makeIssue() {
  return {
    identifier: "AIO-194",
    title: "Fix the timeout",
    description: "Do the thing.",
    state: { name: "Todo", type: "unstarted" },
    children: [],
    comments: [],
    blockedBy: [],
  };
}

function makeDeps(repo, auditFiles, over = {}) {
  const greenChecks = JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass" }]);
  return {
    repo,
    linear: {
      getIssue: async () => makeIssue(),
      createIssue: async () => ({ identifier: "AIO-900" }),
      addComment: async () => ({ ok: true }),
    },
    resolveModels: resolveLoopModels,
    runBuild: async () => BUILD_EXIT.OK,
    cmdPr: async () => 77,
    cmdConsolidateFindings: async () => 0,
    callClaudeAgent: async () => "generic",
    callCursorAgent: async () => "looks good\nPLAN_READY",
    waitForBots: () => 0,
    gitExec: () => "",
    ghExec: () => ({ code: 0, stdout: greenChecks, stderr: "" }),
    gitLsFiles: () => new Set(["scripts/aios.mjs"]),
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
    ...over,
  };
}

const OPTS = {
  auto: true,
  autoMerge: true,
  maxFixRounds: 3,
  reviewers: ["bugbot", "gpt-5.5"],
  planRunner: "cli",
  dryRun: false,
};

console.log("default plan timeout is 1800s and reaches the claude call");
{
  check("DEFAULT_PLAN_TIMEOUT_MS === 1800s", DEFAULT_PLAN_TIMEOUT_MS === 1800 * 1000);
  const repo = mkdtempSync(path.join(tmpdir(), "ship-failed-"));
  const auditFiles = [];
  const timeouts = [];
  const deps = makeDeps(repo, auditFiles, {
    callClaudeAgent: async (prompt, timeoutMs) => {
      timeouts.push(timeoutMs);
      if (/recon context pack/.test(prompt)) return "RECON";
      if (/implementation plan/.test(prompt)) return "# Plan\n1. do it";
      if (/safety reviewer/.test(prompt)) return "reviewed\nSAFETY_APPROVED";
      return "generic";
    },
  });
  try {
    const { code } = await runShip({ repo, issue: "AIO-194", opts: OPTS, deps });
    check("run completes OK", code === SHIP_EXIT.OK);
    check(
      "plan claude call used the 1800s default (no config file)",
      timeouts.includes(DEFAULT_PLAN_TIMEOUT_MS)
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log("planner death writes plan-r1-FAILED.md with the reason");
{
  const repo = mkdtempSync(path.join(tmpdir(), "ship-failed-"));
  const auditFiles = [];
  const deps = makeDeps(repo, auditFiles, {
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON";
      throw new Error("claude timed out after 1800s");
    },
  });
  try {
    const { code } = await runShip({ repo, issue: "AIO-194", opts: OPTS, deps });
    check("exit is PLAN_UNAPPROVED", code === SHIP_EXIT.PLAN_UNAPPROVED);
    check("plan-r1-FAILED.md written", auditFiles.includes("plan-r1-FAILED.md"));
    const body = readFileSync(
      path.join(repo, ".aios", "loop", "AIO-194", "plan-r1-FAILED.md"),
      "utf8"
    );
    check("artifact carries the error", body.includes("claude timed out after 1800s"));
    check(
      "artifact points at the timeout knob",
      body.includes("plan_timeout_s") || body.includes("timeout_s")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log("plan reviewer death writes plan-review-r1-FAILED.md");
{
  const repo = mkdtempSync(path.join(tmpdir(), "ship-failed-"));
  const auditFiles = [];
  const deps = makeDeps(repo, auditFiles, {
    callClaudeAgent: async (prompt) => {
      if (/recon context pack/.test(prompt)) return "RECON";
      if (/implementation plan/.test(prompt)) return "# Plan\n1. do it";
      return "generic";
    },
    callCursorAgent: async () => {
      throw new Error("cursor agent timed out after 300s");
    },
  });
  try {
    const { code } = await runShip({ repo, issue: "AIO-194", opts: OPTS, deps });
    check("exit is PLAN_UNAPPROVED", code === SHIP_EXIT.PLAN_UNAPPROVED);
    check("plan-review-r1-FAILED.md written", auditFiles.includes("plan-review-r1-FAILED.md"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log("recon model death writes recon-FAILED.md");
{
  const repo = mkdtempSync(path.join(tmpdir(), "ship-failed-"));
  const auditFiles = [];
  const deps = makeDeps(repo, auditFiles, {
    callClaudeAgent: async () => {
      throw new Error("claude exited 1");
    },
  });
  try {
    const { code } = await runShip({ repo, issue: "AIO-194", opts: OPTS, deps });
    check("exit is RECON_FAILED", code === SHIP_EXIT.RECON_FAILED);
    check("recon-FAILED.md written", auditFiles.includes("recon-FAILED.md"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log("failedArtifact format");
{
  const text = failedArtifact("plan", new Error("boom"), Date.now() - 5000);
  check("has stage header", text.startsWith("# plan FAILED"));
  check("has error line", text.includes("boom"));
  check("has elapsed", /\d+s elapsed/.test(text));
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}ship-failed-artifact tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}ship-failed-artifact tests FAILED — ${failed} assertion(s)${NC}`);
process.exit(1);
