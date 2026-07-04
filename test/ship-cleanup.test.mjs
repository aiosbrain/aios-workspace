#!/usr/bin/env node
// test/ship-cleanup.test.mjs — [R-Major-3] cleanup ordering + AIO-186 F1/F3.
// Git refuses to delete a branch checked out in a worktree, so the order MUST be:
// checkout main → ff-only main → worktree remove → worktree prune → THEN branch -D. A dirty
// primary or a failed checkout/ff-only returns CLEANUP_FAILED and NEVER issues a reset/merge/
// clobber. F3: the worktree removed is the one git ACTUALLY has for the branch, not a recompute.
// Run: node test/ship-cleanup.test.mjs

import { runCleanup, resolveWorktreePathFromList, SHIP_EXIT } from "../scripts/ship.mjs";

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

// A recording fake gitExec. `statusOut` seeds `git status --porcelain`; `worktreeList` seeds
// `git worktree list --porcelain`; `throwOn` (a substring) makes the matching call throw. Returns
// "" for everything else.
function makeGit({ statusOut = "", worktreeList = "", throwOn = null } = {}) {
  const calls = [];
  const gitExec = (argv) => {
    calls.push(argv.join(" "));
    if (throwOn && argv.join(" ").includes(throwOn)) throw new Error(`git failed: ${throwOn}`);
    if (argv[0] === "status") return statusOut;
    if (argv[0] === "worktree" && argv[1] === "list") return worktreeList;
    return "";
  };
  return { gitExec, calls };
}

const ARGS = {
  repo: "/tmp/primary",
  branch: "feat/AIO-1-x",
  worktreePath: "/tmp/primary-feat-aio-1-x",
};

console.log("happy path — correct ordering");
{
  const { gitExec, calls } = makeGit();
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK", res.code === SHIP_EXIT.OK);

  const idxCheckout = calls.findIndex((c) => c === "checkout main");
  const idxFf = calls.findIndex((c) => c.includes("merge --ff-only"));
  const idxRemove = calls.findIndex((c) => c.startsWith("worktree remove"));
  const idxPrune = calls.findIndex((c) => c.startsWith("worktree prune"));
  const idxBranchDel = calls.findIndex((c) => c.startsWith("branch -D"));

  check("checkout main issued", idxCheckout >= 0);
  check("checkout main BEFORE ff-only (F1)", idxCheckout >= 0 && idxCheckout < idxFf);
  check("ff-only issued", idxFf >= 0);
  check("worktree remove after ff-only", idxRemove > idxFf);
  check("prune after worktree remove", idxPrune > idxRemove);
  check(
    "branch -D is LAST, after worktree removal",
    idxBranchDel > idxRemove && idxBranchDel > idxPrune
  );
  check(
    "branch delete never before worktree removal",
    !(idxBranchDel >= 0 && idxBranchDel < idxRemove)
  );
}

console.log("F1: checkout main fails → CLEANUP_FAILED, nothing destructive issued");
{
  const { gitExec, calls } = makeGit({ throwOn: "checkout main" });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns CLEANUP_FAILED", res.code === SHIP_EXIT.CLEANUP_FAILED);
  check("reason mentions checkout main", /checkout main/.test(res.reason));
  check("no ff-only after failed checkout", !calls.some((c) => c.includes("merge --ff-only")));
  check("no worktree remove issued", !calls.some((c) => c.startsWith("worktree remove")));
  check("no branch -D issued", !calls.some((c) => c.startsWith("branch -D")));
  check("no reset issued", !calls.some((c) => c.includes("reset")));
}

console.log("F3: removes the worktree git ACTUALLY has for the branch, not the recomputed default");
{
  // git reports the branch's worktree at a NON-default path (e.g. a resumed build reused one).
  const actualPath = "/tmp/some-other-location/wt-AIO-1";
  const worktreeList = [
    "worktree /tmp/primary",
    "HEAD abc",
    "branch refs/heads/main",
    "",
    `worktree ${actualPath}`,
    "HEAD def",
    `branch refs/heads/${ARGS.branch}`,
    "",
  ].join("\n");
  const { gitExec, calls } = makeGit({ worktreeList });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK", res.code === SHIP_EXIT.OK);
  check(
    "worktree remove targets the git-reported path, not ARGS.worktreePath",
    calls.some((c) => c === `worktree remove --force ${actualPath}`)
  );
  check(
    "does NOT remove the recomputed default path",
    !calls.some((c) => c === `worktree remove --force ${ARGS.worktreePath}`)
  );
}

console.log("F3: git reports no worktree for the branch → falls back to the passed path");
{
  const worktreeList = ["worktree /tmp/primary", "HEAD abc", "branch refs/heads/main", ""].join(
    "\n"
  );
  const { gitExec, calls } = makeGit({ worktreeList });
  const res = runCleanup({ gitExec }, ARGS);
  check("returns OK", res.code === SHIP_EXIT.OK);
  check(
    "worktree remove falls back to the passed worktreePath",
    calls.some((c) => c === `worktree remove --force ${ARGS.worktreePath}`)
  );
}

console.log("resolveWorktreePathFromList — pure parse");
{
  const list = [
    "worktree /a",
    "branch refs/heads/main",
    "",
    "worktree /b/feat-x",
    "branch refs/heads/feat/AIO-1-x",
    "",
  ].join("\n");
  check(
    "matches the branch's worktree",
    resolveWorktreePathFromList(list, "feat/AIO-1-x") === "/b/feat-x"
  );
  check("null when branch absent", resolveWorktreePathFromList(list, "feat/AIO-9-z") === null);
  check("null on empty input", resolveWorktreePathFromList("", "feat/AIO-1-x") === null);
  check("null/undefined tolerated", resolveWorktreePathFromList(undefined, "x") === null);
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
