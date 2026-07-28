// test/delivery/reconcile.test.mjs — the pure reconciliation logic for `aios delivery status`
// (AIO-579). Everything here runs against hand-built fixtures (no subprocess, no network),
// covering: a healthy repo, a stale/ambiguous head-SHA mismatch, a partially-failed fetch, and
// merged/closed PRs whose branch or worktree survives cleanup.
import test from "node:test";
import assert from "node:assert/strict";

import { reconcileRepo } from "../../scripts/delivery/reconcile.mjs";

function pr(overrides) {
  return {
    number: 1,
    title: "a change",
    url: "https://github.com/acme/repo/pull/1",
    state: "OPEN",
    isDraft: false,
    headRefName: "feat/x",
    headRefOid: "a".repeat(40),
    baseRefName: "main",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    reviewDecision: "",
    statusCheckRollup: [{ __typename: "CheckRun", conclusion: "SUCCESS" }],
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

test("healthy repo: an open PR with a matching local branch and worktree, no flags", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [pr({})],
    worktrees: [{ path: "/tmp/repo-worktrees/x", branch: "feat/x" }],
    branches: { local: [{ name: "feat/x", sha: "a".repeat(40) }], remote: [] },
    dirty: false,
  });
  assert.equal(report.notes.length, 0);
  assert.equal(report.prs.length, 1);
  const [normalized] = report.prs;
  assert.equal(normalized.headMismatch, false);
  assert.equal(normalized.needsCleanup, false);
  assert.equal(normalized.hasLocalBranch, true);
  assert.equal(normalized.localWorktreePath, "/tmp/repo-worktrees/x");
  assert.equal(normalized.checks, "pass");
});

test("stale/ambiguous: local branch SHA differs from the PR's reported head SHA", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [pr({ headRefOid: "b".repeat(40) })], // GitHub has moved on
    worktrees: [],
    branches: { local: [{ name: "feat/x", sha: "a".repeat(40) }], remote: [] }, // local is behind
    dirty: false,
  });
  const [normalized] = report.prs;
  assert.equal(normalized.headMismatch, true);
  // Ambiguity is reported, not resolved — nothing about survives/needsCleanup changes because
  // of the mismatch alone.
  assert.equal(normalized.hasLocalBranch, true);
});

test("no mismatch is reported when there is no local branch to compare against", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [pr({ headRefOid: "b".repeat(40) })],
    worktrees: [],
    branches: { local: [], remote: [] },
    dirty: false,
  });
  assert.equal(report.prs[0].headMismatch, false);
});

test("merged PR with a surviving local branch AND worktree → needsCleanup, never mutated", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [pr({ state: "MERGED", mergedAt: "2026-07-15T00:00:00Z", mergeStateStatus: "UNKNOWN" })],
    worktrees: [{ path: "/tmp/repo-worktrees/x", branch: "feat/x" }],
    branches: {
      local: [{ name: "feat/x", sha: "a".repeat(40) }],
      remote: [{ name: "feat/x", sha: "a".repeat(40) }],
    },
    dirty: false,
  });
  const [normalized] = report.prs;
  assert.equal(normalized.needsCleanup, true);
  assert.equal(normalized.hasLocalBranch, true);
  assert.equal(normalized.hasRemoteBranch, true);
  assert.equal(normalized.localWorktreePath, "/tmp/repo-worktrees/x");
});

test("closed (not merged) PR with a surviving branch also flags needsCleanup", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [pr({ state: "CLOSED", closedAt: "2026-07-15T00:00:00Z" })],
    worktrees: [],
    branches: { local: [{ name: "feat/x", sha: "a".repeat(40) }], remote: [] },
    dirty: false,
  });
  assert.equal(report.prs[0].needsCleanup, true);
});

test("merged PR whose branch is already gone everywhere → no cleanup flag", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [pr({ state: "MERGED", mergedAt: "2026-07-15T00:00:00Z" })],
    worktrees: [],
    branches: { local: [], remote: [] },
    dirty: false,
  });
  assert.equal(report.prs[0].needsCleanup, false);
});

