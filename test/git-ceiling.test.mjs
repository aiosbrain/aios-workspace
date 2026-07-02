#!/usr/bin/env node
// test/git-ceiling.test.mjs — proves the belt-and-braces builder env fence:
// GIT_CEILING_DIRECTORIES set to the worktree's PARENT dir does NOT break git inside a
// linked worktree (its .git is a gitdir-pointer file, resolved by explicit path, not an
// upward walk), yet DOES stop upward .git discovery from a sibling dir outside any repo.
// Zero-dep, uses real git. Run: node test/git-ceiling.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fs from "node:fs";

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

// Layout:  root/ (parent, the ceiling)
//            primary/  (a git repo)
//            primary-wt/ (a linked worktree of primary)
//            sibling/  (a plain dir, NOT a repo)
const root = mkdtempSync(path.join(tmpdir(), "git-ceiling-"));
const primary = path.join(root, "primary");
const wt = path.join(root, "primary-wt");
const sibling = path.join(root, "sibling");
mkdirSync(primary, { recursive: true });
mkdirSync(sibling, { recursive: true });

const g = (args, cwd, env) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ?? process.env,
  }).trim();

g(["init", "-b", "main"], primary);
g(["config", "user.email", "t@example.com"], primary);
g(["config", "user.name", "T"], primary);
writeFileSync(path.join(primary, "README.md"), "# base\n");
g(["add", "-A"], primary);
g(["commit", "-m", "base"], primary);
// Real linked worktree (this is exactly the shape aios build creates).
g(["worktree", "add", "-b", "feat/x", wt, "main"], primary);

// The fence: ceiling = the worktree's parent dir (contains both primary + worktree).
const ceilingEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(wt) };

console.log("ceiling does NOT break git inside the linked worktree");
{
  let toplevel = "",
    statusOk = false;
  try {
    toplevel = g(["rev-parse", "--show-toplevel"], wt, ceilingEnv);
    g(["status", "--porcelain"], wt, ceilingEnv);
    statusOk = true;
  } catch {
    statusOk = false;
  }
  check("git status runs in the worktree under the ceiling", statusOk);
  check("toplevel resolves to the worktree", fs.realpathSync(toplevel) === fs.realpathSync(wt));
}

console.log("ceiling DOES stop upward discovery from a non-repo sibling");
{
  let resolved = null;
  try {
    resolved = g(["rev-parse", "--show-toplevel"], sibling, ceilingEnv);
  } catch {
    resolved = null; // expected — no repo found, discovery stopped at the ceiling
  }
  check("git cannot resolve a repo from the sibling dir", resolved === null);
}

rmSync(root, { recursive: true, force: true });

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
