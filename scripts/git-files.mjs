// git-files.mjs — enumerate a repo's content via git, never a filesystem walk.
//
// AIO-517: every scanner/validator that walked the working tree with an ad-hoc
// exclude list could descend into gitignored build trees. `src-tauri/target` alone is
// 1.6 GB / 35k files, which exhausted a preflight secret scan's window — the gate
// failed by NOT FINISHING, which reads as a broken tool rather than a finding.
//
// Git already maintains the authoritative answer to "what content is in this repo":
//   - `git ls-files -z`                        → tracked
//   - `git ls-files -z -o --exclude-standard`  → untracked but NOT ignored
// Their union is exactly what can ever reach a commit, and every ignored tree is
// structurally invisible — no exclude list to keep in sync with .gitignore.
//
// Returns repo-relative POSIX paths, or `null` when the target is not a git work tree
// (throwaway sandboxes, change-set dirs) so callers can fall back to a scoped walk.

import { execFileSync } from "node:child_process";

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** @returns {string[]|null} repo-relative paths, or null if `repo` is not a git work tree. */
export function gitFiles(repo) {
  try {
    git(repo, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return null;
  }
  try {
    const tracked = git(repo, ["ls-files", "-z"]);
    const untracked = git(repo, ["ls-files", "-z", "-o", "--exclude-standard"]);
    return [...tracked.split("\0"), ...untracked.split("\0")].filter(Boolean);
  } catch {
    return null;
  }
}
