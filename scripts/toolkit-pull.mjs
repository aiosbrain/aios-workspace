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

import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, sha256, UpdateError } from "./cli-common.mjs";

/** Run git in `dir`; returns trimmed stdout. Throws on non-zero (caller may catch). */
function git(dir, gitArgs) {
  return execFileSync("git", ["-C", dir, ...gitArgs], { encoding: "utf8" }).trim();
}

/** Same, but returns "" instead of throwing — ONLY for values where "" is itself a
 *  meaningful, safe answer (e.g. "no branch name"). Never use this where a git failure
 *  must be distinguished from a legitimate empty/zero result — see acquireRemoteState
 *  and sourceCleanliness, which both use direct try/catch for exactly that reason. */
function gitSafe(dir, gitArgs) {
  try {
    return git(dir, gitArgs);
  } catch {
    return "";
  }
}

/**
 * Tri-state — NOT a boolean — because "couldn't determine" must never be conflated with
 * "clean". A plain `git status --porcelain` failure (corrupted .git, permissions, git
 * itself missing) used to be swallowed into `false` (looked clean) by the old boolean
 * `isDirty()`; that was a fail-open bug in a safety-critical check. Callers must treat
 * "inspection-error" as blocking, identically to "dirty".
 */
export function sourceCleanliness(dir) {
  try {
    const out = git(dir, ["status", "--porcelain"]);
    return out.length > 0 ? "dirty" : "clean";
  } catch {
    return "inspection-error";
  }
}

/** Parse "remote/branch" from an @{u}-style upstream ref string. Branch names can contain
 *  slashes, so only the FIRST slash splits off the remote name. Single source of truth —
 *  previously hand-split independently in two now-removed functions. */
function splitUpstream(upstream) {
  const slash = upstream.indexOf("/");
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
}

/** Best-effort behind/ahead from the LOCAL tracking ref, for when the remote itself can't
 *  be reached — clearly a stale estimate, never a substitute for a verified count. Critically,
 *  `ahead` still matters even offline: the old trackingStatus()-based design unconditionally
 *  computed ahead from the local ref regardless of fetch success, so a toolkit with local
 *  commits never pushed anywhere was refused as "diverged" even offline. Collapsing straight
 *  to "unreachable" on fetch failure (without consulting this) would silently drop that
 *  coverage and let an offline, locally-diverged toolkit be vendored from. */
function staleLocalStatus(dir, upstreamName) {
  const counts = gitSafe(dir, ["rev-list", "--left-right", "--count", `${upstreamName}...HEAD`]);
  if (!counts) return { behind: null, ahead: 0 };
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  return {
    behind: Number.isFinite(behind) ? behind : null,
    ahead: Number.isFinite(ahead) ? ahead : 0,
  };
}

/** Shared classification tail: given a resolved remote-side sha (however it was obtained)
 *  and local HEAD, decide current/behind/diverged — or local-status-error if a LOCAL git
 *  op fails, which is never conflated with an unreachable remote. `onCountFailure` lets
 *  the two callers assign different meaning to "the rev-list count itself failed": in
 *  readonly mode the remote object simply isn't fetched locally yet (expected, → still
 *  "behind", count unknown); in apply mode (called AFTER a real fetch) the same failure
 *  means something local is actually broken (→ "local-status-error"). */
function classifyAgainst(dir, remoteSha, branch, upstreamName, { onCountFailure }) {
  let localHead;
  try {
    localHead = git(dir, ["rev-parse", "HEAD"]);
  } catch {
    return { state: "local-status-error", branch, upstream: upstreamName, behind: null, ahead: 0 };
  }
  if (remoteSha === localHead) {
    return { state: "current", branch, upstream: upstreamName, behind: 0, ahead: 0 };
  }
  let counts;
  try {
    counts = git(dir, ["rev-list", "--left-right", "--count", `${remoteSha}...HEAD`]);
  } catch {
    return { state: onCountFailure, branch, upstream: upstreamName, behind: null, ahead: 0 };
  }
  const [behind = "0", ahead = "0"] = counts.split(/\s+/);
  const aheadN = Number(ahead) || 0;
  if (aheadN > 0) {
    return {
      state: "diverged",
      branch,
      upstream: upstreamName,
      behind: Number(behind) || 0,
      ahead: aheadN,
    };
  }
  return { state: "behind", branch, upstream: upstreamName, behind: Number(behind) || 0, ahead: 0 };
}

