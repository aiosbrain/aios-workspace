import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import {
  acquireRemoteState,
  sourceCleanliness,
  fastForward,
  createPinnedSnapshot,
  removePinnedSnapshot,
  unmergedPaths,
} from "../scripts/toolkit-pull.mjs";
import { git, originAndClone, advance, tmpRoot } from "./toolkit-test-fixtures.mjs";

// toolkit-pull.mjs is the git half of `aios update`: classify a checkout's relationship to
// its remote (acquireRemoteState, one owner used identically by --check/--preview and
// apply), the dirty-tree guard (sourceCleanliness, fail-closed), and pin an immutable
// snapshot to vendor from (createPinnedSnapshot). No network — real local repos throughout.

test("acquireRemoteState: current, behind (readonly vs apply), and fast-forward clears it", () => {
  const root = tmpRoot("aios-pull-");
  try {
    const { origin, clone } = originAndClone(root);

    let st = acquireRemoteState(clone, { mode: "apply" });
    assert.equal(st.state, "current");
    assert.equal(st.behind, 0);

    advance(origin, "v2\n");

    // readonly (ls-remote, no fetch): knows it differs, but the remote object isn't fetched
    // locally yet, so the exact count is unavailable — still correctly "behind", not "current".
    st = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(st.state, "behind");
    assert.equal(st.behind, null);

    // apply (real, pruning fetch): exact count now available.
    st = acquireRemoteState(clone, { mode: "apply" });
    assert.equal(st.state, "behind");
    assert.equal(st.behind, 1);

    assert.equal(fastForward(clone), true, "fast-forward moved HEAD");
    assert.equal(acquireRemoteState(clone, { mode: "apply" }).state, "current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState: diverged (local commit not on remote), exact in apply mode", () => {
  const root = tmpRoot("aios-pull-diverge-");
  try {
    const { origin, clone } = originAndClone(root);
    advance(origin, "origin-side\n");
    writeFileSync(`${clone}/g.txt`, "local-side\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local");

    // readonly mode never fetches, so the remote's commit object isn't locally available to
    // diff against — it can tell HEAD differs, but not narrow "diverged" vs "behind" without
    // fetching (the same reason `behind` can be null in readonly mode elsewhere). It must
    // still never claim "current"/green here.
    assert.notEqual(acquireRemoteState(clone, { mode: "readonly" }).state, "current");
    // apply mode DOES fetch, so the object is available and the exact relationship is known.
    const applySt = acquireRemoteState(clone, { mode: "apply" });
    assert.equal(applySt.state, "diverged");
    assert.equal(applySt.ahead, 1);
    assert.equal(applySt.behind, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState: no-upstream is distinct from unreachable/missing-ref", () => {
  const root = tmpRoot("aios-pull-noupstream-");
  try {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.email", "t@t.t");
    git(root, "config", "user.name", "t");
    writeFileSync(`${root}/f.txt`, "v1\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "init");
    const st = acquireRemoteState(root, { mode: "apply" });
    assert.equal(st.state, "no-upstream");
    assert.equal(st.behind, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState: configured upstream survives a missing local tracking ref", () => {
  const root = tmpRoot("aios-pull-missing-local-upstream-");
  try {
    const { clone } = originAndClone(root);
    writeFileSync(`${clone}/local-only.txt`, "never pushed\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local-only work");

    // Preserve branch.main.remote/merge but remove only the local tracking ref. In this
    // state `rev-parse @{u}` fails even though the branch is still configured to track
    // origin/main — the exact state that previously collapsed to a false no-upstream.
    git(clone, "update-ref", "-d", "refs/remotes/origin/main");
    assert.equal(git(clone, "config", "--get", "branch.main.remote"), "origin");
    assert.equal(git(clone, "config", "--get", "branch.main.merge"), "refs/heads/main");
    assert.throws(() => git(clone, "rev-parse", "@{u}"));

    const readonly = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(readonly.state, "diverged", "readonly must verify origin, not report no-upstream");
    assert.equal(readonly.upstream, "origin/main");
    assert.equal(readonly.ahead, 1);

    const apply = acquireRemoteState(clone, { mode: "apply" });
    assert.equal(apply.state, "diverged", "apply must fetch and detect the local-only commit");
    assert.equal(apply.upstream, "origin/main");
    assert.equal(apply.ahead, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState: deleted upstream branch is missing-upstream-ref in BOTH modes, never a false green", () => {
  const root = tmpRoot("aios-pull-deletedref-");
  try {
    const { origin, clone } = originAndClone(root);
    git(origin, "branch", "-m", "main", "renamed-away");

    assert.equal(acquireRemoteState(clone, { mode: "readonly" }).state, "missing-upstream-ref");
    assert.equal(acquireRemoteState(clone, { mode: "apply" }).state, "missing-upstream-ref");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState: an unreachable remote does NOT mask local divergence (offline + local-only commits is still diverged)", () => {
  const root = tmpRoot("aios-pull-offline-diverged-");
  try {
    const { clone } = originAndClone(root);
    // A local commit never pushed anywhere — real divergence regardless of network state.
    writeFileSync(`${clone}/local-only.txt`, "never pushed\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local-only work");
    // Break the remote so both ls-remote (readonly) and fetch (apply) fail.
    git(clone, "remote", "set-url", "origin", `${root}/does-not-exist`);

    // Must NOT collapse to "unreachable" (which apply is allowed to vendor from) — the
    // stale local tracking ref still proves this checkout has unpublished local commits,
    // which must hard-block regardless of whether the remote itself is reachable.
    const ro = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(ro.state, "diverged", "offline + local-only commits must still read as diverged");
    assert.equal(ro.ahead, 1);

    const apply = acquireRemoteState(clone, { mode: "apply" });
    assert.equal(apply.state, "diverged", "apply mode must reach the same verdict");
    assert.equal(apply.ahead, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState: an unreachable remote with NO local divergence still reads unreachable, not diverged", () => {
  const root = tmpRoot("aios-pull-offline-clean-");
  try {
    const { clone } = originAndClone(root);
    git(clone, "remote", "set-url", "origin", `${root}/does-not-exist`);

    const ro = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(ro.state, "unreachable");
    const apply = acquireRemoteState(clone, { mode: "apply" });
    assert.equal(apply.state, "unreachable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState: same-named TAG never substitutes for the tracked branch (no false green)", () => {
  const root = tmpRoot("aios-pull-tagfallback-");
  try {
    mkdirSync(`${root}/origin`, { recursive: true });
    git(`${root}/origin`, "init", "-q", "-b", "release");
    git(`${root}/origin`, "config", "user.email", "t@t.t");
    git(`${root}/origin`, "config", "user.name", "t");
    writeFileSync(`${root}/origin/f.txt`, "base\n");
    git(`${root}/origin`, "add", "-A");
    git(`${root}/origin`, "commit", "-qm", "base");
    execFileSync("git", ["clone", "-q", "-b", "release", `${root}/origin`, `${root}/clone`]);
    // Tag "release" at the current commit, THEN delete the "release" BRANCH entirely (after
    // switching off it) — leaves refs/tags/release but no refs/heads/release at all, the
    // exact ambiguity that used to fall back to the tag's sha and read "current".
    git(`${root}/origin`, "tag", "release");
    git(`${root}/origin`, "checkout", "-q", "-b", "other");
    git(`${root}/origin`, "branch", "-D", "release");
    assert.equal(
      git(`${root}/origin`, "for-each-ref", "refs/heads/release").length,
      0,
      "fixture sanity: no refs/heads/release on the remote, only the tag"
    );

    const roSt = acquireRemoteState(`${root}/clone`, { mode: "readonly" });
    assert.equal(roSt.state, "missing-upstream-ref", "must NOT substitute the tag's sha");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sourceCleanliness: clean/dirty are tri-state, not boolean — fail-closed on a real git failure", () => {
  const root = tmpRoot("aios-pull-clean-");
  try {
    const { clone } = originAndClone(root);
    assert.equal(sourceCleanliness(clone), "clean");
    writeFileSync(`${clone}/f.txt`, "local edit\n");
    assert.equal(sourceCleanliness(clone), "dirty");
    // A path that isn't a git repo at all → git itself fails → "inspection-error", NOT "clean".
    const notARepo = `${root}/not-a-repo`;
    mkdirSync(notARepo, { recursive: true });
    assert.equal(sourceCleanliness(notARepo), "inspection-error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unmergedPaths throws on a genuine git failure instead of silently returning empty", () => {
  const root = tmpRoot("aios-pull-unmerged-");
  try {
    mkdirSync(root, { recursive: true });
    assert.throws(
      () => unmergedPaths(root),
      "a non-git directory must throw, not report zero unmerged paths"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fastForward throws on a non-fast-forward (diverged local commit)", () => {
  const root = tmpRoot("aios-pull-ff-");
  try {
    const { origin, clone } = originAndClone(root);
    advance(origin, "origin-side\n");
    writeFileSync(`${clone}/g.txt`, "local-side\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local");
    git(clone, "fetch", "--quiet");

    assert.throws(() => fastForward(clone), /not possible to fast-forward|Not possible/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createPinnedSnapshot: an immutable, complete checkout at the exact sha, unaffected by later mutation", () => {
  const root = tmpRoot("aios-pull-snapshot-");
  try {
    const { clone } = originAndClone(root);
    const sha = git(clone, "rev-parse", "HEAD");
    const snapshotDir = createPinnedSnapshot(clone, sha);
    try {
      assert.ok(existsSync(`${snapshotDir}/f.txt`));
      // Mutate the SOURCE after snapshotting — the snapshot must not see it.
      writeFileSync(`${clone}/f.txt`, "mutated after snapshot\n");
      assert.equal(
        readFileSync(`${snapshotDir}/f.txt`, "utf8"),
        "v1\n",
        "snapshot content is frozen at the pinned sha, independent of later source mutation"
      );
    } finally {
      removePinnedSnapshot(clone, snapshotDir);
    }
    assert.ok(!existsSync(snapshotDir), "snapshot directory removed");
    assert.doesNotMatch(
      git(clone, "worktree", "list"),
      new RegExp(snapshotDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "snapshot worktree deregistered from the source repo"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("createPinnedSnapshot does not trigger the source repo's own git hooks", () => {
  const root = tmpRoot("aios-pull-nohooks-");
  try {
    const { clone } = originAndClone(root);
    const hookMarker = `${root}/hook-ran`;
    mkdirSync(`${clone}/.git/hooks`, { recursive: true });
    writeFileSync(
      `${clone}/.git/hooks/post-checkout`,
      `#!/bin/sh\ntouch ${JSON.stringify(hookMarker).slice(1, -1)}\n`
    );
    execFileSync("chmod", ["+x", `${clone}/.git/hooks/post-checkout`]);
    const sha = git(clone, "rev-parse", "HEAD");
    const snapshotDir = createPinnedSnapshot(clone, sha);
    assert.ok(
      !existsSync(hookMarker),
      "post-checkout hook must NOT fire for an internal vendor snapshot"
    );
    removePinnedSnapshot(clone, snapshotDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