test("partially-failed: a PR fetch error still yields a report with the local data intact", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: null,
    prsError: "gh pr list acme/repo …failed: HTTP 502",
    worktrees: [{ path: "/tmp/repo-worktrees/x", branch: "feat/x" }],
    branches: { local: [{ name: "feat/x", sha: "a".repeat(40) }], remote: [] },
    dirty: false,
  });
  assert.equal(report.prs.length, 0);
  assert.equal(report.worktreeCount, 1);
  assert.match(report.notes.join(" "), /GitHub PR fetch failed/);
  // The failure is reported, not thrown — a caller can still render the local half of the report.
});

test("partially-failed: a local checkout error still yields a report with the GitHub data intact", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/nonexistent/repo",
    localError: "not found at /nonexistent/repo",
    prs: [pr({})],
    worktrees: null,
    branches: null,
    dirty: null,
  });
  assert.equal(report.prs.length, 1);
  assert.equal(report.worktreeCount, 0);
  assert.match(report.notes.join(" "), /local checkout unavailable/);
  // No local data → survives/needsCleanup default safely to false, never crash.
  assert.equal(report.prs[0].needsCleanup, false);
});

test("a dirty primary checkout is reported as a fact, never as an error or a mutation trigger", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [],
    worktrees: [],
    branches: { local: [], remote: [] },
    dirty: true,
  });
  assert.equal(report.dirty, true);
  assert.equal(report.notes.length, 0); // dirty is not itself a "note"/error
});

test("orphan branches/worktrees: a local branch with no corresponding PR is listed, not touched", () => {
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [],
    worktrees: [{ path: "/tmp/repo-worktrees/orphan", branch: "chore/leftover" }],
    branches: {
      local: [
        { name: "main", sha: "c".repeat(40) },
        { name: "chore/leftover", sha: "d".repeat(40) },
      ],
      remote: [],
    },
    dirty: false,
  });
  assert.deepEqual(report.orphanLocalBranches, ["chore/leftover"]);
  assert.deepEqual(report.orphanWorktrees, [
    { path: "/tmp/repo-worktrees/orphan", branch: "chore/leftover" },
  ]);
  assert.ok(!report.orphanLocalBranches.includes("main"), "main must never be flagged as orphan");
});

test("a failed PR fetch reports NO orphans rather than flagging every branch", () => {
  // Same inputs as the test above, except the PR fetch failed. Previously the empty PR set
  // was treated as authoritative, so a network blip made every branch and worktree look
  // abandoned — the most alarming possible report, produced by the least meaningful cause.
  const report = reconcileRepo({
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: null,
    prsError: "gh: could not connect to api.github.com",
    worktrees: [{ path: "/tmp/repo-worktrees/orphan", branch: "chore/leftover" }],
    branches: {
      local: [
        { name: "main", sha: "c".repeat(40) },
        { name: "chore/leftover", sha: "d".repeat(40) },
      ],
      remote: [],
    },
    dirty: false,
  });

  assert.deepEqual(report.orphanLocalBranches, []);
  assert.deepEqual(report.orphanWorktrees, []);
  assert.ok(
    report.notes.some((n) => n.includes("orphan branch/worktree detection skipped")),
    "the report must say why orphan detection was withheld"
  );
});

test("idempotent: calling reconcileRepo twice with the same inputs yields identical output", () => {
  const input = {
    slug: "acme/repo",
    localPath: "/tmp/repo",
    prs: [pr({ state: "MERGED", mergedAt: "2026-07-15T00:00:00Z" })],
    worktrees: [{ path: "/tmp/repo-worktrees/x", branch: "feat/x" }],
    branches: { local: [{ name: "feat/x", sha: "a".repeat(40) }], remote: [] },
    dirty: false,
  };
  const first = reconcileRepo(input);
  const second = reconcileRepo(input);
  assert.deepEqual(first, second);
});
