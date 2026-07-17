import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { isDirty, trackingStatus, fetchToolkit, fastForward } from "../scripts/toolkit-pull.mjs";

// toolkit-pull.mjs is the git half of `aios update` — bring a toolkit checkout current
// before re-vendoring from it. These tests exercise the fetch/behind/fast-forward math and
// the dirty-tree guard against real local repos (a source repo + a clone that tracks it) —
// no network. The re-vendor merge mechanics live in toolkit-update/toolkit-merge tests.

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();

/** A source repo with one commit, and a clone of it that tracks origin. */
function makeOriginAndClone() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-pull-"));
  const origin = path.join(root, "origin");
  const clone = path.join(root, "clone");
  mkdirSync(origin, { recursive: true });
  const init = (dir) => {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
  };
  init(origin);
  writeFileSync(path.join(origin, "f.txt"), "v1\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t.t");
  git(clone, "config", "user.name", "t");
  return { root, origin, clone };
}

/** Add a commit to the origin's checked-out branch so a clone can fetch it. */
function advanceOrigin(origin, body) {
  writeFileSync(path.join(origin, "f.txt"), body);
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "advance");
}

test("trackingStatus reports behind after the origin advances; fastForward clears it", () => {
  const { root, origin, clone } = makeOriginAndClone();
  try {
    // Fresh clone is level with origin.
    let st = trackingStatus(clone);
    assert.equal(st.upstream, "origin/main");
    assert.equal(st.behind, 0);
    assert.equal(st.ahead, 0);

    advanceOrigin(origin, "v2\n");
    fetchToolkit(clone);
    st = trackingStatus(clone);
    assert.equal(st.behind, 1, "clone is one commit behind origin/main");
    assert.equal(st.ahead, 0);

    assert.equal(fastForward(clone), true, "fast-forward moved HEAD");
    assert.equal(trackingStatus(clone).behind, 0, "now level with origin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isDirty is false on a clean tree and true with an uncommitted change", () => {
  const { root, clone } = makeOriginAndClone();
  try {
    assert.equal(isDirty(clone), false);
    writeFileSync(path.join(clone, "f.txt"), "local edit\n");
    assert.equal(isDirty(clone), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fastForward throws on a non-fast-forward (diverged local commit)", () => {
  const { root, origin, clone } = makeOriginAndClone();
  try {
    advanceOrigin(origin, "origin-side\n");
    // Local commit that isn't on origin → the branches have diverged.
    writeFileSync(path.join(clone, "g.txt"), "local-side\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local");
    fetchToolkit(clone);

    const st = trackingStatus(clone);
    assert.equal(st.behind, 1);
    assert.equal(st.ahead, 1);
    assert.throws(() => fastForward(clone), /not possible to fast-forward|Not possible/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trackingStatus reports no upstream for a branch that tracks nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-pull-noupstream-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    writeFileSync(path.join(dir, "f.txt"), "v1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const st = trackingStatus(dir);
    assert.equal(st.upstream, null);
    assert.equal(st.behind, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
