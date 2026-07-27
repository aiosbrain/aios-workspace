/**
 * toolkit-pull/remote-state.mjs — classify a toolkit checkout's relationship to its remote.
 *
 * Owned invariant: this module is the ONLY place that decides how a toolkit checkout
 * relates to its remote (current/behind/diverged/unreachable/…), whether its working tree
 * is safe to read from (clean/dirty/unmerged), and whether it may be fast-forwarded. A
 * `local-status-error` or `inspection-error` is never conflated with a positive "clean" or
 * "current" verdict — an uninspectable state always fails closed. `acquireRemoteState` is
 * used IDENTICALLY by `--check`/`--preview` (readonly, `ls-remote`, zero writes) and apply
 * (a real `--prune`d fetch); `REMOTE_APPLY_ALLOW_STATES` is the one allowlist both
 * `pullToolkitCheckout` (below, via toolkit-pull.mjs) and `update.mjs`'s `buildResult`
 * consult for "is this source safe to vendor/pull from". Extracted verbatim (AIO-559) from
 * `scripts/toolkit-pull.mjs`, which now imports and re-exports the surface this module owns.
 *
 * Zero dependencies (git shelled out).
 */

import { c, UpdateError, gitEnv, safeReal } from "../cli-common.mjs";
import { execFileSync } from "node:child_process";

/** Run git in `dir`; returns trimmed stdout. Throws on non-zero (caller may catch).
 *  `opts` passes through to execFileSync (used for `timeout` on network probes).
 *  Runs with `gitEnv()` — an inherited GIT_DIR/GIT_WORK_TREE (git sets these for every
 *  hook it runs) would otherwise override `-C dir` and answer about the WRONG repo,
 *  failing the containment probes open. */
export function git(dir, gitArgs, opts = {}) {
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
export function gitSafe(dir, gitArgs) {
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
    return {
      state: "local-status-error",
      branch,
      upstream: upstreamName,
      behind: null,
      ahead: 0,
      remoteSha,
    };
  }
  if (remoteSha === localHead) {
    return { state: "current", branch, upstream: upstreamName, behind: 0, ahead: 0, remoteSha };
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
    return {
      state: onCountFailure,
      branch,
      upstream: upstreamName,
      behind: null,
      ahead: 0,
      remoteSha,
    };
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
      remoteSha,
    };
  }
  return {
    state: "behind",
    branch,
    upstream: upstreamName,
    behind: Number(behind) || 0,
    ahead: 0,
    remoteSha,
  };
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
