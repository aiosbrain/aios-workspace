#!/usr/bin/env node
/**
 * delivery-status.mjs — `aios delivery status`: read-only cross-repo delivery reconciliation
 * (AIO-579, read-only slice).
 *
 * Reconciles, read-only, for `aiosbrain/aios-workspace` and `aiosbrain/aios-team-brain`:
 *   - GitHub PR state (number, title, head SHA, checks conclusion, review state, mergeable/
 *     merge-state) via scripts/delivery/github.mjs;
 *   - local worktrees and local/remote feature branches via scripts/delivery/local-state.mjs;
 *   - which PRs are merged vs open, and whether a merged/closed PR still has a surviving
 *     branch or worktree, via scripts/delivery/reconcile.mjs (pure, fixture-tested).
 *
 * Read-only, structurally: every git/gh subprocess call in this feature funnels through
 * scripts/delivery/safe-exec.mjs's allowlisted `safeGit`/`safeGh`, which refuse anything but
 * `git status|worktree list|for-each-ref|rev-parse` and `gh pr list|view` / a GET-only
 * `gh api`. It never merges, deploys, tags, closes, deletes a branch, deletes a worktree,
 * stashes, resets, or cleans. A dirty checkout is reported, never touched.
 *
 * OUT of scope for this slice (see AIO-579's full delivery-watchdog spec for the rest):
 * Railway/Vercel deploy reconciliation, tags/GitHub releases, Linear issue/dependency
 * reconciliation, the watchdog (thresholds/no-progress escalation), asks/inbox integration
 * and Linear digest posting, the July 16 Onboarding V2 replay fixture, supersession-link
 * modelling, and the full `planned → … → cleaned` state machine.
 *
 * Repeated runs are idempotent and side-effect free — this command only reads and prints.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { die } from "./cli-common.mjs";
import { fetchPullRequests } from "./delivery/github.mjs";
import { listWorktrees, listBranches, checkDirty } from "./delivery/local-state.mjs";
import { reconcileRepo } from "./delivery/reconcile.mjs";
import { renderTable, renderJson } from "./delivery/render.mjs";

// The two repos this read-only slice covers (AIO-579 scope). `localName` is the sibling
// checkout's directory basename under the Tessera `aios/` container.
export const DEFAULT_REPOS = [
  { slug: "aiosbrain/aios-workspace", localName: "aios-workspace" },
  { slug: "aiosbrain/aios-team-brain", localName: "aios-team-brain" },
];

/**
 * Resolve the local checkout path for one of DEFAULT_REPOS, given the aios-workspace repo
 * path dispatch already resolved (which may be the primary checkout OR any of its linked
 * worktrees — `git worktree list` returns the same repo-wide answer from either).
 *
 * For `aios-workspace` itself, `repoPath` already IS a valid checkout of that repo, so it is
 * returned as-is. For a sibling repo (`aios-team-brain`), this guesses the Tessera-convention
 * sibling path: `<container>/<localName>`, where `<container>` is `dirname(repoPath)` unless
 * `repoPath` sits inside a `*-worktrees` container dir, in which case the container is one
 * level further up (`.../aios/aios-workspace-worktrees/<branch>` → `.../aios/`).
 *
 * @param {string} repoPath
 * @param {string} localName
 */
export function resolveLocalCheckout(repoPath, localName) {
  if (path.basename(repoPath) === localName) return repoPath;
  const dir = path.dirname(repoPath);
  const container = /-worktrees$/.test(path.basename(dir)) ? path.dirname(dir) : dir;
  return path.join(container, localName);
}

function parseArgs(rest) {
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : null;
  };
  const collect = (name) =>
    rest.reduce((acc, arg, i) => {
      if (arg === name && rest[i + 1] !== undefined) acc.push(rest[i + 1]);
      return acc;
    }, []);

  const json = rest.includes("--json");
  const limitRaw = flag("--limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
  const state = flag("--state") ?? "all";
  const repoValues = collect("--repo").flatMap((s) => s.split(","));
  const localValues = collect("--local");

  return { json, limit, state, repoValues, localValues };
}

