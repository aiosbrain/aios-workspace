/**
 * toolkit-pull.mjs — bring a local toolkit checkout current before re-vendoring.
 *
 * `aios update` re-vendors governance FROM a toolkit checkout into the workspace. But the
 * workspace CLI is a thin shim that forwards to that same checkout, so if the checkout is
 * stale, every command runs stale code AND the re-vendor copies stale governance. This
 * module is the git half of `aios update`: fetch the toolkit, report "N commits behind",
 * fast-forward its tracked branch, and reinstall deps when the lockfile moved — so the
 * re-vendor that follows works from the newest toolkit.
 *
 * Safety: a dirty toolkit tree is never clobbered (refuse, or stash+restore with `stash`);
 * a non-fast-forward (local commits / divergence) is refused, not auto-merged.
 *
 * Zero dependencies (git + npm shelled out; Node >= 18).
 */

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
 * Reinstall toolkit deps only when the checkout already HAS node_modules (i.e. the owner
 * uses the GUI/cockpit or runs the tests) AND the pull moved the lockfile. Toolkit deps are
 * not needed for scaffolding or `aios` sync (per docs/GETTING-STARTED.md), so a sync-only
 * user without node_modules never eats a surprise `npm ci`. Prefers `npm ci` (reproducible),
 * falls back to `npm install`.
 */
function reinstallDeps(dir, { lockBefore, log, warn }) {
  const nodeModules = existsSync(path.join(dir, "node_modules"));
  if (!nodeModules) {
    log(c.dim("  no toolkit node_modules — deps only needed for the GUI/tests; skipping npm ci."));
    return false;
  }
  const lockAfter = lockfileHash(dir);
  if (lockBefore === lockAfter) {
    log(c.dim("  deps unchanged — skipping reinstall."));
    return false;
  }
  const cmd = lockAfter ? "ci" : "install";
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
  return true;
}

/**
 * Bring the toolkit checkout at `dir` current: fetch → report behind → fast-forward →
 * reinstall deps. Returns { behind, pulled, installed, upstream } for the caller's summary.
 *
 * Modes: `check`/`dryRun` fetch + report but never write; `stash` auto-stashes a dirty tree
 * and restores it; `noInstall` skips the dependency reinstall. Hard-stops (die) on a dirty
 * tree without `stash` and on a non-fast-forward — never clobber a checkout.
 */
export function pullToolkitCheckout(dir, opts = {}, io = {}) {
  const { stash = false, noInstall = false, dryRun = false, check = false } = opts;
  const log = io.log || (() => {});
  const warn = io.warn || (() => {});
  const readOnly = check || dryRun;

  const fetched = fetchToolkit(dir, warn);
  const st = trackingStatus(dir);

  if (!st.upstream) {
    log(c.dim(`  toolkit branch ${st.branch} has no upstream — skipping git pull.`));
    return { behind: 0, pulled: 0, installed: false, upstream: null };
  }
  if (st.behind === 0) {
    log(c.green(`  toolkit up to date — ${st.branch} at ${st.upstream}.`));
    return { behind: 0, pulled: 0, installed: false, upstream: st.upstream };
  }

  log(
    c.yellow(
      `  toolkit is ${st.behind} commit${st.behind === 1 ? "" : "s"} behind ${st.upstream}` +
        (st.ahead ? ` (and ${st.ahead} ahead)` : "") +
        "."
    )
  );

  if (readOnly) {
    if (!fetched) log(c.dim("  (offline — count reflects the last fetch)"));
    return { behind: st.behind, pulled: 0, installed: false, upstream: st.upstream };
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
  // Hash AFTER the stash push: an uncommitted package-lock.json edit that the stash just set
  // aside must not make "before" equal the post-pop "after" and skip a needed reinstall.
  const lockBefore = lockfileHash(dir);

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
  if (!noInstall) installed = reinstallDeps(dir, { lockBefore, log, warn });
  return { behind: st.behind, pulled, installed, upstream: st.upstream };
}
