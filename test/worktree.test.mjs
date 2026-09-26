import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  cmdWorktree,
  computeWorktreePath,
  installWorktreeSafetyBackstops,
} from "../scripts/worktree.mjs";

test("computeWorktreePath: per-repo container dir, slashes -> dashes", () => {
  const repo = "/Users/john/Projects/aios/aios-team-brain";
  const got = computeWorktreePath(repo, "chore/resolver-routing");
  assert.equal(got, "/Users/john/Projects/aios/aios-team-brain-worktrees/chore-resolver-routing");
});

test("computeWorktreePath: drops redundant leading repo-name prefix", () => {
  const repo = "/Users/john/Projects/aios/aios-workspace";
  const got = computeWorktreePath(repo, "aios-workspace-feat/thing");
  assert.equal(got, "/Users/john/Projects/aios/aios-workspace-worktrees/feat-thing");
});

test("computeWorktreePath: no redundant prefix, branch used as-is", () => {
  const repo = "/Users/john/Projects/aios/vibrana.ai";
  const got = computeWorktreePath(repo, "taste-redesign");
  assert.equal(got, "/Users/john/Projects/aios/vibrana.ai-worktrees/taste-redesign");
});

test("computeWorktreePath: container dir sits beside the repo, not inside it", () => {
  const repo = "/Users/john/Projects/aios/aios-workspace";
  const got = computeWorktreePath(repo, "feat/x");
  assert.equal(path.dirname(path.dirname(got)), path.dirname(repo));
});

// --- the toolkit never installs the primary-commit guard ---
//
// The guard is a machine-local preference scoped by ~/.claude/branch-protection.json and
// installed by hand (see test/primary-guard-scope.test.mjs). Automatic install paths used
// to put it into scaffolded personal workspaces, which commit on master by design.

test("installWorktreeSafetyBackstops: no commit guard and no push gate in a scaffolded workspace", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-scaffolded-"));
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    // A scaffolded workspace has no scripts/leak-gate.sh — that is the product-repo marker.
    const res = installWorktreeSafetyBackstops(dir, { quiet: true });
    assert.equal(res.prePush, "skipped");
    assert.equal(existsSync(path.join(dir, ".git", "hooks", "pre-commit")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdWorktree install-hook: product repo gets the push gate but no commit guard", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-product-wt-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "leak-gate.sh"), "#!/bin/sh\nexit 0\n");
    await cmdWorktree(dir, {}, ["install-hook"]);
    assert.ok(!existsSync(path.join(dir, ".git", "hooks", "pre-commit")));
    assert.ok(existsSync(path.join(dir, ".git", "hooks", "pre-push")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
