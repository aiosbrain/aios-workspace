/**
 * toolkit-pull.mjs — bring a local toolkit checkout current before re-vendoring.
 *
 * `aios update` re-vendors governance FROM a toolkit checkout into the workspace. But the
 * workspace CLI is a thin shim that forwards to that same checkout, so if the checkout is
 * stale, every command runs stale code AND the re-vendor copies stale governance. This
 * module is the git half of `aios update`: classify the toolkit's remote status, fast-forward
 * its tracked branch, pin an immutable snapshot of the result, and reconcile deps — so the
 * re-vendor that follows works from a coherent, frozen view of the newest toolkit.
 *
 * Owned invariant: `pullToolkitCheckout` — the single orchestration of that flow (classify →
 * gate → fast-forward → pin → reconcile deps → rebuild dist). The classification, snapshot,
 * and dist-rebuild MECHANICS it composes live in three sibling modules (AIO-559 extraction):
 *  - `toolkit-pull/remote-state.mjs` — is the checkout safe to read from, and how does it
 *    relate to its remote (current/behind/diverged/…)?
 *  - `toolkit-pull/snapshot-deps.mjs` — pin an immutable snapshot; reconcile npm deps.
 *  - `toolkit-pull/dist-rebuild.mjs` — does a pulled range leave dist/ stale, and rebuild it.
 * This file imports their narrow surfaces and re-exports the ones external callers
 * (`scripts/update.mjs`, the toolkit-pull/update test suites) already depend on, so nothing
 * downstream needed to change import paths for this split.
 *
 * Safety:
 *  - `--check`/`--preview` are truly read-only w.r.t. the toolkit repo — `acquireRemoteState`
 *    reads the remote via `ls-remote` in that mode (no fetch, so no ref/FETCH_HEAD writes) and
 *    never greens an unverified or locally-uninspectable remote.
 *  - Apply mode's fetch always `--prune`s, so a branch deleted/renamed upstream is detected
 *    (a stale local tracking ref is never silently trusted as current).
 *  - A dirty toolkit tree is never clobbered (refuse, or stash+restore with `stash`) and a
 *    `git status`/`git fetch`/`rev-parse`/`rev-list` failure is never treated as "clean" or
 *    "current" — every one of those is a distinct, non-green state.
 *  - A non-fast-forward is refused, not auto-merged.
 *  - The clean, fast-forwarded checkout is pinned into an immutable `git worktree` snapshot
 *    BEFORE any stash is restored, so `--stash` and the vendor step's coherency guarantee
 *    compose correctly — nothing downstream of the pull ever reads a value that could still
 *    change.
 *  - `npm ci` never runs through a SYMLINKED node_modules (worktree layout), and an install
 *    interrupted before it ran self-heals on the next run via a recorded lockfile hash.
 *
 * Zero dependencies (git + npm shelled out; Node >= 18).
 */

import { c, UpdateError } from "./cli-common.mjs";
import {
  git,
  gitSafe,
  assertGitToolkitSource,
  REMOTE_APPLY_ALLOW_STATES,
  sourceCleanliness,
  acquireRemoteState,
  remoteMessage,
  unmergedPaths,
  fastForward,
} from "./toolkit-pull/remote-state.mjs";
import {
  createPinnedSnapshot,
  removePinnedSnapshot,
  lockfileHash,
  reconcileDeps,
} from "./toolkit-pull/snapshot-deps.mjs";
import {
  srcTouchedInRange,
  readOnlyRebuildNeeded,
  rebuildDist,
} from "./toolkit-pull/dist-rebuild.mjs";

// Re-exported for external consumers (scripts/update.mjs, test/toolkit-pull.test.mjs,
// test/update-review-repros.test.mjs, test/update-safety.test.mjs) — this is the exact set
// this file exported before the AIO-559 split, so no import path outside this file changed.
export {
  assertGitToolkitSource,
  REMOTE_APPLY_ALLOW_STATES,
  sourceCleanliness,
  acquireRemoteState,
  remoteMessage,
  unmergedPaths,
  fastForward,
  createPinnedSnapshot,
  removePinnedSnapshot,
};

