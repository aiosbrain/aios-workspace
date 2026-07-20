/**
 * toolkit-pull.mjs — bring a local toolkit checkout current before re-vendoring.
 *
 * `aios update` re-vendors governance FROM a toolkit checkout into the workspace. But the
 * workspace CLI is a thin shim that forwards to that same checkout, so if the checkout is
 * stale, every command runs stale code AND the re-vendor copies stale governance. This
 * module is the git half of `aios update`: report how far behind the toolkit is, fast-forward
 * its tracked branch, and reconcile deps — so the re-vendor that follows works from the
 * newest toolkit.
 *
 * Safety: `--check` is truly read-only — it reads the remote via `ls-remote` (no fetch, so no
 * ref/FETCH_HEAD writes) and never greens an unverified remote. A dirty toolkit tree is never
 * clobbered (refuse, or stash+restore with `stash`); a non-fast-forward is refused, not
 * auto-merged; `npm ci` never runs through a SYMLINKED node_modules (worktree layout), and an
 * install interrupted before it ran self-heals on the next run via a recorded lockfile hash.
 *
 * Zero dependencies (git + npm shelled out; Node >= 18).
 */

import path from "node:path";
import { existsSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, die, sha256 } from "./cli-common.mjs";

/** Run git in `dir`; returns trimmed stdout. Throws on non-zero (caller may catch). */
function git(dir, gitArgs) {
  return execFileSync("git", ["-C", dir, ...gitArgs], { encoding: "utf8" }).trim();
}

/** Same, but returns "" instead of throwing (for best-effort status queries). */
function gitSafe(dir, gitArgs) {
  try {
    return git(dir, gitArgs);
  } catch {
    return "";
  }
}

/** `true` if the toolkit working tree has uncommitted changes (tracked or untracked). */
export function isDirty(dir) {
  return gitSafe(dir, ["status", "--porcelain"]).length > 0;
}

/**
 * Branch + upstream + how far HEAD is behind/ahead of its tracking ref. Call after a fetch
 * so the counts reflect the remote. `upstream` is null when the branch has no tracking ref
 * (a detached HEAD or a local-only branch) — those can't be pulled.
 */