/**
 * The single owner of "how does this toolkit checkout relate to its remote" — used
 * IDENTICALLY by `--check`/`--preview` (mode: "readonly", ls-remote, zero writes) and
 * apply (mode: "apply", a real `--prune`d fetch). Returns one of seven discriminated
 * states; `behind`/`ahead` are only meaningful for "current"/"behind"/"diverged".
 *
 *   no-upstream          — branch never had @{u} configured (not "offline"; nothing to
 *                           be behind). May read "current" if the workspace stamp matches.
 *   current               — verified: local HEAD === the remote's ref exactly.
 *   behind                 — verified: remote is ahead (behind may be null in readonly
 *                           mode if the remote object isn't fetched locally yet).
 *   diverged               — verified (or, when the remote is unreachable, evidenced by the
 *                           stale local tracking ref): local HEAD has commits the remote
 *                           doesn't. Apply hard-refuses this (not a fast-forward) — even
 *                           offline, since local unpublished work is real divergence
 *                           regardless of network reachability.
 *   missing-upstream-ref   — @{u} WAS configured but the remote no longer has that ref
 *                           (renamed/deleted branch). NEVER substitutes a same-named tag.
 *   unreachable            — couldn't reach the remote at all (network/auth), AND the stale
 *                           local tracking ref shows no local-only commits either. Apply may
 *                           still proceed from local state; check/preview never green.
 *   local-status-error     — the remote query itself succeeded but a LOCAL git operation
 *                           (rev-parse/rev-list) then failed — evidence of a broken LOCAL
 *                           repo, not network unavailability. Always hard-blocks (never
 *                           treated as acceptable-offline).
 */
