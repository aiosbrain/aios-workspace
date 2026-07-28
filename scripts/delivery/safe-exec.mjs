/**
 * delivery/safe-exec.mjs — the ONE choke point every `aios delivery status` subprocess call
 * goes through (AIO-579, read-only slice).
 *
 * `aios delivery status` is a read-only reconciliation report: it must never merge, deploy,
 * tag, close, delete a branch, delete a worktree, stash, reset, or clean — structurally, not
 * just by convention. `safeGit`/`safeGh` are the ONLY functions in the `scripts/delivery/**`
 * tree allowed to call `execFileSync`; every other module in this feature imports them instead
 * of touching `node:child_process` directly (asserted by
 * `test/delivery/read-only-boundary.test.mjs`, which greps the whole feature tree for stray
 * `execFileSync`/`exec`/`spawn` calls). Both wrappers validate the subcommand against an
 * explicit allowlist BEFORE any process is spawned — an unrecognized or mutating verb throws
 * instead of running.
 */

import { execFileSync } from "node:child_process";

// git subcommands this feature is allowed to run. Every one of these is read-only by nature;
// `worktree` is additionally gated on its second token below because `git worktree` mixes a
// read (`list`) subcommand with destructive ones (`remove`, `prune`) under the same verb.
const GIT_READONLY_SUBCOMMANDS = new Set(["status", "worktree", "for-each-ref", "rev-parse"]);
const GIT_WORKTREE_READONLY_ARGS = new Set(["list"]);

/**
 * Run a read-only `git` command against `repoPath`. Throws (without spawning anything) if
 * `argv[0]` is not on the allowlist, or if it's `worktree` with a non-`list` second token.
 *
 * @param {string} repoPath
 * @param {string[]} argv  e.g. ["worktree", "list", "--porcelain"]
 */
export function safeGit(repoPath, argv) {
  const [sub, sub2] = argv;
  if (!GIT_READONLY_SUBCOMMANDS.has(sub)) {
    throw new Error(
      `aios delivery status: refusing non-allowlisted git subcommand: git ${argv.join(" ")}`
    );
  }
  if (sub === "worktree" && !GIT_WORKTREE_READONLY_ARGS.has(sub2)) {
    throw new Error(
      `aios delivery status: refusing git worktree subcommand: git ${argv.join(" ")} ` +
        "(only 'worktree list' is allowed — this feature never removes/prunes a worktree)"
    );
  }
  return execFileSync("git", ["-C", repoPath, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// gh top-level commands this feature is allowed to run, each gated on an explicit read-only
// second token. `pr merge`/`pr close`/`pr create`/`pr edit`, `release *`, and any `api` call
// with a non-GET method are all refused before a process is ever spawned.
const GH_PR_READONLY_ARGS = new Set(["list", "view"]);

/**
 * Run a read-only `gh` command. Throws (without spawning anything) for any command not on the
 * allowlist below.
 *
 * @param {string[]} argv  e.g. ["pr", "list", "--repo", "owner/repo", "--json", "number"]
 */
export function safeGh(argv) {
  const [top, sub] = argv;
  if (top === "pr") {
    if (!GH_PR_READONLY_ARGS.has(sub)) {
      throw new Error(
        `aios delivery status: refusing non-read-only gh command: gh ${argv.join(" ")}`
      );
    }
  } else if (top === "api") {
    // A GET is implicit when neither -X/--method is present; anything else must say GET.
    const methodIdx = argv.findIndex((a) => a === "-X" || a === "--method");
    const method = methodIdx !== -1 ? String(argv[methodIdx + 1] ?? "").toUpperCase() : "GET";
    if (method !== "GET") {
      throw new Error(`aios delivery status: refusing non-GET gh api call: gh ${argv.join(" ")}`);
    }
  } else {
    throw new Error(
      `aios delivery status: refusing non-read-only gh command: gh ${argv.join(" ")}`
    );
  }
  return execFileSync("gh", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
