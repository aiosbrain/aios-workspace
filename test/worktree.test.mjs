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

// --- primary-commit guard must never be injected into a scaffolded workspace ---
//
// Regression: `aios worktree add` called installWorktreeSafetyBackstops() without
// productOnly, so running it from inside a scaffolded personal workspace installed the
// toolkit's primary-commit guard into that workspace's .git/hooks. A scaffolded
// workspace is master-only by design, so a guard blocking every commit in the primary
// checkout stranded its owner. onboard/update/postinstall all passed productOnly: true;
// only this path did not.

test("installWorktreeSafetyBackstops: skips the primary guard in a scaffolded workspace", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-scaffolded-"));
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    // A scaffolded workspace has no scripts/leak-gate.sh — that is the product-repo marker.
    const res = installWorktreeSafetyBackstops(dir, { quiet: true, productOnly: true });
    assert.equal(res.primaryCommit, "skipped");
    assert.equal(res.prePush, "skipped");
    assert.equal(
      existsSync(path.join(dir, ".git", "hooks", "pre-commit")),
      false,
      "no pre-commit guard may be written into a scaffolded workspace"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installWorktreeSafetyBackstops: still installs the primary guard in the product repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-product-"));
  try {
    execFileSync("git", ["init", "-q", dir], { stdio: "ignore" });
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "leak-gate.sh"), "#!/bin/sh\nexit 0\n");
    const res = installWorktreeSafetyBackstops(dir, { quiet: true, productOnly: true });
    assert.equal(res.primaryCommit, "installed");
    assert.equal(
      existsSync(path.join(dir, ".git", "hooks", "pre-commit")),
      true,
      "the product repo must keep its primary-commit guard"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cmdWorktree install-hook: product repo still gets both guards", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-product-wt-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main", dir], { stdio: "ignore" });
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "scripts", "leak-gate.sh"), "#!/bin/sh\nexit 0\n");
    await cmdWorktree(dir, {}, ["install-hook"]);
    assert.ok(existsSync(path.join(dir, ".git", "hooks", "pre-commit")));
    assert.ok(existsSync(path.join(dir, ".git", "hooks", "pre-push")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
