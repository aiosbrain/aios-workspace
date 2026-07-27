/**
 * toolkit-pull/snapshot-deps.mjs — pin an immutable snapshot and reconcile toolkit deps.
 *
 * Owned invariant: this module is the ONLY place that pins a fast-forwarded toolkit checkout
 * into an immutable `git worktree` snapshot (`createPinnedSnapshot`/`removePinnedSnapshot`),
 * and the ONLY place that reinstalls toolkit `node_modules` (`reconcileDeps`). Once a snapshot
 * is created, NOTHING can mutate it — the vendor-apply step's coherency guarantee depends on
 * that, so the merge/catalog/metadata steps downstream never re-read the live (mutable)
 * checkout. `reconcileDeps` never runs `npm ci` through a SYMLINKED node_modules (worktree
 * layout) — that would delete through the symlink and erase the shared install — and an
 * install interrupted before it completed self-heals on the next run via a recorded lockfile
 * hash, rather than being masked forever by an early return. Extracted verbatim (AIO-559) from
 * `scripts/toolkit-pull.mjs`, which now imports and re-exports the surface this module owns.
 *
 * Zero dependencies (git + npm shelled out).
 */

import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, writeFileSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, sha256 } from "../cli-common.mjs";
import { gitSafe } from "./remote-state.mjs";

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

export function lockfileHash(dir) {
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
 * `lockChanged` (did THIS run's fast-forward move the lockfile?) exists for the no-marker
 * case: every checkout that predates the marker has node_modules but no marker, and treating
 * that as "install pending" would run a destructive `npm ci` (which deletes node_modules
 * first) over a perfectly healthy install on the first post-upgrade run — offline, that
 * wipes a working install and then fails. When no marker is recorded AND this run didn't
 * move the lockfile, the install predates marker tracking rather than being pending: seed
 * the marker from the current lockfile and skip npm. A recorded-but-mismatched marker still
 * always reinstalls — that is the interrupted-install self-heal this marker exists for.
 *
 * CRITICAL: never run npm through a SYMLINKED node_modules. `npm ci` deletes node_modules, and
 * in a git worktree that path is a symlink to the primary checkout's shared install — following
 * it would erase the shared target. Detect the symlink with lstat and skip. Prefers `npm ci`
 * (reproducible), falls back to `npm install`. Records the new hash only AFTER npm succeeds.
 * Always operates on the LIVE checkout (`dir`), never the pinned snapshot — dependency
 * installation is a shared-install concern unrelated to vendor coherency.
 */
export function reconcileDeps(dir, { log, warn, lockChanged = true }) {
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
  // A lockfile-less source is a real, recordable install state — use a sentinel rather
  // than skipping the marker write. Gating the write on a non-null hash meant a source
  // whose lockfile disappeared could NEVER refresh a stale marker: every run re-ran a full
  // `npm install` forever, and offline that throw hard-blocked the whole update.
  const currentKey = currentHash ?? "no-lockfile";
  const stored = marker && existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
  const recordMarker = () => {
    if (!marker) return;
    try {
      // Recompute from disk at write time, never reuse the pre-npm key: a lockfile-less
      // `npm install` GENERATES package-lock.json, so recording the stale "no-lockfile"
      // sentinel here would mismatch the very next run's hash and force a second
      // destructive reinstall before converging. The key must describe the state npm
      // actually left behind.
      writeFileSync(marker, `${lockfileHash(dir) ?? "no-lockfile"}\n`);
    } catch {
      /* metadata is best-effort; a missing marker just means a redundant reconcile next run */
    }
  };
  if (currentKey === stored) {
    log(c.dim("  deps unchanged — skipping reinstall."));
    return false;
  }
  if (stored === null) {
    // Pre-marker era (no install this code ever managed). Two orthogonal questions:
    //
    // (1) Is the existing node_modules VERIFIABLY a complete npm install? npm (v7+)
    // writes `node_modules/.package-lock.json` as the last step of a finished install.
    // No artifact means UNVERIFIABLE, not broken: pnpm/yarn/bun and npm ≤6 never write
    // it, so a healthy non-npm install is indistinguishable from an interrupted `npm ci`.
    // The update NEVER destroys what it can't verify — `npm ci` deletes node_modules
    // first, and offline that wipes a working install unrecoverably. This rule holds
    // UNCONDITIONALLY, including when this run's pull moved the lockfile (gating it on
    // !lockChanged would make the promised tolerance last exactly until the first
    // lockfile-moving pull). Warn, leave it alone, record NO marker, so the state is
    // re-evaluated every run and self-heals when the owner runs `npm ci` by hand. npm is
    // the only SUPPORTED manager (docs/design-self-update.md, "supported source
    // envelope") — other managers' installs are tolerated, never "repaired".
    if (!existsSync(path.join(nm, ".package-lock.json"))) {
      warn(
        c.yellow(
          "  can't verify this node_modules is a complete npm install (no .package-lock.json —\n" +
            "  a non-npm install, or an interrupted `npm ci`?) — leaving it untouched.\n" +
            `  If toolkit deps misbehave, run \`npm ci\` in ${dir} yourself.`
        )
      );
      return false;
    }
    // (2) Verified npm install, but does it need a reinstall? Only if THIS run's pull
    // moved the lockfile — otherwise the healthy pre-marker install just gets its marker
    // seeded (first marker-tracked run). A verified install with a moved lockfile falls
    // through to the normal reinstall below, exactly like a recorded-but-mismatched
    // marker would.
    if (!lockChanged) {
      log(c.dim("  deps unchanged — recording the install marker (first marker-tracked run)."));
      recordMarker();
      return false;
    }
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
  recordMarker();
  return true;
}