/**
 * Bring the toolkit checkout at `dir` current: classify remote status → report → (dirty
 * gate →) fast-forward → pin an immutable snapshot → reconcile deps. Returns
 * `{ behind, pulled, installed, upstream, remoteState, sourceClean, srcHead, snapshotDir }`.
 *
 * Modes: `check`/`dryRun` classify via `ls-remote` and never write anything (no fetch, no
 * fast-forward, no stash, no snapshot, no install — `srcHead`/`snapshotDir` are `null` in
 * this mode, since there is nothing to pin). `stash` auto-stashes a dirty tree and restores
 * it; `noInstall` skips the dependency reconcile. `localOnly` skips remote classification
 * and the fast-forward (--no-pull / ephemeral clones) while keeping the clean gate, --stash,
 * and snapshot pinning identical to the pull path. `selfUpdate` (run inside the toolkit
 * checkout, where nothing is vendored) turns the nothing-to-pull case into a no-op that
 * ignores tree dirtiness and pins no snapshot — deps still reconcile.
 *
 * Throws `UpdateError` (never exits) on: a non-fast-forward (`diverged`), a
 * locally-uninspectable repo (`local-status-error` or a `sourceCleanliness` inspection
 * error), a dirty tree without `stash`, a fast-forward/snapshot failure, or a conflicted
 * stash restore — never clobber a checkout, and never leave the caller unable to recover
 * (a `restoreFailed` always preserves the stash and discards any snapshot taken).
 *
 * The snapshot is captured in the ONLY safe window: after `fastForward()` succeeds
 * (or immediately, if nothing needed pulling) but BEFORE the `finally` block pops the
 * stash — so a `--stash` run's later-restored dirty tree can never affect what gets
 * vendored, and vendoring never reads `dir` again after this point.
 */