export function acquireRemoteState(dir, { mode, warn = () => {} } = {}) {
  const branch = gitSafe(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  const upstreamName = gitSafe(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstreamName) {
    return { state: "no-upstream", branch, upstream: null, behind: 0, ahead: 0 };
  }
  const { remote, branch: remoteBranch } = splitUpstream(upstreamName);

  if (mode === "apply") {
    try {
      // --prune is the fix for a deleted/renamed upstream branch: without it, a plain
      // fetch leaves the stale local tracking ref in place, silently trusted as current.
      git(dir, ["fetch", "--prune", "--quiet", remote]);
    } catch (e) {
      warn(c.yellow(`  git fetch failed (${e.message.trim()}) — reporting last-known state`));
      const stale = staleLocalStatus(dir, upstreamName);
      // A local commit not on the last-known remote state is real divergence regardless of
      // network reachability — never silently vendor from it just because we're offline.
      if (stale.ahead > 0) {
        return {
          state: "diverged",
          branch,
          upstream: upstreamName,
          behind: stale.behind ?? 0,
          ahead: stale.ahead,
        };
      }
      return {
        state: "unreachable",
        branch,
        upstream: upstreamName,
        behind: null,
        ahead: 0,
        staleBehindEstimate: stale.behind,
      };
    }
    let upstreamSha;
    try {
      // Resolves the ref OBJECT (fails if --prune just removed it), unlike
      // --symbolic-full-name which only prints the configured name without verifying
      // the tracking ref still exists.
      upstreamSha = git(dir, ["rev-parse", upstreamName]);
    } catch {
      return {
        state: "missing-upstream-ref",
        branch,
        upstream: upstreamName,
        behind: null,
        ahead: 0,
      };
    }
    return classifyAgainst(dir, upstreamSha, branch, upstreamName, {
      onCountFailure: "local-status-error",
    });
  }

  // readonly: ls-remote only — zero writes, no ref/FETCH_HEAD mutation.
  let out;
  try {
    out = git(dir, ["ls-remote", remote, remoteBranch]); // direct try/catch — NOT gitSafe,
    // so "threw" (unreachable) is distinguishable from "succeeded, zero matching lines"
    // (missing-upstream-ref) below.
  } catch {
    warn(c.yellow("  couldn't reach the remote — reporting local state only (unverified)."));
    const stale = staleLocalStatus(dir, upstreamName);
    if (stale.ahead > 0) {
      return {
        state: "diverged",
        branch,
        upstream: upstreamName,
        behind: stale.behind ?? 0,
        ahead: stale.ahead,
      };
    }
    return {
      state: "unreachable",
      branch,
      upstream: upstreamName,
      behind: null,
      ahead: 0,
      staleBehindEstimate: stale.behind,
    };
  }
  // `git ls-remote <remote> <branch>` matches by trailing component, so a sibling like
  // `refs/heads/hotfix/<branch>` can appear too — pick the EXACT ref, not just line 0.
  const wantHead = `refs/heads/${remoteBranch}`;
  let remoteSha = null;
  for (const l of out.split("\n")) {
    const [sha, ref] = l.split(/\s+/);
    if (ref === wantHead) {
      remoteSha = sha;
      break;
    }
  }
  if (!remoteSha) {
    // Reachable, but no exact branch match — renamed/deleted upstream, or empty output.
    // NEVER substitute a same-named tag's sha here (that was the tag-fallback false-green).
    return {
      state: "missing-upstream-ref",
      branch,
      upstream: upstreamName,
      behind: null,
      ahead: 0,
    };
  }
  return classifyAgainst(dir, remoteSha, branch, upstreamName, { onCountFailure: "behind" });
}

/** Human-readable line for an acquireRemoteState() result. One function, used by both the
 *  plain-apply log line and the --check verdict's "why" text — no more duplicated
 *  if/else chains to silently diverge. Returns { tone, text }; callers apply color. */
export function remoteMessage(rs) {
  switch (rs.state) {
    case "no-upstream":
      return {
        tone: "dim",
        text: `toolkit branch ${rs.branch} has no upstream — skipping git pull.`,
      };
    case "current":
      return { tone: "green", text: `toolkit up to date — ${rs.branch} at ${rs.upstream}.` };
    case "behind":
      return {
        tone: "yellow",
        text:
          rs.behind == null
            ? `toolkit differs from ${rs.upstream} (behind — exact count unknown).`
            : `toolkit is ${rs.behind} commit${rs.behind === 1 ? "" : "s"} behind ${rs.upstream}.`,
      };
    case "diverged":
      return {
        tone: "yellow",
        text: `toolkit branch ${rs.branch} has ${rs.ahead} local commit(s) not on ${rs.upstream} — not a fast-forward.`,
      };
    case "missing-upstream-ref":
      return {
        tone: "yellow",
        text: `toolkit's tracked branch ${rs.upstream} no longer exists on the remote (renamed or deleted?) — could not confirm current.`,
      };
    case "unreachable":
      return {
        tone: "yellow",
        text:
          `couldn't verify the toolkit's remote (offline?) — status unconfirmed` +
          (rs.staleBehindEstimate != null
            ? ` (local tracking last showed ${rs.staleBehindEstimate} commit(s) behind — stale)`
            : "") +
          ".",
      };
    case "local-status-error":
      return {
        tone: "red",
        text: `couldn't validate the local toolkit repository state (a git index/ref query failed) — refusing to trust it.`,
      };
    default:
      return { tone: "yellow", text: `toolkit remote status: ${rs.state}.` };
  }
}

/**
 * Paths left UNMERGED in the toolkit index — the state a conflicted `git stash pop` (or any
 * half-finished merge) leaves behind, where files on disk hold `<<<<<<<` markers. Vendoring
 * from a checkout in this state would copy those markers into executable governance files,
 * so callers must refuse. Throws on a genuine git failure (corrupted index, not a repo) —
 * callers (vendorSafety) must treat that as unsafe, not as "no unmerged paths". Only ever
 * meaningful against a live checkout with a possible in-progress merge — never called
 * against an immutable pinned snapshot (a fresh checkout of a finalized commit cannot have
 * an in-progress merge by construction).
 */
export function unmergedPaths(dir) {
  const out = git(dir, ["diff", "--name-only", "--diff-filter=U"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

/** Fast-forward the current branch to its upstream. Returns true if it moved. Throws if not a fast-forward. */
export function fastForward(dir) {
  const before = gitSafe(dir, ["rev-parse", "HEAD"]);
  // --ff-only refuses a non-fast-forward (diverged/rebased branch) instead of creating a
  // merge commit in someone's toolkit checkout — surfaced to the user to resolve by hand.
  git(dir, ["merge", "--ff-only", "@{u}"]);
  return gitSafe(dir, ["rev-parse", "HEAD"]) !== before;
}

/**
 * A real, complete, git-native checkout of `dir` at the exact commit `sha`, in a fresh
 * disposable temp directory — shares the object store (cheap, no data duplication),
 * registered as its own git worktree (safe under concurrent `aios update` runs — that's
 * what worktrees are designed for), detached (nothing can commit to it, nobody else holds
 * a reference to its path). Once created, NOTHING can mutate it: there is no revalidation
 * to do downstream, because nothing mutable is ever read from it again. This is what makes
 * the vendor-apply step's coherency guarantee implementable — the merge, catalog
 * generation, and metadata read all operate against this snapshot, never against the live
 * (mutable) `dir` again.
 */
export function createPinnedSnapshot(dir, sha) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aios-vendor-snapshot-"));
  // -c core.hooksPath=/dev/null: `git worktree add` runs the repo's post-checkout hook like
  // any other checkout — in this toolkit that hook auto-hydrates config, wires asks, and
  // even runs `npm run build:loop` (see docs/architecture on worktree tooling). Every one of
  // those side effects is not just wasted work but actively wrong here: this "worktree" is a
  // disposable, internal read-only snapshot for vendoring, not a workspace a human or agent
  // is about to work in. Disable hooks for this one invocation rather than let them fire.
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-C",
      dir,
      "worktree",
      "add",
      "--detach",
      "--quiet",
      tmp,
      sha,
    ],
    { stdio: "ignore" }
  );
  return tmp;
}

/** Remove a snapshot created by createPinnedSnapshot — best-effort, never throws. */
export function removePinnedSnapshot(dir, snapshotDir) {
  if (!snapshotDir) return;
  try {
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-C", dir, "worktree", "remove", "--force", snapshotDir],
      { stdio: "ignore" }
    );
  } catch {
    try {
      rmSync(snapshotDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup; a leftover temp dir is not a correctness issue */
    }
  }
}

function lockfileHash(dir) {
  const lock = path.join(dir, "package-lock.json");
  return existsSync(lock) ? sha256(readFileSync(lock)) : null;
}

/**
 * Where the lockfile hash of the last SUCCESSFUL install is recorded (untracked). Comparing
 * against it on every run means an install interrupted between fast-forward and `npm ci`
 * self-heals next time, instead of being masked forever by a `behind === 0` early return.
 *
 * Uses the PER-WORKTREE git dir (`--git-dir`, e.g. `.git/worktrees/<name>`), not the shared
 * common dir: this marker only governs a REAL, worktree-local `node_modules` (a symlinked one is
 * skipped before we get here), and two worktrees with independent installs on different lockfiles
 * must not overwrite each other's marker and thrash into needless reinstalls.
 */
function installedLockPath(dir) {
  const gitDir = gitSafe(dir, ["rev-parse", "--git-dir"]);
  if (!gitDir) return null;
  return path.join(path.resolve(dir, gitDir), "aios-installed-lock");
}

/**
 * Reconcile toolkit deps: reinstall iff the working lockfile differs from the one recorded at
 * the last successful install (or none is recorded). Skips entirely when there is no
 * `node_modules` (a sync-only user never needs toolkit deps, per docs/GETTING-STARTED.md).
 *
 * CRITICAL: never run npm through a SYMLINKED node_modules. `npm ci` deletes node_modules, and
 * in a git worktree that path is a symlink to the primary checkout's shared install — following
 * it would erase the shared target. Detect the symlink with lstat and skip. Prefers `npm ci`
 * (reproducible), falls back to `npm install`. Records the new hash only AFTER npm succeeds.
 * Always operates on the LIVE checkout (`dir`), never the pinned snapshot — dependency
 * installation is a shared-install concern unrelated to vendor coherency.
 */
function reconcileDeps(dir, { log, warn }) {
  const nm = path.join(dir, "node_modules");
  let st = null;
  try {
    st = lstatSync(nm);
  } catch {
    st = null;
  }
  if (!st) {
    log(c.dim("  no toolkit node_modules — deps only needed for the GUI/tests; skipping npm ci."));
    return false;
  }
  if (st.isSymbolicLink()) {
    warn(
      c.yellow(
        "  toolkit node_modules is a symlink (worktree layout) — skipping npm ci to avoid erasing\n" +
          "  the shared install. If deps changed, run `npm ci` in the canonical checkout."
      )
    );
    return false;
  }
  const marker = installedLockPath(dir);
  const currentHash = lockfileHash(dir);
  const stored = marker && existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  if (currentHash === stored) {
    log(c.dim("  deps unchanged — skipping reinstall."));
    return false;
  }
  const cmd = currentHash ? "ci" : "install";
  // Re-check right before npm runs (TOCTOU): if node_modules became a symlink since the lstat
  // above, `npm ci` would delete through it and wipe the shared target. Bail rather than risk it.
  try {
    if (lstatSync(nm).isSymbolicLink()) {
      warn(
        c.yellow(
          "  toolkit node_modules became a symlink — skipping npm ci to protect the shared install."
        )
      );
      return false;
    }
  } catch {
    /* vanished between checks — nothing to protect; npm will recreate it */
  }
  log(c.dim(`  reinstalling toolkit deps (npm ${cmd}) …`));
  // On Windows npm is npm.cmd — execFileSync("npm") throws ENOENT there; shell:true resolves
  // it via PATHEXT. Args are fixed strings ("ci"/"install"), so shell interpolation is safe.
  const npmOpts = { cwd: dir, stdio: "inherit", shell: process.platform === "win32" };
  try {
    execFileSync("npm", [cmd], npmOpts);
  } catch (e) {
    if (cmd === "ci") {
      warn(c.yellow("  npm ci failed — falling back to npm install"));
      execFileSync("npm", ["install"], npmOpts);
    } else {
      throw e;
    }
  }
  // Record success only AFTER npm returns 0 — an interrupted install leaves the marker stale so
  // the next run repairs it.
  if (marker && currentHash) {
    try {
      writeFileSync(marker, `${currentHash}\n`);
    } catch {
      /* metadata is best-effort; a missing marker just means a redundant reconcile next run */
    }
  }
  return true;
}

/**
 * Bring the toolkit checkout at `dir` current: classify remote status → report → (dirty
 * gate →) fast-forward → pin an immutable snapshot → reconcile deps. Returns
 * `{ behind, pulled, installed, upstream, remoteState, sourceClean, srcHead, snapshotDir }`.
 *
 * Modes: `check`/`dryRun` classify via `ls-remote` and never write anything (no fetch, no
 * fast-forward, no stash, no snapshot, no install — `srcHead`/`snapshotDir` are `null` in
 * this mode, since there is nothing to pin). `stash` auto-stashes a dirty tree and restores
 * it; `noInstall` skips the dependency reconcile.
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
  const { stash = false, noInstall = false, dryRun = false, check = false } = opts;
  const log = io.log || (() => {});
  const warn = io.warn || (() => {});
  const readOnly = check || dryRun;

  const remoteState = acquireRemoteState(dir, { mode: readOnly ? "readonly" : "apply", warn });
  const { tone, text } = remoteMessage(remoteState);
  log(c[tone] ? c[tone](`  ${text}`) : `  ${text}`);

  const ret = (extra) => ({
    behind: remoteState.behind,
    pulled: 0,
    installed: false,
    upstream: remoteState.upstream,
    remoteState,
    sourceClean: null,
    srcHead: null,
    snapshotDir: null,
    ...extra,
  });

  if (readOnly) return ret();

  // APPLY mode from here on.
  if (remoteState.state === "diverged") {
    throw new UpdateError(
      `toolkit branch ${remoteState.branch} has ${remoteState.ahead} local commit(s) not on ` +
        `${remoteState.upstream} — not a fast-forward. Reconcile it by hand (rebase/merge), ` +
        `then re-run \`aios update\`.`
    );
  }
  if (remoteState.state === "local-status-error") {
    throw new UpdateError(
      `couldn't validate the local toolkit repository state at ${dir} (a git index/ref query ` +
        `failed) — refusing to trust it. Check \`git -C ${dir} status\` by hand.`
    );
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
        `toolkit working tree is dirty — refusing to pull over uncommitted changes.\n` +
          `  Commit or stash them in ${dir}, or re-run with --stash to auto-stash + restore.`
      );
    }
    git(dir, ["stash", "push", "--include-untracked", "-m", "aios update autostash"]);
    stashed = true;
    log(c.dim("  stashed dirty toolkit tree (restored after pull)."));
  }

  let pulled = 0;
  let srcHead = null;
  let snapshotDir = null;
  let restoreFailed = false;
  let ffError = null;
  try {
    if (remoteState.state === "behind" && fastForward(dir)) pulled = remoteState.behind ?? 0;
    // Clean window: fast-forward (if any) is done, stash (if any) has not been popped yet.
    // This is the only point in the whole flow where `dir` is guaranteed both current and
    // clean — pin it now, before anything downstream (including the stash restore below)
    // can dirty it again.
    srcHead = git(dir, ["rev-parse", "HEAD"]);
    snapshotDir = createPinnedSnapshot(dir, srcHead);
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
      installed = reconcileDeps(dir, { log, warn });
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
  return ret({ pulled, installed, sourceClean, srcHead, snapshotDir });
}
