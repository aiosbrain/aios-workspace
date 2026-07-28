/**
 * delivery/reconcile.mjs — pure reconciliation logic for `aios delivery status` (AIO-579).
 *
 * Everything here is a plain function over already-fetched data (no subprocess/network calls),
 * so it is exhaustively unit-testable with fixtures — including stale/ambiguous and
 * partially-failed inputs, per the read-only-slice spec's acceptance criteria.
 *
 * Scope reminder (see AIO-579's read-only slice notes): this reconciles GitHub PR state against
 * local worktrees/branches only. It does NOT reconcile Railway/Vercel deploys, tags/releases,
 * Linear state, or run the watchdog/threshold/escalation machinery — those are explicitly
 * deferred to the full AIO-579 delivery-watchdog scope.
 */

import { aggregateChecks } from "./github.mjs";

/**
 * @param {object} pr  a raw `gh pr list --json …` record
 * @param {{worktrees: Array<object>, localBranches: Array<object>, remoteBranches: Array<object>}} local
 */
function normalizePr(pr, { worktrees, localBranches, remoteBranches }) {
  const headRefName = pr.headRefName;
  const localBranch = localBranches.find((b) => b.name === headRefName) ?? null;
  const remoteBranch = remoteBranches.find((b) => b.name === headRefName) ?? null;
  const worktree = worktrees.find((w) => w.branch === headRefName) ?? null;

  // Stale/ambiguous: the branch checked out locally (or in a worktree) no longer points at
  // the SHA GitHub reports as the PR head. This does NOT mean anything is broken — it just
  // means a fresh `git fetch`/pull hasn't happened yet, or new commits landed after the last
  // local sync. Reported as a flag, never auto-resolved (no fetch/pull/reset is performed).
  const localSha = localBranch?.sha ?? null;
  const headMismatch = !!(localSha && pr.headRefOid && localSha !== pr.headRefOid);

  const survives = !!(localBranch || remoteBranch || worktree);
  const terminal = pr.state === "MERGED" || pr.state === "CLOSED";

  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state, // "OPEN" | "CLOSED" | "MERGED"
    isDraft: !!pr.isDraft,
    headRefName,
    headRefOid: pr.headRefOid ?? null,
    baseRefName: pr.baseRefName ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    mergeable: pr.mergeable ?? null,
    reviewDecision: pr.reviewDecision || null,
    checks: aggregateChecks(pr),
    createdAt: pr.createdAt ?? null,
    updatedAt: pr.updatedAt ?? null,
    mergedAt: pr.mergedAt ?? null,
    closedAt: pr.closedAt ?? null,
    hasLocalBranch: !!localBranch,
    hasRemoteBranch: !!remoteBranch,
    localWorktreePath: worktree?.path ?? null,
    headMismatch,
    // A merged/closed PR whose branch or worktree is still around — cleanup candidate.
    // Reported only: this tool never deletes a branch or removes a worktree.
    needsCleanup: terminal && survives,
  };
}

/**
 * Reconcile one repo's already-fetched GitHub + local data into one report entry. Every `*Error`
 * input is independent: a failure fetching PRs does not block reporting local worktree/branch
 * state (and vice versa) — this is what makes a partially-failed input safe to reconcile rather
 * than aborting the whole run.
 *
 * @param {object} o
 * @param {string} o.slug        "owner/repo"
 * @param {string} o.localPath   resolved (not necessarily existing) local checkout path
 * @param {string|null} o.localError    set when the local checkout path doesn't exist
 * @param {Array<object>|null} o.prs
 * @param {string|null} o.prsError
 * @param {Array<object>|null} o.worktrees
 * @param {string|null} o.worktreesError
 * @param {{local: Array<object>, remote: Array<object>}|null} o.branches
 * @param {string|null} o.branchesError
 * @param {boolean|null} o.dirty
 * @param {string|null} o.dirtyError
 */
export function reconcileRepo({
  slug,
  localPath,
  localError = null,
  prs,
  prsError = null,
  worktrees,
  worktreesError = null,
  branches,
  branchesError = null,
  dirty = null,
  dirtyError = null,
}) {
  const notes = [];
  if (localError) notes.push(`local checkout unavailable: ${localError}`);
  if (prsError) {
    notes.push(
      `GitHub PR fetch failed: ${prsError} — orphan branch/worktree detection skipped ` +
        "(it needs the complete PR set to mean anything)"
    );
  }
  if (worktreesError) notes.push(`git worktree list failed: ${worktreesError}`);
  if (branchesError) notes.push(`git branch listing failed: ${branchesError}`);
  if (dirtyError) notes.push(`git status failed: ${dirtyError}`);

  const safeWorktrees = worktrees ?? [];
  const safeLocalBranches = branches?.local ?? [];
  const safeRemoteBranches = branches?.remote ?? [];

  const normalizedPrs = (prs ?? []).map((pr) =>
    normalizePr(pr, {
      worktrees: safeWorktrees,
      localBranches: safeLocalBranches,
      remoteBranches: safeRemoteBranches,
    })
  );

  // Orphan branches: local heads/worktrees that don't correspond to ANY PR (open OR closed) we
  // know about. Not necessarily a problem (a branch can predate its PR, or never have had one),
  // so this is informational only — never a target for deletion.
  //
  // "No matching PR" is only a claim we can make against a COMPLETE PR set. When the GitHub
  // fetch failed, the empty set says nothing about the branches, and every non-main branch
  // and worktree would be reported as an orphan — the report would look like a pile of
  // abandoned work caused by a network blip. Report nothing instead; `notes` carries why.
  const prSetKnown = !prsError;
  const prHeadNames = new Set(normalizedPrs.map((p) => p.headRefName));
  const orphanLocalBranches = prSetKnown
    ? safeLocalBranches
        .map((b) => b.name)
        .filter((name) => name !== "main" && name !== "master" && !prHeadNames.has(name))
    : [];
  const orphanWorktrees = prSetKnown
    ? safeWorktrees
        .filter((w) => w.branch && w.branch !== "main" && w.branch !== "master")
        .filter((w) => !prHeadNames.has(w.branch))
        .map((w) => ({ path: w.path, branch: w.branch }))
    : [];

  return {
    slug,
    localPath,
    localError,
    prsError,
    worktreesError,
    branchesError,
    dirtyError,
    dirty,
    prs: normalizedPrs,
    worktreeCount: safeWorktrees.length,
    orphanLocalBranches,
    orphanWorktrees,
    notes,
  };
}