export function pullToolkitCheckout(dir, opts = {}, io = {}) {
  const {
    stash = false,
    noInstall = false,
    dryRun = false,
    check = false,
    localOnly = false,
    selfUpdate = false,
  } = opts;
  const log = io.log || (() => {});
  const warn = io.warn || (() => {});
  const readOnly = check || dryRun;

  // Every mode (read-only included) runs git against `dir` — refuse a non-git source with
  // the real diagnosis before any of those calls can misfire or, worse, act on an
  // enclosing repository. Throws UpdateError, so --check surfaces it as a structured
  // error result rather than a crash.
  assertGitToolkitSource(dir);

  // `localOnly` (--no-pull / an ephemeral fresh clone): skip remote classification and the
  // fast-forward entirely — the caller explicitly wants the checkout's current committed
  // state. Everything else (clean gate, --stash, snapshot pinning) applies identically, so
  // the dirty/uninspectable policy can never drift between the pull and no-pull paths.
  const remoteState = localOnly
    ? null
    : acquireRemoteState(dir, { mode: readOnly ? "readonly" : "apply", warn });
  if (remoteState) {
    const { tone, text } = remoteMessage(remoteState);
    log(c[tone] ? c[tone](`  ${text}`) : `  ${text}`);
  }

  const ret = (extra) => ({
    behind: remoteState?.behind ?? null,
    pulled: 0,
    installed: false,
    rebuilt: false,
    // rebuildNeeded is the read-only counterpart of `rebuilt`: false = nothing to pull /
    // no src/ change, true = a pull would restale dist/, null = can't tell without fetching.
    // Only meaningful in read-only mode (apply performs the rebuild instead of predicting it).
    rebuildNeeded: false,
    upstream: remoteState?.upstream ?? null,
    remoteState,
    sourceClean: null,
    srcHead: null,
    snapshotDir: null,
    ...extra,
  });

  // Read-only callers still need an honest local-cleanliness signal. In particular,
  // `aios update --check` uses this result when it is run inside the toolkit checkout
  // itself; returning null here would make buildResult() treat a dirty or uninspectable
  // checkout as apply-safe even though apply mode would refuse it.
  if (readOnly)
    return ret({
      sourceClean: sourceCleanliness(dir),
      rebuildNeeded: readOnlyRebuildNeeded(dir, remoteState),
    });

  // APPLY mode from here on.
  // `selfUpdate` (run inside the toolkit checkout itself): nothing is ever vendored, so
  // when there is also nothing to pull, the local tree's state gates nothing — the
  // pre-hardening "up to date" no-op exit, preserved for the primary dogfood path
  // (`aios update` in an actively-developed checkout). That covers BOTH kinds of WIP:
  // uncommitted changes AND committed local work (ahead-only "diverged", behind 0) — the
  // committed state is strictly safer than the uncommitted one and must not fare worse.
  // A diverged checkout that is ALSO behind still needs a real (impossible) fast-forward,
  // and an uninspectable repo (local-status-error) stays fail-closed — both fall through
  // to the throws below. Deps still reconcile (npm is independent of git cleanliness),
  // and a REAL pull over a dirty tree below still requires --stash.
  // ALLOWLIST (same shape as REMOTE_APPLY_ALLOW_STATES, same reason): the no-op set is the
  // allow states minus "behind" (behind means there IS something to pull), plus the one
  // self-update-only exemption — ahead-only "diverged" with a POSITIVELY-known behind of 0
  // (committed local work is strictly safer than the uncommitted WIP the no-op already
  // tolerates). `behind === 0` is strict: an unknown count (null) must fail closed into the
  // refusals below, never coerce to "nothing to pull". A null remoteState (`localOnly`)
  // classified nothing — there is nothing to pull by definition.
  const selfUpdateNothingToPull =
    selfUpdate &&
    (remoteState == null ||
      (remoteState.state !== "behind" && REMOTE_APPLY_ALLOW_STATES.includes(remoteState.state)) ||
      (remoteState.state === "diverged" && remoteState.behind === 0));
  if (
    !selfUpdateNothingToPull &&
    remoteState &&
    !REMOTE_APPLY_ALLOW_STATES.includes(remoteState.state)
  ) {
    if (remoteState.state === "diverged") {
      throw new UpdateError(
        `toolkit branch ${remoteState.branch} has ${remoteState.ahead} local commit(s) not on ` +
          `${remoteState.upstream} — not a fast-forward. Reconcile it by hand (rebase/merge), ` +
          `then re-run \`aios update\`.`
      );
    }
    if (remoteState.state === "local-status-error") {
      throw new UpdateError(
        `couldn't validate the local toolkit repository state at ${dir} ` +
          `(${remoteState.detail || "a git index/ref query failed"}) — refusing to trust it. ` +
          `Check \`git -C ${dir} status\` by hand.`
      );
    }
    // A state this code doesn't know (a future classifier addition): fail closed with the
    // real name rather than sailing into a pull/vendor under unvalidated conditions.
    throw new UpdateError(
      `the toolkit remote state '${remoteState.state}' isn't one apply knows to be safe — ` +
        `refusing to proceed. Run \`aios update --check\` for the full diagnosis.`
    );
  }

  if (selfUpdateNothingToPull) {
    if (remoteState?.state === "diverged") {
      log(
        c.dim(
          `  ${remoteState.ahead} local commit(s) ahead of ${remoteState.upstream} — nothing to pull.`
        )
      );
    }
    let installed = false;
    if (!noInstall) {
      try {
        installed = reconcileDeps(dir, { log, warn, lockChanged: false });
      } catch (e) {
        throw new UpdateError(
          `reconciling toolkit dependencies failed (${String(e.message || e).trim()}).`
        );
      }
    }
    return ret({ installed, sourceClean: sourceCleanliness(dir) });
  }

  const sourceClean = sourceCleanliness(dir);
  if (sourceClean === "inspection-error") {
    throw new UpdateError(
      `couldn't determine whether the toolkit checkout at ${dir} is clean (a \`git status\` ` +
        `query failed) — refusing to trust it.`
    );
  }

  let stashed = false;
  if (sourceClean === "dirty") {
    if (!stash) {
      throw new UpdateError(
        `toolkit working tree is dirty — refusing to ` +
          `${localOnly ? "vendor uncommitted changes" : "pull over uncommitted changes"}.\n` +
          `  Commit or stash them in ${dir}, or re-run with --stash to auto-stash + restore.`
      );
    }
    git(dir, ["stash", "push", "--include-untracked", "-m", "aios update autostash"]);
    stashed = true;
    log(c.dim("  stashed dirty toolkit tree (restored after pull)."));
  }

  let pulled = 0;
  let srcHead = null;
  let headBefore = null;
  let snapshotDir = null;
  let restoreFailed = false;
  let ffError = null;
  let lockChanged = false;
  try {
    // Measured in the clean window (post-stash, pre-pop) so a stashed-away local lockfile
    // edit can't masquerade as "the pull moved the lockfile".
    const lockBefore = lockfileHash(dir);
    // The pre-fast-forward HEAD — one half of the range used below to decide whether the pull
    // touched src/ (and so left dist/ stale). Captured in the same clean window as lockBefore.
    headBefore = gitSafe(dir, ["rev-parse", "HEAD"]);
    if (remoteState?.state === "behind" && fastForward(dir)) pulled = remoteState.behind ?? 0;
    lockChanged = lockfileHash(dir) !== lockBefore;
    // Clean window: fast-forward (if any) is done, stash (if any) has not been popped yet.
    // This is the only point in the whole flow where `dir` is guaranteed both current and
    // clean — pin it now, before anything downstream (including the stash restore below)
    // can dirty it again.
    srcHead = git(dir, ["rev-parse", "HEAD"]);
    // Self-updates never vendor, so a pinned snapshot would only be created to be discarded
    // — skip the worktree round-trip entirely.
    if (!selfUpdate) snapshotDir = createPinnedSnapshot(dir, srcHead);
  } catch (e) {
    ffError = e; // covers fast-forward failure AND snapshot-creation failure identically
  } finally {
    if (stashed) {
      try {
        git(dir, ["stash", "pop"]);
        log(c.dim("  restored your stashed toolkit changes."));
      } catch {
        // `git stash pop` left conflict markers + an unmerged index. Continuing would
        // vendor from a conflicted toolkit — copying markers into executable governance
        // files. Abort; the stash is preserved (pop does not drop it on conflict).
        restoreFailed = true;
      }
    }
  }
  if (ffError) {
    if (snapshotDir) removePinnedSnapshot(dir, snapshotDir);
    throw new UpdateError(
      `fast-forwarding the toolkit checkout failed (${String(ffError.message || ffError).trim()}).\n` +
        `  Nothing was re-vendored${stashed ? (restoreFailed ? "; restoring your stash ALSO conflicted (it is preserved — git -C " + dir + " stash list)" : "; your stashed changes were restored") : ""}.\n` +
        `  Reconcile ${dir} by hand, then re-run \`aios update\`.`
    );
  }
  if (restoreFailed) {
    // The pull (and snapshot) landed, but the user's stash couldn't be reapplied cleanly —
    // never vendor in this state, even though a valid snapshot exists, because the
    // checkout itself needs the user's attention first.
    if (snapshotDir) removePinnedSnapshot(dir, snapshotDir);
    throw new UpdateError(
      `restoring your stashed toolkit changes hit a conflict in ${dir}.\n` +
        `  The pull landed, but your local edits couldn't be reapplied cleanly, so the update is\n` +
        `  aborted before installing or re-vendoring. Resolve the conflict (git -C ${dir} status;\n` +
        `  your stash is preserved), then re-run \`aios update\`.`
    );
  }
  if (pulled > 0) {
    log(
      c.green(
        `  pulled ${pulled} commit${pulled === 1 ? "" : "s"} → toolkit at ${srcHead.slice(0, 12)}.`
      )
    );
  }

  let installed = false;
  if (!noInstall) {
    try {
      installed = reconcileDeps(dir, { log, warn, lockChanged });
    } catch (e) {
      // The snapshot is already pinned at this point — an npm failure here must not leak
      // it (a stale git-worktree registration + orphaned temp dir accumulating across
      // repeated failures).
      removePinnedSnapshot(dir, snapshotDir);
      throw new UpdateError(
        `reconciling toolkit dependencies failed (${String(e.message || e).trim()}).`
      );
    }
  }

  // Rebuild dist/ when the pull touched src/ (fast-forward never fires post-checkout, so
  // nothing else rebuilds the compiled output this checkout actually runs). Keyed off actual
  // HEAD movement (headBefore vs srcHead) rather than the reported `pulled` count, so a moved
  // HEAD with an indeterminate behind-count still rebuilds; srcTouchedInRange returns false
  // for the no-movement case (equal shas). Runs AFTER reconcileDeps so tsc compiles against a
  // current install, and INDEPENDENT of --no-install (a stale dist/ is a correctness bug even
  // when deps didn't move). `!== false` treats an uninspectable range (null) as "rebuild" —
  // fail-safe toward correctness. rebuildDist is non-throwing (a failed build warns, never
  // aborts the pull/vendor), so no snapshot leak.
  let rebuilt = false;
  if (srcTouchedInRange(dir, headBefore, srcHead) !== false) {
    rebuilt = rebuildDist(dir, { log, warn });
  }
  // Report "clean", not the pre-stash `sourceClean` value: by this point a snapshot has
  // been successfully pinned, which by construction only ever happens from a clean tree
  // (dirty-without-stash already threw above; dirty-with-stash was pushed away before
  // pinning). Returning the stale "dirty" value here would make buildResult() block a
  // fully successful apply's own result, even though the vendored content came from a
  // verified-clean, pinned snapshot.
  return ret({ pulled, installed, rebuilt, sourceClean: "clean", srcHead, snapshotDir });
}
