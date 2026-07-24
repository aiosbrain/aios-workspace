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
import { c, sha256, UpdateError, gitEnv, safeReal } from "./cli-common.mjs";

/** Run git in `dir`; returns trimmed stdout. Throws on non-zero (caller may catch).
 *  `opts` passes through to execFileSync (used for `timeout` on network probes).
 *  Runs with `gitEnv()` — an inherited GIT_DIR/GIT_WORK_TREE (git sets these for every
 *  hook it runs) would otherwise override `-C dir` and answer about the WRONG repo,
 *  failing the containment probes open. */
function git(dir, gitArgs, opts = {}) {
  return execFileSync("git", ["-C", dir, ...gitArgs], {
    encoding: "utf8",
    env: gitEnv(),
    ...opts,
  }).trim();
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
 * Refuse a toolkit source dir that is not itself a git checkout — BEFORE any other git
 * operation runs against it. Two distinct failure shapes, both previously misdiagnosed
 * deep in the flow: a standalone non-git copy (unpacked tarball) failed with
 * "couldn't determine whether the toolkit checkout is clean", and — far worse — a non-git
 * dir sitting INSIDE another repository made every `git -C dir` call silently resolve the
 * ENCLOSING repo, so `--stash` could stash away that unrelated repo's WIP mid-run. The
 * pinned-snapshot design requires a real git checkout (there is no coherent sha that could
 * represent a non-git tree), so refuse honestly and up front.
 */
export function assertGitToolkitSource(dir) {
  let top;
  try {
    top = git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new UpdateError(
      `the toolkit source at ${dir} is not a git checkout — aios update vendors from a pinned ` +
        `git snapshot, so a plain copy/tarball of the toolkit can't be used.\n` +
        `  Clone it instead (git clone <toolkit repo>), or point --from/AIOS_TOOLKIT_DIR at a real checkout.`
    );
  }
  if (safeReal(top) !== safeReal(dir)) {
    throw new UpdateError(
      `the toolkit source at ${dir} is not itself a git checkout — it sits inside the repository ` +
        `at ${top}, and running git operations there (stash/fetch/snapshot) would act on that ` +
        `ENCLOSING repo instead. Clone the toolkit as its own checkout and point --from at it.`
    );
  }
}

/**
 * The ONLY remote states an apply may proceed under — the one allowlist shared by every
 * gate that decides "is this source safe to vendor/pull from" (buildResult's applyAllowed
 * in update.mjs AND pullToolkitCheckout's apply-mode refusals below). Allowlist, never a
 * blocklist: any state a future acquireRemoteState change adds blocks by construction
 * everywhere at once, instead of silently defaulting to allowed at whichever gate forgot
 * to learn the new name.
 */
export const REMOTE_APPLY_ALLOW_STATES = Object.freeze([
  "current",
  "behind",
  "no-upstream",
  "unreachable",
  "missing-upstream-ref",
]);

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

/** Read the branch's configured upstream independently of whether its local tracking ref
 *  currently exists. `rev-parse @{u}` requires both configuration AND a resolvable ref, so
 *  using it as the existence check turns a pruned/deleted local `refs/remotes/*` entry into
 *  a false "no-upstream". Only the absence of both config keys means no upstream; partial
 *  or unreadable configuration is a local-status error and must fail closed. */
function configuredUpstream(dir, branch) {
  const getConfig = (key) => {
    try {
      return { ok: true, value: git(dir, ["config", "--get", key]) };
    } catch (error) {
      // `git config --get` uses status 1 for a genuinely absent key. Any other failure
      // means the repository/config could not be inspected and must not look unconfigured.
      if (error?.status === 1) return { ok: true, value: "" };
      return { ok: false, value: "" };
    }
  };

  const remoteConfig = getConfig(`branch.${branch}.remote`);
  const mergeConfig = getConfig(`branch.${branch}.merge`);
  if (!remoteConfig.ok || !mergeConfig.ok)
    return { state: "error", detail: "the branch's tracking configuration couldn't be read" };
  if (!remoteConfig.value && !mergeConfig.value) return { state: "none" };
  if (!remoteConfig.value || !mergeConfig.value)
    return {
      state: "error",
      detail:
        `branch.${branch}.${remoteConfig.value ? "remote" : "merge"} is set but ` +
        `branch.${branch}.${remoteConfig.value ? "merge" : "remote"} is not — half-configured ` +
        `tracking; fix with \`git branch --set-upstream-to <remote>/<branch>\` or ` +
        `\`git branch --unset-upstream\``,
    };

  const remote = remoteConfig.value;
  const remoteRef = mergeConfig.value;
  const remoteBranch = remoteRef.startsWith("refs/heads/")
    ? remoteRef.slice("refs/heads/".length)
    : remoteRef;
  // Prefer Git's own display name when the tracking ref is present. When it is missing,
  // retain the configured identity so readonly can ls-remote it and apply can fetch it.
  const resolvedName = gitSafe(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const upstreamName =
    resolvedName || (remote === "." ? remoteBranch : `${remote}/${remoteBranch}`);
  return { state: "configured", remote, remoteRef, upstreamName };
}

/** Best-effort behind/ahead from the LOCAL tracking ref, for when the remote itself can't
 *  be reached — clearly a stale estimate, never a substitute for a verified count. Critically,
 *  `ahead` still matters even offline: the old trackingStatus()-based design unconditionally
 *  computed ahead from the local ref regardless of fetch success, so a toolkit with local
 *  commits never pushed anywhere was refused as "diverged" even offline. Collapsing straight
 *  to "unreachable" on fetch failure (without consulting this) would silently drop that
 *  coverage and let an offline, locally-diverged toolkit be vendored from.
 *
 *  `ahead: null` (NOT 0) when the estimate itself fails — e.g. the tracking ref was pruned
 *  by an earlier `fetch --prune` while the upstream branch was renamed/missing, then the
 *  network went away. "Couldn't count" must never read as "not ahead": the offline callers
 *  treat null as indeterminate and fail closed rather than vendoring a checkout whose
 *  local-only commits can no longer be ruled out. */
function staleLocalStatus(dir, upstreamName) {
  const counts = gitSafe(dir, ["rev-list", "--left-right", "--count", `${upstreamName}...HEAD`]);
  if (!counts) return { behind: null, ahead: null };
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  return {
    behind: Number.isFinite(behind) ? behind : null,
    ahead: Number.isFinite(ahead) ? ahead : null,
  };
}

/**
 * THE one implementation of "a verified count wasn't available — classify from the stale
 * local tracking ref". Two callers reach this from different directions (the apply-mode
 * fetch catch / readonly ls-remote catch, and the readonly rev-list-count catch), and the
 * RULE must be identical for both, because the thing it decides is identical: can
 * local-only commits be ruled out?
 *
 *   ahead > 0     → `diverged`             (local-only commits POSITIVELY present)
 *   ahead === null → `local-status-error`  (the estimate itself failed — divergence can't
 *                                           be ruled out, so fail closed)
 *   otherwise      → null                  (positively no local-only commits; the caller
 *                                           decides what "no divergence" means in its
 *                                           context — unreachable vs. behind)
 *
 * Only the caller-specific colouring is parameterized (`detail`, an optional `warn`): the
 * verdict is not. Do not re-inline this — the two copies it replaces had already drifted
 * in message text, which is exactly how the underlying rule drifts next.
 */
function staleAheadTriage(dir, branch, upstreamName, { detail, warn } = {}) {
  const stale = staleLocalStatus(dir, upstreamName);
  // A local commit not on the last-known remote state is real divergence regardless of
  // network reachability — never silently vendor from it just because we're offline.
  if (stale.ahead > 0) {
    return {
      verdict: {
        state: "diverged",
        branch,
        upstream: upstreamName,
        behind: stale.behind ?? 0,
        ahead: stale.ahead,
      },
      stale,
    };
  }
  // The divergence estimate itself failed (tracking ref missing — e.g. pruned by an
  // earlier fetch while the upstream branch was renamed). There is now NO evidence ruling
  // out local-only commits, so anything that lets apply proceed would vendor a
  // possibly-diverged checkout. Fail closed.
  if (stale.ahead === null) {
    warn?.();
    return {
      verdict: {
        state: "local-status-error",
        branch,
        upstream: upstreamName,
        behind: null,
        ahead: 0,
        detail,
      },
      stale,
    };
  }
  return { verdict: null, stale };
}

/** The remote couldn't be queried at all: triage against the stale ref, and when it
 *  positively shows no local-only commits, report `unreachable` (carrying the stale behind
 *  estimate so callers can say "possibly N behind" without claiming it as verified). */
function offlineFallbackState(dir, branch, upstreamName, warn) {
  const { verdict, stale } = staleAheadTriage(dir, branch, upstreamName, {
    detail: "the remote is unreachable and the local tracking ref is missing",
    warn: () =>
      warn(
        c.yellow(
          "  …and the local tracking ref is missing, so local-only commits can't be ruled out."
        )
      ),
  });
  if (verdict) return verdict;
  return {
    state: "unreachable",
    branch,
    upstream: upstreamName,
    behind: null,
    ahead: 0,
    staleBehindEstimate: stale.behind,
  };
}

/** Shared classification tail: given a resolved remote-side sha (however it was obtained)
 *  and local HEAD, decide current/behind/diverged — or local-status-error if a LOCAL git
 *  op fails, which is never conflated with an unreachable remote. `onCountFailure` lets
 *  the two callers assign different meaning to "the rev-list count itself failed": in
 *  readonly mode the remote object simply isn't fetched locally yet (expected, → still
 *  "behind", count unknown); in apply mode (called AFTER a real fetch) the same failure
 *  means something local is actually broken (→ "local-status-error"). `checkStaleAheadOnCountFailure`
 *  (readonly only) still consults the stale local tracking ref before falling back to
 *  `onCountFailure` — a count failure there is EXPECTED (the remote object was never
 *  fetched), which must not silently swallow real local-only-commit divergence the way a
 *  plain "behind" verdict would (leaving `buildResult().applyAllowed` true for a checkout
 *  apply mode will hard-refuse as diverged). */
function classifyAgainst(
  dir,
  remoteSha,
  branch,
  upstreamName,
  { onCountFailure, checkStaleAheadOnCountFailure = false }
) {
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
    if (checkStaleAheadOnCountFailure) {
      // Same triage as the offline path, via the same helper — the rule ("can local-only
      // commits be ruled out?") is identical; only the diagnosis differs, because here the
      // remote IS reachable and it's the local ref that's missing. A null estimate used to
      // fall through to a plain "behind" (applyAllowed true) on the theory that apply
      // re-verifies — but that produced the exact offered-then-refused sequence the
      // consolidation exists to eliminate: readonly said "behind", onboarding offered the
      // apply, apply's real fetch restored the ref and hard-refused as diverged AFTER the
      // user confirmed. Fail closed here too.
      const { verdict } = staleAheadTriage(dir, branch, upstreamName, {
        detail:
          "the remote is reachable but the local tracking ref is missing, so local-only " +
          "commits can't be ruled out — run `git fetch` in the toolkit checkout (a real " +
          "`aios update` apply fetches automatically)",
      });
      if (verdict) return verdict;
    }
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
 *                           local tracking ref POSITIVELY shows no local-only commits. Apply
 *                           may still proceed from local state; check/preview never green.
 *                           An offline checkout whose tracking ref is missing (estimate
 *                           indeterminate) is never "unreachable" — see local-status-error.
 *   local-status-error     — a LOCAL git operation failed: either a rev-parse/rev-list after
 *                           a successful remote query (broken LOCAL repo), or — with the
 *                           remote unreachable — the stale-divergence estimate itself
 *                           (missing tracking ref), which leaves local-only commits
 *                           impossible to rule out. Always hard-blocks (never treated as
 *                           acceptable-offline).
 */
export function acquireRemoteState(dir, { mode, warn = () => {} } = {}) {
  let branch;
  try {
    branch = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    return {
      state: "local-status-error",
      branch: "HEAD",
      upstream: null,
      behind: null,
      ahead: 0,
      detail: "couldn't resolve HEAD",
    };
  }
  // `--abbrev-ref HEAD` prints the literal string "HEAD" when detached — a paused
  // rebase/bisect, or a checkout pinned at a sha. Without this check it would collapse
  // into "no-upstream" (no branch.HEAD.* config exists) and green straight through,
  // silently vendoring whatever ancient commit the checkout is parked on as "current".
  // Not a branch at all → fail closed like any other uninterpretable local state.
  if (branch === "HEAD") {
    return {
      state: "local-status-error",
      branch,
      upstream: null,
      behind: null,
      ahead: 0,
      detail:
        "detached HEAD — the toolkit checkout isn't on a branch (paused rebase/bisect, or " +
        "pinned at a sha); check out a branch first",
    };
  }

  const upstreamConfig = configuredUpstream(dir, branch);
  if (upstreamConfig.state === "error") {
    return {
      state: "local-status-error",
      branch,
      upstream: null,
      behind: null,
      ahead: 0,
      detail: upstreamConfig.detail,
    };
  }
  if (upstreamConfig.state === "none") {
    return { state: "no-upstream", branch, upstream: null, behind: 0, ahead: 0 };
  }
  const { remote, remoteRef } = upstreamConfig;
  let { upstreamName } = upstreamConfig;

  // `branch.<name>.remote = .` means another branch in this same repository. There is no
  // network remote to query or fetch; classify directly against the configured merge ref.
  if (remote === ".") {
    let upstreamSha;
    try {
      upstreamSha = git(dir, ["rev-parse", remoteRef]);
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

  if (mode === "apply") {
    try {
      // --prune is the fix for a deleted/renamed upstream branch: without it, a plain
      // fetch leaves the stale local tracking ref in place, silently trusted as current.
      git(dir, ["fetch", "--prune", "--quiet", remote]);
    } catch (e) {
      warn(c.yellow(`  git fetch failed (${e.message.trim()}) — reporting last-known state`));
      return offlineFallbackState(dir, branch, upstreamName, warn);
    }
    let upstreamSha;
    try {
      // A configured-but-missing tracking ref should now have been restored by fetch. Ask
      // Git for its canonical local name again before resolving the object.
      upstreamName =
        gitSafe(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) || upstreamName;
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
    // 30s timeout: this is the one network probe read-only modes make (--check/--preview/
    // onboarding), and git's default transport can otherwise hang for minutes on a dropping
    // connection; a timeout lands in the same catch as any other unreachable remote.
    // Direct try/catch — NOT gitSafe, so "threw" (unreachable) is distinguishable from
    // "succeeded, zero matching lines" (missing-upstream-ref) below.
    out = git(dir, ["ls-remote", remote, remoteRef], { timeout: 30_000 });
  } catch {
    warn(c.yellow("  couldn't reach the remote — reporting local state only (unverified)."));
    return offlineFallbackState(dir, branch, upstreamName, warn);
  }
  // Pick the configured ref exactly, never a same-suffixed sibling or same-named tag.
  const wantHead = remoteRef;
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
  return classifyAgainst(dir, remoteSha, branch, upstreamName, {
    onCountFailure: "behind",
    checkStaleAheadOnCountFailure: true,
  });
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
        text: `couldn't validate the local toolkit repository state (${rs.detail || "a git index/ref query failed"}) — refusing to trust it.`,
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
 * callers (vendorSafety) must treat that as unsafe, not as "no unmerged paths". It runs
 * against BOTH kinds of source: the live checkout (check/preview) where an in-progress
 * merge is a real possibility, and the pinned snapshot (cmdVendorApplyOnly's vendorSafety
 * gate) where a fresh checkout of a finalized commit can't have one by construction — the
 * probe is kept there anyway because the fail-closed contract ("uninspectable == unsafe")
 * matters as much as the positive check.
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
function srcTouchedInRange(dir, oldSha, newSha) {
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
 * range is locally inspectable; `null` when it isn't (the remote object isn't fetched yet, so
 * the honest answer is "can't tell without pulling" — @{u} may be stale in read-only mode).
 * Mirrors the read-only-vs-apply split: report whether a rebuild is needed, never perform one.
 */
function readOnlyRebuildNeeded(dir, remoteState) {
  if (!remoteState || remoteState.state !== "behind") return false;
  return srcTouchedInRange(dir, "HEAD", "@{u}");
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
function rebuildDist(dir, { log, warn }) {
  const nm = path.join(dir, "node_modules");
  let st = null;
  try {
    st = lstatSync(nm);
  } catch {
    st = null;
  }
  if (!st) {
    log(
      c.dim("  no toolkit node_modules — can't rebuild dist/; skipping (deps needed for the loop runtime).")
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
  // shell:true on Windows (npm is npm.cmd — execFileSync("npm") throws ENOENT there); the args
  // are fixed strings, so shell interpolation is safe. Mirrors reconcileDeps' npm invocation.
  const npmOpts = { cwd: dir, stdio: "inherit", shell: process.platform === "win32" };
  try {
    execFileSync("npm", ["run", "build:loop"], npmOpts);
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
function reconcileDeps(dir, { log, warn, lockChanged = true }) {
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
