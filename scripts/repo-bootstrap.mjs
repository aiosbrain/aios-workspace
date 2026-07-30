/**
 * repo-bootstrap.mjs — `aios repo-bootstrap <target-repo-path>` (AIO-602).
 *
 * The ONE authoritative governance-stamp path for repos split out of aios-workspace
 * (aios-workspace-gui, aios-devtools). Stamps into the TARGET repo:
 *
 *   - the worktree guard pack (the target's OWN .harness copy: git-level commit/branch
 *     backstops + the agent-hook edit/command guard, strict policy) — a bootstrapped
 *     repo blocks primary-checkout commits and edits with NO adjacent core checkout;
 *   - portable gates: check-file-size (fresh default-deny size-caps.json),
 *     check-boundaries (starter boundaries.json), the leak-gate pre-push wiring;
 *   - worktree hydration: link-worktree-env.sh + a post-checkout hook so
 *     `git worktree add` in the target self-hydrates;
 *   - an ENGINEERING-CONSTITUTION.md seed (pointer to the canonical core doc + a §8
 *     invariant registry wired to the stamped scripts);
 *   - a CI skeleton (.github/workflows/ci.yml) running lint/tests/gates.
 *
 * Records .aios-bootstrap-version and supports re-runs with drift detection — see
 * scripts/repo-bootstrap/engine.mjs for the 3-way semantics and
 * scripts/repo-bootstrap/manifest.mjs for the MANAGED vs SEED_IF_ABSENT buckets.
 * Full classification of every stamped file: docs/repo-bootstrap.md.
 */

import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runBootstrap } from "./repo-bootstrap/engine.mjs";
import { BOOTSTRAP_VERSION, BOOTSTRAP_VERSION_FILE } from "./repo-bootstrap/manifest.mjs";

// The stamp SOURCE is the toolkit checkout this module runs from — never the cwd
// walk-up (the command usually runs pointed AT some other repo). Physically resolved
// so a symlinked path to the same checkout (~/Tessera-style) can't dodge the
// self-stamp refusal below.
const TOOLKIT_DIR = realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

const USAGE = `usage: aios repo-bootstrap <target-repo-path> [options]

Stamp the AIOS governance surface (worktree guards, size/boundary/leak gates,
worktree hydration, constitution seed, CI skeleton) into a split repo.

options:
  --check                report drift only — no writes, no hooks, no version stamp
  --force                overwrite locally drifted MANAGED files (seeds are never touched)
  --lint-script <name>   npm script the CI skeleton runs for lint   (default: lint)
  --test-script <name>   npm script the CI skeleton runs for tests  (default: test)
  --json                 machine-readable report
`;

function git(dir, args) {
  try {
    // NOSONAR javascript:S4036 — resolving `git` via the operator's PATH is the whole
    // point of a developer CLI; there is no fixed install location across machines.
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(); // NOSONAR
  } catch {
    return null;
  }
}

const gitRoot = (dir) => git(dir, ["rev-parse", "--show-toplevel"]);

/** Physical path of the repo's COMMON git dir (shared by the primary + every worktree). */
function gitCommonDir(dir) {
  const out = git(dir, ["rev-parse", "--git-common-dir"]);
  if (!out) return null;
  try {
    return realpathSync(path.isAbsolute(out) ? out : path.join(dir, out));
  } catch {
    return null;
  }
}

/**
 * True when `a` and `b` are checkouts of the SAME repository — same primary, a linked
 * worktree of it, or any symlinked route to either. Comparing working-dir realpaths is
 * not enough: the toolkit's primary checkout and its worktrees are different directories
 * of one repo, and stamping any of them is a self-stamp (found live: pointing the CLI at
 * the primary via a ~/Tessera symlink stamped governance INTO the primary checkout).
 */
export function isSameGitRepo(a, b) {
  const ca = gitCommonDir(a);
  return ca !== null && ca === gitCommonDir(b);
}

