/**
 * delivery/local-state.mjs — read-only local git state for `aios delivery status` (AIO-579).
 *
 * Everything here is observational: worktree/branch enumeration and a dirty-checkout check.
 * No function in this module ever creates, deletes, or mutates a worktree/branch/ref — all
 * subprocess calls go through `safeGit` (delivery/safe-exec.mjs), which refuses anything but
 * `git status|worktree list|for-each-ref|rev-parse`.
 */

import { safeGit } from "./safe-exec.mjs";

/**
 * Parse `git worktree list --porcelain` into structured records. Works when run from ANY
 * worktree of a repo — the porcelain listing is shared repo-wide metadata, not per-worktree.
 *
 * @param {string} repoPath  any local checkout (primary or a linked worktree) of the target repo
 * @returns {{ worktrees: Array<{path:string, head:string|null, branch:string|null, bare:boolean,
 *             detached:boolean, locked:boolean, prunable:boolean}>|null, error: string|null }}
 */
export function listWorktrees(repoPath) {
  let out;
  try {
    out = safeGit(repoPath, ["worktree", "list", "--porcelain"]);
  } catch (e) {
    return { worktrees: null, error: e.message };
  }
  const worktrees = [];
  let current = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = {
        path: line.slice("worktree ".length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    } else if (line.startsWith("HEAD ")) {
      if (current) current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      if (current) current.branch = line.slice("branch refs/heads/".length);
    } else if (line === "bare") {
      if (current) current.bare = true;
    } else if (line === "detached") {
      if (current) current.detached = true;
    } else if (line.startsWith("locked")) {
      if (current) current.locked = true;
    } else if (line.startsWith("prunable")) {
      if (current) current.prunable = true;
    }
  }
  if (current) worktrees.push(current);
  return { worktrees, error: null };
}

function parseRefLines(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, sha, upstream] = line.split("\t");
      return { name, sha, upstream: upstream || null };
    });
}

/**
 * Local heads (with upstream tracking, when set) and origin's remote-tracking branches.
 * Remote-branch names are normalized by stripping the `origin/` prefix so they compare
 * directly against a PR's `headRefName`.
 *
 * @param {string} repoPath
 * @returns {{ local: Array<{name:string, sha:string, upstream:string|null}>|null,
 *             remote: Array<{name:string, sha:string}>|null, error: string|null }}
 */
export function listBranches(repoPath) {
  try {
    const localRaw = safeGit(repoPath, [
      "for-each-ref",
      "--format=%(refname:short)\t%(objectname)\t%(upstream:short)",
      "refs/heads/",
    ]);
    const remoteRaw = safeGit(repoPath, [
      "for-each-ref",
      "--format=%(refname:short)\t%(objectname)",
      "refs/remotes/origin/",
    ]);
    const local = parseRefLines(localRaw);
    const remote = parseRefLines(remoteRaw)
      .filter(({ name }) => name !== "origin/HEAD")
      .map(({ name, sha }) => ({ name: name.replace(/^origin\//, ""), sha }));
    return { local, remote, error: null };
  } catch (e) {
    return { local: null, remote: null, error: e.message };
  }
}

/**
 * Whether `repoPath` has uncommitted changes. Report-only — this never stashes, resets, or
 * cleans; a dirty checkout is a finding for the report, not something this tool touches.
 *
 * @param {string} repoPath
 * @returns {{ dirty: boolean|null, error: string|null }}
 */
export function checkDirty(repoPath) {
  try {
    const out = safeGit(repoPath, ["status", "--porcelain"]);
    return { dirty: out.trim().length > 0, error: null };
  } catch (e) {
    return { dirty: null, error: e.message };
  }
}
