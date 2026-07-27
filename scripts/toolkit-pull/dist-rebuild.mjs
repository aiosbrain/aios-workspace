/**
 * toolkit-pull/dist-rebuild.mjs — keep the toolkit's compiled dist/ current after a pull.
 *
 * Owned invariant: this module is the ONLY place that decides whether a commit range under
 * `src/` (the tsc rootDir) leaves the gitignored `dist/` build artifact stale, and the ONLY
 * place that performs the rebuild. A `fast-forward` of an EXISTING checkout's current branch
 * never fires the `post-checkout` hook that normally rebuilds `dist/` on `git
 * checkout`/`switch`/`worktree add` — so `aios update` must do it itself (AIO-504's
 * silent-stale failure class: a dist/ a source generation behind an otherwise-clean `main`).
 * `srcTouchedInRange`/`readOnlyRebuildNeeded` only ever REPORT whether a rebuild is needed;
 * only `rebuildDist` performs one, and it is non-fatal on failure — the pull that triggered
 * it has already landed and cannot be un-advanced. Extracted verbatim (AIO-559) from
 * `scripts/toolkit-pull.mjs`, which now imports and re-exports the surface this module owns.
 *
 * Zero dependencies (git + npm shelled out).
 */

import path from "node:path";
import { existsSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c } from "../cli-common.mjs";
import { git } from "./remote-state.mjs";

// The tsc rootDir (tsconfig.json `rootDir: "src"`): a pulled change under here means the
// gitignored dist/ build artifact is stale. Kept as a bare prefix so `git diff -- src` matches
// every file the compile reads, without hard-coding the narrower `include` globs.
const SRC_PREFIX = "src";

/**
 * Tri-state: did the commit range oldSha..newSha touch any file under src/? A pulled change to
 * src/ leaves the gitignored dist/ (the compiled output every `aios <cmd>` runs via
 * operator-loop-loader.mjs) a source generation behind until rebuilt — AIO-504's silent-stale
 * failure class.
 *
 *   true  — the range provably touched src/.
 *   false — the range provably did NOT (a doc-only/scaffold-only pull, or nothing to compare).
 *   null  — the range couldn't be inspected (a git failure, or an unresolvable ref such as a
 *           stale/never-fetched @{u}). The caller decides: apply rebuilds (a redundant rebuild
 *           costs seconds; a silently-stale dist/ is the bug this exists to close), read-only
 *           reports "unknown" honestly rather than a guess.
 */
export function srcTouchedInRange(dir, oldSha, newSha) {
  if (!oldSha || !newSha || oldSha === newSha) return false;
  try {
    return git(dir, ["diff", "--name-only", `${oldSha}..${newSha}`, "--", SRC_PREFIX]).length > 0;
  } catch {
    return null;
  }
}

/**
 * Best-effort "would a pull rebuild dist/?" for the read-only modes (--check/--preview), which
 * never fetch. `false` when there is nothing pending; the src-touch verdict when the incoming
 * range is locally inspectable; `null` when it isn't (the ls-remote tip object isn't fetched
 * yet, so the honest answer is "can't tell without pulling"). Never compare against @{u}: the
 * local tracking ref may lag the remote tip indefinitely in these deliberately no-fetch modes.
 * Mirrors the read-only-vs-apply split: report whether a rebuild is needed, never perform one.
 */
export function readOnlyRebuildNeeded(dir, remoteState) {
  if (remoteState?.state !== "behind") return false;
  if (!remoteState.remoteSha) return null;
  return srcTouchedInRange(dir, "HEAD", remoteState.remoteSha);
}

/**
 * Rebuild the toolkit's gitignored dist/ after a pull moved src/. The `post-checkout` git hook
 * already runs `npm run build:loop` for `git checkout`/`git switch`/`git worktree add`, but a
 * fast-forward of an EXISTING checkout's current branch never fires `post-checkout` — so a
 * checkout kept current via `aios update` would otherwise run a stale dist/ until something
 * else happened to rebuild it (AIO-504's live failure: `loop.summarizeTranscriptReview is not
 * a function`, from a dist/ a full source generation behind on an otherwise clean `main`).
 *
 * Needs a resolvable toolkit install to compile against, so skip cleanly when node_modules is
 * absent (a sync-only user) or a DANGLING symlink (target gone). But — unlike reconcileDeps'
 * `npm ci`, which DELETES node_modules and so must never follow a worktree symlink into the
 * shared install — `npm run build:loop` only READS deps and writes to the worktree-LOCAL,
 * gitignored dist/. That is non-destructive through a symlink and is exactly what
 * link-worktree-env.sh already runs at worktree creation, so we DO build through a symlinked
 * (worktree-layout) node_modules: a linked worktree's dist/ is its own and would otherwise stay
 * stale after a fast-forward — and linked worktrees are the required dev workflow. Independent
 * of `--no-install`: a stale dist/ is a correctness bug even when deps didn't change.
 *
 * NON-FATAL on build failure (unlike reconcileDeps' hard throw on a failed `npm ci`): the pull
 * has already landed and cannot be un-advanced, and this rebuild is pull-TRIGGERED (not
 * marker-driven like reconcileDeps' self-healing install), so a throw would both abort the
 * unrelated governance re-vendor AND never retry on a subsequent nothing-to-pull run. Warn
 * loudly with the exact fix instead. Returns true only on a SUCCESSFUL rebuild.
 */
export function rebuildDist(dir, { log, warn }) {
  const nm = path.join(dir, "node_modules");
  let st = null;
  try {
    st = lstatSync(nm);
  } catch {
    st = null;
  }
  if (!st) {
    log(
      c.dim(
        "  no toolkit node_modules — can't rebuild dist/; skipping (deps needed for the loop runtime)."
      )
    );
    return false;
  }
  // A symlink is fine to build THROUGH (tsc only reads deps); a DANGLING one has no install to
  // read (existsSync follows the link), so there is nothing to compile against — skip.
  if (st.isSymbolicLink() && !existsSync(nm)) {
    warn(
      c.yellow(
        "  toolkit node_modules is a dangling symlink — can't rebuild dist/; skipping.\n" +
          "  Restore the worktree's node_modules link (aios worktree install-hook / link-worktree-env.sh)."
      )
    );
    return false;
  }
  log(c.dim("  src/ changed — rebuilding dist/ (npm run build:loop) …"));
  // Resolve npm beside the Node executable already running this trusted toolkit code instead
  // of searching the caller's PATH. Besides avoiding an unrelated/writable PATH entry hijacking
  // the post-pull build, this follows the npm installation paired with the active Node runtime.
  // On Windows npm is npm.cmd, so shell:true is still required; the executable path and args are
  // fully constructed here rather than sourced from user input.
  const npmBin = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm"
  );
  const npmOpts = { cwd: dir, stdio: "inherit", shell: process.platform === "win32" };
  try {
    execFileSync(npmBin, ["run", "build:loop"], npmOpts);
    return true;
  } catch (e) {
    warn(
      c.yellow(
        `  dist/ rebuild failed (npm run build:loop): ${String(e.message || e).trim()}\n` +
          `  The pull landed, but the compiled loop code may be stale — run \`npm run build:loop\` in ${dir}.`
      )
    );
    return false;
  }
}