function parseArgs(rest) {
  const opts = { check: false, force: false, json: false, lint: "lint", test: "test" };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--check") opts.check = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--lint-script" || a === "--test-script") {
      const value = rest[++i];
      if (value === undefined) return { error: `${a} needs a value` };
      opts[a === "--lint-script" ? "lint" : "test"] = value;
    } else if (a === "--help" || a === "-h") return { help: true };
    else if (a.startsWith("--")) return { error: `unknown option: ${a}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { error: "exactly one <target-repo-path> is required" };
  return { opts, target: positional[0] };
}

/**
 * Validate + physically resolve the target. Must be the ROOT of a git repo (hooks are
 * installed into its .git) and never a checkout of the toolkit repo itself — realpath
 * compare for the running checkout, common-git-dir compare for the primary/worktrees.
 * @returns {{ targetDir: string } | { error: string }}
 */
function resolveTargetDir(target) {
  const given = path.resolve(target);
  if (!existsSync(given)) return { error: `target does not exist: ${given}` };
  // Physical path: git reports --show-toplevel physically, and on macOS /var is a
  // symlink to /private/var — a logical/physical mismatch is not a real non-root.
  const targetDir = realpathSync(given);
  const root = gitRoot(targetDir);
  if (!root || realpathSync(root) !== targetDir) {
    return {
      error:
        `target must be the ROOT of a git repository (git hooks are installed into ` +
        `its .git). Got: ${targetDir}` +
        (root ? ` (repo root is ${root})` : " (not a git work tree — run `git init` first)"),
    };
  }
  if (targetDir === TOOLKIT_DIR || isSameGitRepo(targetDir, TOOLKIT_DIR)) {
    return {
      error:
        "refusing to stamp a checkout of the toolkit repository onto itself " +
        "(primary, worktree, or a symlinked route to one).",
    };
  }
  return { targetDir };
}

function printList(label, items, mark = " ") {
  if (!items.length) return;
  console.log(`${label}:`);
  for (const f of items) console.log(`  ${mark} ${f}`);
}

function printReport(report, opts, targetDir) {
  const mode = opts.check ? "check (no writes)" : "stamp";
  console.log(`aios repo-bootstrap v${BOOTSTRAP_VERSION} — ${mode} → ${targetDir}\n`);
  printList("created", report.created, "+");
  printList("updated (source moved, no local edit)", report.updated, "↑");
  printList("forced (local edit overwritten via --force)", report.forced, "!");
  printList("kept local edit (drift — source unchanged)", report.keptLocal, "≠");
  printList("CONFLICT (both changed — new source at <file>.aios-incoming)", report.conflicts, "✗");
  printList("seeded (create-only)", report.seeded, "+");
  printList("seed exists — left untouched", report.seedKept, "·");
  if (report.unchanged.length) console.log(`unchanged: ${report.unchanged.length} file(s)`);
  if (!opts.check && report.hooks.length) console.log(`git hooks: ${report.hooks.join(", ")}`);
  if (!opts.check) console.log(`\nrecorded ${BOOTSTRAP_VERSION_FILE}`);
  if (report.drift.length > 0) {
    console.log(
      `\n${report.drift.length} drifted file(s). Resolve by upstreaming the local edit to the ` +
        `toolkit, or re-run with --force to restore the canonical copy.`
    );
  }
}

/** @returns {number} process exit code */
export async function cmdRepoBootstrap(rest) {
  const parsed = parseArgs(rest);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.error) {
    console.error(`aios repo-bootstrap: ${parsed.error}\n\n${USAGE}`);
    return 1;
  }
  const { opts, target } = parsed;

  const resolved = resolveTargetDir(target);
  if (resolved.error) {
    console.error(`aios repo-bootstrap: ${resolved.error}`);
    return 1;
  }
  const { targetDir } = resolved;

  const params = {
    REPO_NAME: path.basename(targetDir),
    LINT_SCRIPT: opts.lint,
    TEST_SCRIPT: opts.test,
    BOOTSTRAP_VERSION,
  };

  let report;
  try {
    report = runBootstrap({
      toolkitDir: TOOLKIT_DIR,
      targetDir,
      params,
      check: opts.check,
      force: opts.force,
    });
  } catch (e) {
    console.error(`aios repo-bootstrap: ${e.message}`);
    return 1;
  }

  const drifted = report.drift.length > 0;
  if (opts.json) {
    console.log(JSON.stringify({ target: targetDir, check: opts.check, ...report }, null, 2));
  } else {
    printReport(report, opts, targetDir);
  }
  return drifted && opts.check ? 1 : 0;
}
