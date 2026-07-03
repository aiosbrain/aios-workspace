#!/usr/bin/env node
// test/ship-cleanup.test.mjs — [R-Major-3] cleanup ordering.
// Git refuses to delete a branch checked out in a worktree, so the order MUST be:
// ff-only main → worktree remove → worktree prune → THEN branch -D. A dirty primary or a
// failed ff-only returns CLEANUP_FAILED and NEVER issues a reset/merge/clobber.
// Run: node test/ship-cleanup.test.mjs

import { runCleanup, SHIP_EXIT } from "../scripts/ship.mjs";

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

// A recording fake gitExec. `statusOut` seeds `git status --porcelain`; `throwOn` (a substring)
// makes the matching call throw. Returns "" for everything else.
function makeGit({ statusOut = "", throwOn = null } = {}) {
  const calls = [];
  const gitExec = (argv) => {
    calls.push(argv.join(" "));
    if (throwOn && argv.join(" ").includes(throwOn)) throw new Error(`git failed: ${throwOn}`);
    if (argv[0] === "status") return statusOut;
    return "";
  };
  return { gitExec, calls };
}

const ARGS = { repo: "/tmp/primary", branch: "feat/AIO-1-x", worktreePath: "/tmp/primary-feat-aio-1-x" };

console.log("happy path — correct ordering");
{
  const { gitExec, calls } = makeGit();
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK", res.code === SHIP_EXIT.OK);

  const idxFf = calls.findIndex((c) => c.includes("merge --ff-only"));
  const idxRemove = calls.findIndex((c) => c.startsWith("worktree remove"));
  const idxPrune = calls.findIndex((c) => c.startsWith("worktree prune"));
  const idxBranchDel = calls.findIndex((c) => c.startsWith("branch -D"));

  check("ff-only issued", idxFf >= 0);
  check("worktree remove after ff-only", idxRemove > idxFf);
  check("prune after worktree remove", idxPrune > idxRemove);
  check("branch -D is LAST, after worktree removal", idxBranchDel > idxRemove && idxBranchDel > idxPrune);
  check("branch delete never before worktree removal", !(idxBranchDel >= 0 && idxBranchDel < idxRemove));
}

console.log("dirty primary → CLEANUP_FAILED, nothing destructive issued");
{
  const { gitExec, calls } = makeGit({ statusOut: "M scripts/x.mjs" });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns CLEANUP_FAILED", res.code === SHIP_EXIT.CLEANUP_FAILED);
  check("no merge issued", !calls.some((c) => c.includes("merge")));
  check("no worktree remove issued", !calls.some((c) => c.startsWith("worktree remove")));
  check("no branch -D issued", !calls.some((c) => c.startsWith("branch -D")));
  check("no reset issued", !calls.some((c) => c.includes("reset")));
}

console.log("ff-only fails → CLEANUP_FAILED, no branch delete, no reset");
{
  const { gitExec, calls } = makeGit({ throwOn: "merge --ff-only" });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns CLEANUP_FAILED", res.code === SHIP_EXIT.CLEANUP_FAILED);
  check("no branch -D after ff failure", !calls.some((c) => c.startsWith("branch -D")));
  check("no worktree remove after ff failure", !calls.some((c) => c.startsWith("worktree remove")));
  check("no reset/clobber issued", !calls.some((c) => c.includes("reset")));
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
