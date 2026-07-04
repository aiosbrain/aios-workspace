#!/usr/bin/env node
// test/ship-cleanup.test.mjs — cleanup is BEST-EFFORT (AIO-239).
// The merge already happened when cleanup runs, so cleanup NEVER fails the run: worktree
// removal → prune → branch -D always proceed (in that order — git refuses to delete a branch
// checked out in a worktree), and the ff-only of the primary checkout is a convenience that is
// SKIPPED (with a reason) when the primary has local changes or the ff is not possible.
// Nothing here may ever issue a reset/clobber.
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

const ARGS = {
  repo: "/tmp/primary",
  branch: "feat/AIO-1-x",
  worktreePath: "/tmp/primary-feat-aio-1-x",
};

console.log("happy path — worktree/branch ordering + ff done");
{
  const { gitExec, calls } = makeGit();
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK", res.code === SHIP_EXIT.OK);
  check("ff performed on a clean primary", res.ffDone === true && !res.ffSkipped);

  const idxRemove = calls.findIndex((c) => c.startsWith("worktree remove"));
  const idxPrune = calls.findIndex((c) => c.startsWith("worktree prune"));
  const idxBranchDel = calls.findIndex((c) => c.startsWith("branch -D"));

  check("worktree remove issued", idxRemove >= 0);
  check("prune after worktree remove", idxPrune > idxRemove);
  check(
    "branch -D after worktree removal (git refuses otherwise)",
    idxBranchDel > idxRemove && idxBranchDel > idxPrune
  );
  check(
    "ff-only issued",
    calls.some((c) => c.includes("merge --ff-only"))
  );
  check("no reset issued", !calls.some((c) => c.includes("reset")));
}

console.log("dirty primary → still OK; ff SKIPPED; worktree/branch cleanup still runs");
{
  const { gitExec, calls } = makeGit({ statusOut: "M scripts/x.mjs" });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK (cleanup never fails the run)", res.code === SHIP_EXIT.OK);
  check("ff skipped with a reason", !!res.ffSkipped && /local changes/.test(res.ffSkipped));
  check("no merge issued into a dirty primary", !calls.some((c) => c.includes("merge")));
  check(
    "worktree remove STILL issued",
    calls.some((c) => c.startsWith("worktree remove"))
  );
  check(
    "branch -D STILL issued",
    calls.some((c) => c.startsWith("branch -D"))
  );
  check("no reset issued", !calls.some((c) => c.includes("reset")));
}

console.log("ff-only fails → still OK; skip reported; no reset");
{
  const { gitExec, calls } = makeGit({ throwOn: "merge --ff-only" });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK (ff failure is not a run failure)", res.code === SHIP_EXIT.OK);
  check("ff skip reason surfaced", !!res.ffSkipped && /ff-only not possible/.test(res.ffSkipped));
  check(
    "worktree remove STILL issued",
    calls.some((c) => c.startsWith("worktree remove"))
  );
  check(
    "branch -D STILL issued",
    calls.some((c) => c.startsWith("branch -D"))
  );
  check("no reset/clobber issued", !calls.some((c) => c.includes("reset")));
}

console.log("status read fails → still OK; ff skipped; cleanup still runs");
{
  const { gitExec, calls } = makeGit({ throwOn: "status" });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK", res.code === SHIP_EXIT.OK);
  check("ff skipped (cannot verify safety)", !!res.ffSkipped);
  check("no merge issued", !calls.some((c) => c.includes("merge --ff-only")));
  check(
    "worktree remove STILL issued",
    calls.some((c) => c.startsWith("worktree remove"))
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