export function trackingStatus(dir) {
  const branch = gitSafe(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  const upstream = gitSafe(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) return { branch, upstream: null, behind: 0, ahead: 0 };
  // `--left-right --count @{u}...HEAD` → "<behind>\t<ahead>".
  const counts = gitSafe(dir, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  const [behind = "0", ahead = "0"] = counts.split(/\s+/);
  return { branch, upstream, behind: Number(behind) || 0, ahead: Number(ahead) || 0 };
}

/**
 * Read the remote head WITHOUT fetching — `git ls-remote` writes no refs and no FETCH_HEAD, so
 * `--check` stays truly read-only w.r.t. the toolkit repo (a plain `git fetch` would mutate
 * `refs/remotes/*` + FETCH_HEAD). Returns { upstream, branch, behind, ahead, remoteVerified }.
 * `behind` is null when the remote demonstrably differs but its objects aren't local (so an
 * exact count would need a fetch); `remoteVerified` is false when the remote was unreachable —
 * callers MUST NOT print a green verdict in that case (stale local tracking must not read green).
 */
export function remoteStatus(dir, warn = () => {}) {
  const branch = gitSafe(dir, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD";
  const upstream = gitSafe(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (!upstream) return { branch, upstream: null, behind: 0, ahead: 0, remoteVerified: false };
  const slash = upstream.indexOf("/");
  const remote = upstream.slice(0, slash);
  const remoteBranch = upstream.slice(slash + 1);
  const line = gitSafe(dir, ["ls-remote", remote, remoteBranch]);
  if (!line) {
    warn(c.yellow("  couldn't reach the remote — reporting local state only (unverified)."));
    return { branch, upstream, behind: null, ahead: 0, remoteVerified: false };
  }
  const remoteSha = line.split(/\s+/)[0];
  const localHead = gitSafe(dir, ["rev-parse", "HEAD"]);
  if (remoteSha === localHead)
    return { branch, upstream, behind: 0, ahead: 0, remoteVerified: true };
  // Exact counts need the remote object present locally (a prior fetch). Without one, we still
  // KNOW it differs — report behind:null rather than fetching (which would mutate refs).
  const counts = gitSafe(dir, ["rev-list", "--left-right", "--count", `${remoteSha}...HEAD`]);
  if (counts && !counts.toLowerCase().includes("fatal")) {
    const [behind = "0", ahead = "0"] = counts.split(/\s+/);
    return {
      branch,
      upstream,
      behind: Number(behind) || 0,
      ahead: Number(ahead) || 0,
      remoteVerified: true,
    };
  }
  return { branch, upstream, behind: null, ahead: 0, remoteVerified: true };
}

/** Fetch the toolkit's tracked remote (quietly). Best-effort — offline still lets us report local state. */
export function fetchToolkit(dir, warn = () => {}) {
  try {
    // Fetch the remote the current branch actually tracks — a bare `git fetch` hits only the
    // default remote, which can leave @{u} stale when the branch tracks a different remote
    // (e.g. `upstream/main` on a fork with `origin` as the default).
    const upstream = gitSafe(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const remote = upstream.includes("/") ? upstream.split("/")[0] : null;
    git(dir, remote ? ["fetch", "--quiet", remote] : ["fetch", "--quiet"]);
    return true;
  } catch (e) {
    warn(c.yellow(`  git fetch failed (${e.message.trim()}) — reporting last-known state`));
    return false;
  }
}

/**
 * Paths left UNMERGED in the toolkit index — the state a conflicted `git stash pop` (or any
 * half-finished merge) leaves behind, where files on disk hold `<<<<<<<` markers. Vendoring
 * from a checkout in this state would copy those markers into executable governance files,
 * so callers must refuse. Empty array when the checkout is clean (or isn't a git repo).
 */
export function unmergedPaths(dir) {
  const out = gitSafe(dir, ["diff", "--name-only", "--diff-filter=U"]);
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

function lockfileHash(dir) {
  const lock = path.join(dir, "package-lock.json");
  return existsSync(lock) ? sha256(readFileSync(lock)) : null;
}

/**
 * Where the lockfile hash of the last SUCCESSFUL install is recorded — under the git common
 * dir (untracked, shared across worktrees). Comparing against it on every run means an install
 * interrupted between fast-forward and `npm ci` self-heals next time, instead of being masked
 * forever by a `behind === 0` early return.
 */
function installedLockPath(dir) {
  const common = gitSafe(dir, ["rev-parse", "--git-common-dir"]);
  if (!common) return null;
  return path.join(path.resolve(dir, common), "aios-installed-lock");
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
 * Bring the toolkit checkout at `dir` current: read remote status → report → fast-forward →
 * reconcile deps. Returns { behind, pulled, installed, upstream, remoteVerified } — `behind` is
 * null when the remote differs but its count is unknown; `remoteVerified` is false when the
 * remote was unreachable (callers must not green-light either).
 *
 * Modes: `check`/`dryRun` report via `ls-remote` and never write (no fetch, no fast-forward, no
 * install); `stash` auto-stashes a dirty tree and restores it; `noInstall` skips the dep
 * reconcile. Hard-stops (die) on a dirty tree without `stash`, on a non-fast-forward, and on a
 * conflicted stash restore — never clobber a checkout.
 */
export function pullToolkitCheckout(dir, opts = {}, io = {}) {
  const { stash = false, noInstall = false, dryRun = false, check = false } = opts;
  const log = io.log || (() => {});
  const warn = io.warn || (() => {});
  const readOnly = check || dryRun;

  // READ-ONLY modes never fetch (fetch mutates refs + FETCH_HEAD). ls-remote reads the remote
  // head with zero writes. APPLY mode fetches — it's about to fast-forward, so ref updates are
  // expected — then counts from the freshly-updated tracking ref.
  const st = readOnly
    ? remoteStatus(dir, warn)
    : (() => {
        const fetched = fetchToolkit(dir, warn);
        return { ...trackingStatus(dir), remoteVerified: fetched };
      })();
  const ret = (extra) => ({
    behind: st.behind,
    pulled: 0,
    installed: false,
    upstream: st.upstream,
    remoteVerified: st.remoteVerified,
    ...extra,
  });

  if (!st.upstream) {
    log(c.dim(`  toolkit branch ${st.branch} has no upstream — skipping git pull.`));
    return ret();
  }

  // A verified, zero-behind remote is the only green. An unverified remote (offline) or an
  // unknown count (differs, objects not local) must NOT read as "up to date".
  if (st.remoteVerified && st.behind === 0) {
    log(c.green(`  toolkit up to date — ${st.branch} at ${st.upstream}.`));
  } else if (!st.remoteVerified) {
    log(c.yellow(`  toolkit remote status unverified (offline?) — ${st.branch}, local HEAD only.`));
  } else if (st.behind === null) {
    log(c.yellow(`  toolkit differs from ${st.upstream} (behind — run \`aios update\` to fetch).`));
  } else {
    log(
      c.yellow(
        `  toolkit is ${st.behind} commit${st.behind === 1 ? "" : "s"} behind ${st.upstream}` +
          (st.ahead ? ` (and ${st.ahead} ahead)` : "") +
          "."
      )
    );
  }

  if (readOnly) return ret();

  // APPLY mode. Only a KNOWN positive behind-count is a fast-forward; null/unverified means we
  // couldn't confirm the remote — vendor from the local toolkit as-is (nothing to pull).
  const behindPositive = typeof st.behind === "number" && st.behind > 0;
  if (!behindPositive) {
    let installed = false;
    if (!noInstall) installed = reconcileDeps(dir, { log, warn }); // still repairs an interrupted install
    return ret({ installed });
  }

  if (st.ahead > 0) {
    die(
      `toolkit branch ${st.branch} has ${st.ahead} local commit(s) not on ${st.upstream} — ` +
        `not a fast-forward. Reconcile it by hand (rebase/merge), then re-run \`aios update\`.`
    );
  }

  let stashed = false;
  if (isDirty(dir)) {
    if (!stash) {
      die(
        `toolkit working tree is dirty — refusing to pull over uncommitted changes.\n` +
          `  Commit or stash them in ${dir}, or re-run with --stash to auto-stash + restore.`
      );
    }
    git(dir, ["stash", "push", "--include-untracked", "-m", "aios update autostash"]);
    stashed = true;
    log(c.dim("  stashed dirty toolkit tree (restored after pull)."));
  }

  let pulled = 0;
  let restoreFailed = false;
  let ffError = null;
  try {
    if (fastForward(dir)) pulled = st.behind;
  } catch (e) {
    // Surface an unexpected merge failure as a normal error message (the stash restore in
    // `finally` still runs) instead of letting a raw stack escape to the user.
    ffError = e;
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
    die(
      `fast-forwarding the toolkit checkout failed (${String(ffError.message || ffError).trim()}).\n` +
        `  Nothing was re-vendored${stashed ? (restoreFailed ? "; restoring your stash ALSO conflicted (it is preserved — git -C " + dir + " stash list)" : "; your stashed changes were restored") : ""}.\n` +
        `  Reconcile ${dir} by hand, then re-run \`aios update\`.`
    );
  }
  if (restoreFailed) {
    die(
      `restoring your stashed toolkit changes hit a conflict in ${dir}.\n` +
        `  The pull landed, but your local edits couldn't be reapplied cleanly, so the update is\n` +
        `  aborted before installing or re-vendoring. Resolve the conflict (git -C ${dir} status;\n` +
        `  your stash is preserved), then re-run \`aios update\`.`
    );
  }
  log(
    c.green(
      `  pulled ${pulled} commit${pulled === 1 ? "" : "s"} → toolkit at ${gitSafe(dir, ["rev-parse", "--short", "HEAD"])}.`
    )
  );

  let installed = false;
  if (!noInstall) installed = reconcileDeps(dir, { log, warn });
  return ret({ pulled, installed });
}
