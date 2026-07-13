import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { computeWorktreePath } from "../scripts/worktree.mjs";

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
