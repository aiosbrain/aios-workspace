// test/delivery/local-state.test.mjs — worktree/branch/dirty parsing against REAL temp git
// repos (this is local git state, not a GitHub response, so there is no fixture to fake — a
// throwaway repo is the equivalent of a fixture here and never touches the network).
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listWorktrees, listBranches, checkDirty } from "../../scripts/delivery/local-state.mjs";

function git(dir, args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function initRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "delivery-localstate-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(path.join(dir, "a.txt"), "1\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("listWorktrees parses the primary checkout and a linked worktree", () => {
  const primary = initRepo();
  const wtContainer = mkdtempSync(path.join(tmpdir(), "delivery-localstate-wt-"));
  const wtPath = path.join(wtContainer, "linked");
  try {
    git(primary, ["worktree", "add", "-b", "feat/x", wtPath, "main"]);
    const { worktrees, error } = listWorktrees(primary);
    assert.equal(error, null);
    assert.equal(worktrees.length, 2);
    // git resolves symlinked tmp dirs (e.g. macOS /tmp -> /private/tmp) in its porcelain
    // output, so compare against the realpath rather than the pre-mkdtemp string.
    const realPrimary = realpathSync(primary);
    const realWtPath = realpathSync(wtPath);
    const primaryEntry = worktrees.find((w) => w.path === realPrimary);
    const linkedEntry = worktrees.find((w) => w.path === realWtPath);
    assert.ok(primaryEntry, "primary checkout missing from worktree list");
    assert.equal(primaryEntry.branch, "main");
    assert.ok(linkedEntry, "linked worktree missing from worktree list");
    assert.equal(linkedEntry.branch, "feat/x");

    // Same answer from the LINKED worktree — porcelain listing is repo-wide, not per-worktree.
    const fromLinked = listWorktrees(wtPath);
    assert.equal(fromLinked.worktrees.length, 2);
  } finally {
    git(primary, ["worktree", "remove", "--force", wtPath]);
    rmSync(primary, { recursive: true, force: true });
    rmSync(wtContainer, { recursive: true, force: true });
  }
});

test("listWorktrees returns an error (not a throw) for a non-git directory", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "delivery-localstate-notgit-"));
  try {
    const { worktrees, error } = listWorktrees(dir);
    assert.equal(worktrees, null);
    assert.ok(error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listBranches reports local heads with their SHA and origin remote-tracking branches", () => {
  const upstream = initRepo();
  const clone = mkdtempSync(path.join(tmpdir(), "delivery-localstate-clone-"));
  rmSync(clone, { recursive: true, force: true }); // git clone requires a non-existent target
  try {
    execFileSync("git", ["clone", "-q", upstream, clone]);
    git(clone, ["config", "user.email", "test@example.com"]);
    git(clone, ["config", "user.name", "Test"]);
    git(clone, ["checkout", "-q", "-b", "feat/y"]);
    writeFileSync(path.join(clone, "b.txt"), "1\n");
    git(clone, ["add", "b.txt"]);
    git(clone, ["commit", "-q", "-m", "feat"]);
    git(clone, ["push", "-q", "-u", "origin", "feat/y"]);

    const { local, remote, error } = listBranches(clone);
    assert.equal(error, null);
    const localMain = local.find((b) => b.name === "main");
    const localFeat = local.find((b) => b.name === "feat/y");
    assert.ok(localMain);
    assert.ok(localFeat);
    assert.match(localFeat.sha, /^[0-9a-f]{40}$/);

    const remoteFeat = remote.find((b) => b.name === "feat/y");
    assert.ok(remoteFeat, "origin/feat/y should appear with the origin/ prefix stripped");
    assert.equal(remoteFeat.sha, localFeat.sha);
    assert.ok(
      !remote.some((b) => b.name === "HEAD"),
      "origin/HEAD symbolic ref must be filtered out"
    );
  } finally {
    rmSync(upstream, { recursive: true, force: true });
    rmSync(clone, { recursive: true, force: true });
  }
});

test("checkDirty reports true for uncommitted changes, false for a clean tree, and never touches them", () => {
  const dir = initRepo();
  try {
    assert.equal(checkDirty(dir).dirty, false);
    writeFileSync(path.join(dir, "a.txt"), "2\n");
    assert.equal(checkDirty(dir).dirty, true);
    // Still dirty after the check — checkDirty must never stash/reset/clean.
    const status = execFileSync("git", ["-C", dir, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim();
    assert.equal(status, "M a.txt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
