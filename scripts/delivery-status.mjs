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
 * AIO-595 adds the durable split-delivery manifest (epic AIO-594) on top, still read-only in
 * spirit: `aios delivery status --json` REPORTS the installed manifest (or a warning when it is
 * absent/invalid), and the ONE sanctioned write in the whole feature is
 * `aios delivery manifest init <file>` — validate a manifest and copy it byte-exact into
 * `.aios/delivery/split-manifest.json` (refusing to overwrite without --force). No capability
 * here merges, deletes, pushes, or records verdicts; `verdict_log` is human-edited only.
 *
 * Repeated `status` runs are idempotent and side-effect free — status only reads and prints.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { die } from "./cli-common.mjs";
import { installManifest, loadManifest, MANIFEST_RELPATH } from "./delivery.mjs";
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
    "aios delivery — read-only cross-repo delivery reconciliation + the split-delivery manifest",
    "",
    "usage:",
    "  aios delivery status [--json] [--repo owner/repo]... [--state open|closed|merged|all]",
    "                        [--limit N] [--local owner/repo=path]...",
    "  aios delivery manifest init <file> [--repo <workspace-path>] [--force]",
    "",
    "status options:",
    "  --json                    machine-readable output (cron/CI/agent consumption); includes a",
    "                            `manifest` field (the installed split manifest, or null + warning)",
    "  --repo owner/repo         restrict to one repo (repeatable / comma-separated); default: both",
    "                            (an absolute/./ path instead overrides the workspace path)",
    "  --state <s>               gh pr list --state value (default: all)",
    "  --limit N                 max PRs fetched per repo (default: 50)",
    "  --local owner/repo=path   override the guessed local checkout path for a repo",
    "",
    "manifest init options:",
    `  <file>                    candidate manifest JSON — validated, then copied byte-exact to`,
    `                            <repo>/${MANIFEST_RELPATH}`,
    "  --repo <workspace-path>   target aios-workspace checkout (default: the resolved workspace)",
    "  --force                   replace an existing installed manifest (refused otherwise)",
    "",
    `known repos: ${DEFAULT_REPOS.map((r) => r.slug).join(", ")}`,
    "",
    "Read-only: never merges, deploys, tags, closes, or deletes a branch/worktree, and never",
    "writes verdicts (verdict_log is human-edited only). The single write surface is `manifest",
    "init` copying a validated manifest into place. A dirty checkout is reported, never touched.",
  ].join("\n");
}

/**
 * `aios delivery manifest init <file> [--repo <workspace-path>] [--force]` — the one sanctioned
 * write in the delivery feature: validate a candidate manifest against the AIO-595 schema and
 * copy it into `<repo>/.aios/delivery/split-manifest.json`. Refuses to overwrite an existing
 * manifest (which may carry human-recorded verdicts) unless --force.
 *
 * NOTE: unlike `status` (where --repo is a GitHub owner/repo slug filter), --repo here is a
 * LOCAL workspace path — the checkout whose `.aios/delivery/` receives the manifest.
 *
 * @param {string} repo  the dispatch-resolved workspace path (default install target)
 * @param {string[]} rest  args after "manifest"
 * @returns {number} exit code
 */
function cmdManifest(repo, rest) {
  const sub = rest[0];
  if (sub === "--help" || sub === "-h" || sub === undefined) {
    console.log(helpText());
    return sub === undefined ? 1 : 0;
  }
  if (sub !== "init") {
    die(`unknown \`aios delivery manifest\` subcommand: ${sub}\n${helpText()}`);
  }

  const args = rest.slice(1);
  const force = args.includes("--force");
  const repoIdx = args.indexOf("--repo");
  let targetRepo = repo;
  if (repoIdx !== -1) {
    const value = args[repoIdx + 1];
    if (value === undefined) die("`aios delivery manifest init --repo` needs a path — got no value");
    targetRepo = path.resolve(value);
  }
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && (i === 0 || args[i - 1] !== "--repo")
  );
  const file = positional[0];
  if (!file) die(`\`aios delivery manifest init\` needs a manifest file path\n${helpText()}`);
  if (!existsSync(targetRepo)) die(`target repo path does not exist: ${targetRepo}`);

  const res = installManifest(path.resolve(file), targetRepo, { force });
  if (!res.ok) {
    console.error("✗ split manifest NOT installed:");
    for (const e of res.errors) console.error(`  - ${e}`);
    return 1;
  }
  console.log(`✓ split manifest validated + installed → ${res.dest}`);
  return 0;
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
  if (sub === "manifest") {
    return cmdManifest(repo, args.slice(1));
  }
  if (sub !== "status") {
    die(`unknown \`aios delivery\` subcommand: ${sub}\n${helpText()}`);
  }

  const { json, limit, state, repoValues, localValues } = parseArgs(args.slice(1));

  // `--repo` on status is (still) a GitHub owner/repo slug filter — but a value that is
  // unmistakably a LOCAL path (absolute, or ./relative) carries the flag's meaning everywhere
  // else in the CLI: it overrides the dispatch-resolved workspace path (which `ownsRepoFlag`
  // deliberately left unconsumed) instead of silently filtering every slug out.
  const slugValues = [];
  for (const v of repoValues) {
    if (path.isAbsolute(v) || v.startsWith(".")) repo = path.resolve(v);
    else slugValues.push(v);
  }

  const repoFilter = slugValues.length ? new Set(slugValues) : null;
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

  // The split-delivery manifest (AIO-595) lives in the aios-workspace checkout regardless of
  // which repos this run was filtered to — it is program-level state, reported read-only.
  // Absence/invalidity is a WARNING, not an error: it never changes the exit code.
  const workspaceLocal =
    localOverrides.get("aiosbrain/aios-workspace") ??
    resolveLocalCheckout(repo, "aios-workspace");
  const { manifest, warning: manifestWarning } = loadManifest(workspaceLocal);

  console.log(json ? renderJson(reports, { manifest, manifestWarning }) : renderTable(reports));
  return hadError ? 1 : 0;
}