function helpText() {
  return [
    "",
    "aios delivery status — read-only cross-repo delivery reconciliation",
    "",
    "usage:",
    "  aios delivery status [--json] [--repo owner/repo]... [--state open|closed|merged|all]",
    "                        [--limit N] [--local owner/repo=path]...",
    "",
    "options:",
    "  --json                    machine-readable output (cron/CI/agent consumption)",
    "  --repo owner/repo         restrict to one repo (repeatable / comma-separated); default: both",
    "  --state <s>               gh pr list --state value (default: all)",
    "  --limit N                 max PRs fetched per repo (default: 50)",
    "  --local owner/repo=path   override the guessed local checkout path for a repo",
    "",
    `known repos: ${DEFAULT_REPOS.map((r) => r.slug).join(", ")}`,
    "",
    "Read-only: never merges, deploys, tags, closes, or deletes a branch/worktree. A dirty",
    "checkout is reported, never stashed/reset/cleaned.",
  ].join("\n");
}

/**
 * @param {string} repo   the aios-workspace repo path resolved by dispatch (offline resolution)
 * @param {object} cfg    unused (delivery status needs no aios.yaml config) — kept for the
 *                        standard `adapt(ctx, mod)` call shape
 * @param {string[]} args
 * @returns {Promise<number>} process exit code (0 clean, 1 on a fetch/read error)
 */
export async function cmdDelivery(repo, cfg, args) {
  const sub = args[0];
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    console.log(helpText());
    return sub === undefined ? 1 : 0;
  }
  if (sub !== "status") {
    die(`unknown \`aios delivery\` subcommand: ${sub}\n${helpText()}`);
  }

  const { json, limit, state, repoValues, localValues } = parseArgs(args.slice(1));

  const repoFilter = repoValues.length ? new Set(repoValues) : null;
  const targets = DEFAULT_REPOS.filter((r) => !repoFilter || repoFilter.has(r.slug));
  if (!targets.length) {
    die(`no matching repo — known: ${DEFAULT_REPOS.map((r) => r.slug).join(", ")}`);
  }

  const localOverrides = new Map();
  for (const raw of localValues) {
    const eq = raw.indexOf("=");
    if (eq === -1) die(`--local expects owner/repo=path, got: ${raw}`);
    localOverrides.set(raw.slice(0, eq), raw.slice(eq + 1));
  }

  let hadError = false;
  const reports = [];

  for (const target of targets) {
    const localPath =
      localOverrides.get(target.slug) ?? resolveLocalCheckout(repo, target.localName);

    let prs = null;
    let prsError = null;
    try {
      prs = fetchPullRequests(target.slug, { state, limit });
    } catch (e) {
      prsError = e.message;
      hadError = true;
    }

    let localError = null;
    let worktrees = null;
    let worktreesError = null;
    let branches = null;
    let branchesError = null;
    let dirty = null;
    let dirtyError = null;

    if (!existsSync(localPath)) {
      localError = `not found at ${localPath}`;
      hadError = true;
    } else {
      const wt = listWorktrees(localPath);
      worktrees = wt.worktrees;
      worktreesError = wt.error;
      const br = listBranches(localPath);
      branches = br.error ? null : { local: br.local, remote: br.remote };
      branchesError = br.error;
      const d = checkDirty(localPath);
      dirty = d.dirty;
      dirtyError = d.error;
      if (worktreesError || branchesError || dirtyError) hadError = true;
    }

    reports.push(
      reconcileRepo({
        slug: target.slug,
        localPath,
        localError,
        prs,
        prsError,
        worktrees,
        worktreesError,
        branches,
        branchesError,
        dirty,
        dirtyError,
      })
    );
  }

  console.log(json ? renderJson(reports) : renderTable(reports));
  return hadError ? 1 : 0;
}
