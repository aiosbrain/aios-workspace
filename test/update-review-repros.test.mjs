import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import { pullToolkitCheckout, remoteStatus } from "../scripts/toolkit-pull.mjs";
import { conflictMarkerPaths, shouldReExecVendor } from "../scripts/update.mjs";
import { MANAGED_PATHS } from "../scripts/toolkit-manifest.mjs";

// Regressions for the eight adversarial repros in code-review-pr343.md. Each rebuilds the
// reviewer's real-repo scenario and asserts the safety property now holds.

const CLI = fileURLToPath(new URL("../scripts/aios.mjs", import.meta.url));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
const NOOP_IO = { log: () => {}, warn: () => {} };

function initRepo(dir) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
}

/** A bare-bones toolkit-shaped origin + a tracking clone of it. */
function originAndToolkitClone(root, { extraOriginFiles } = {}) {
  const origin = path.join(root, "origin");
  const clone = path.join(root, "toolkit");
  mkdirSync(path.join(origin, "scaffold"), { recursive: true });
  mkdirSync(path.join(origin, "scripts"), { recursive: true });
  initRepo(origin);
  writeFileSync(path.join(origin, "scaffold", ".keep"), "");
  writeFileSync(path.join(origin, "scripts", "aios.mjs"), "// stub entry\n");
  for (const [rel, body] of Object.entries(extraOriginFiles || {})) {
    mkdirSync(path.dirname(path.join(origin, rel)), { recursive: true });
    writeFileSync(path.join(origin, rel), body);
  }
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t.t");
  git(clone, "config", "user.name", "t");
  return { origin, clone };
}

/** Put a fake `npm` first on PATH that records each call and exits 0. Returns { ranFile, env }. */
function fakeNpm(root) {
  const bin = path.join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  const ranFile = path.join(root, "npm-ran.log");
  writeFileSync(
    path.join(bin, "npm"),
    `#!/bin/sh\necho "$@" >> ${JSON.stringify(ranFile)}\nexit 0\n`
  );
  chmodSync(path.join(bin, "npm"), 0o755);
  return { ranFile, binPath: `${bin}${path.delimiter}${process.env.PATH}` };
}

// ---- High #1: npm ci must never follow a symlinked node_modules -------------

test("apply skips npm through a SYMLINKED node_modules (never erases the shared target)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-symlink-"));
  const prevPath = process.env.PATH;
  try {
    const { clone } = originAndToolkitClone(root);
    // package-lock present so, absent the symlink guard, a reinstall would fire.
    writeFileSync(path.join(clone, "package-lock.json"), '{"lockfileVersion":3}\n');
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "lock");
    // Shared install target with a sentinel, node_modules symlinked to it (as worktrees do).
    const shared = path.join(root, "shared-node-modules");
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(shared, "SENTINEL"), "precious\n");
    symlinkSync(shared, path.join(clone, "node_modules"));

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;
    pullToolkitCheckout(clone, {}, NOOP_IO); // apply mode, behind === 0 → reconcile path

    assert.ok(!existsSync(ranFile), "npm must NOT be invoked through the symlink");
    assert.ok(existsSync(path.join(clone, "node_modules")), "the symlink survives");
    assert.ok(existsSync(path.join(shared, "SENTINEL")), "the shared target is untouched");
  } finally {
    process.env.PATH = prevPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- High #2: an already-current alternate --from still hands off ------------

test("apply --from an already-current OTHER checkout runs THAT checkout's CLI (not our stale modules)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-altfrom-"));
  try {
    const { clone } = originAndToolkitClone(root); // 0 commits behind — pulled would be 0
    const marker = path.join(root, "B-RAN");
    // Give B's CLI observable behavior: writing a marker when it runs the vendor phase.
    writeFileSync(
      path.join(clone, "scripts", "aios.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "B\\n");\n`
    );
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(process.execPath, [CLI, "update", "--from", clone, "--repo", workspace], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(marker), "B's CLI ran the vendor phase even though B was 0 behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- High #2 (concurrent variant): head moved since load → hand off ----------

test("shouldReExecVendor hands off for an alternate checkout AND a moved-since-load HEAD", () => {
  // Same checkout, HEAD unchanged since our modules loaded → run in-process (no hand-off, no loop).
  assert.equal(
    shouldReExecVendor({ srcReal: "/tk", srcHead: "aaa", runReal: "/tk", runHead: "aaa" }),
    false
  );
  // A DIFFERENT checkout (`--from B`), even at the same sha → hand off to B's CLI.
  assert.equal(
    shouldReExecVendor({ srcReal: "/B", srcHead: "aaa", runReal: "/tk", runHead: "aaa" }),
    true
  );
  // SAME checkout but its HEAD moved since we loaded (our own ff OR a CONCURRENT updater) →
  // hand off; our in-memory modules predate the new code. This is the un-raceable concurrent case.
  assert.equal(
    shouldReExecVendor({ srcReal: "/tk", srcHead: "bbb", runReal: "/tk", runHead: "aaa" }),
    true
  );
  // A non-git source (head unknown) on the SAME real path → run in-process, never loop.
  assert.equal(
    shouldReExecVendor({ srcReal: "/tk", srcHead: "unknown", runReal: "/tk", runHead: "aaa" }),
    false
  );
  // Review #5: a DIFFERENT checkout must hand off even when a head is unknown (a non-git
  // vendored toolkit) — the real-path difference alone is sufficient and must not be swallowed.
  assert.equal(
    shouldReExecVendor({ srcReal: "/B", srcHead: "aaa", runReal: "/tk", runHead: "unknown" }),
    true
  );
  assert.equal(
    shouldReExecVendor({ srcReal: "/B", srcHead: "unknown", runReal: "/tk", runHead: "unknown" }),
    true
  );
});

// ---- High #3: staged / hand-authored conflict markers are caught -------------

test("conflictMarkerPaths detects a marker whose index looks resolved (staged)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-marker-unit-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    assert.ok(entry, "a file-kind managed entry exists");
    const abs = path.join(root, entry.src);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "<<<<<<< ours\nmine\n=======\ntheirs\n>>>>>>> theirs\n");
    assert.deepEqual(conflictMarkerPaths(root), [entry.src]);
    // Review #9: a BARE, label-less opener (no trailing space) must still be caught.
    writeFileSync(abs, "<<<<<<<\nmine\n=======\ntheirs\n>>>>>>>\n");
    assert.deepEqual(conflictMarkerPaths(root), [entry.src]);
    // A clean file is not flagged.
    writeFileSync(abs, "resolved content\n");
    assert.deepEqual(conflictMarkerPaths(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply --no-pull refuses a source whose managed file has staged conflict markers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-marker-cli-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    // The marker lands committed (index fully clean — `--diff-filter=U` finds nothing), so only
    // a CONTENT scan can catch it. This is the staged/hand-authored case the index check misses.
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { [entry.src]: "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const destBefore = path.join(workspace, entry.dest);

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--no-pull", "--force", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.notEqual(res.status, 0, "must refuse (even with --force)");
    assert.match(res.stderr, /conflict marker/);
    assert.ok(!existsSync(destBefore), "no marker-bearing file was vendored into the workspace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- High #4: --check --contribute must not push; --dry-run must be accepted -

test("update --check --contribute is refused before any Git/gh write", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-checkcontrib-"));
  try {
    const { clone } = originAndToolkitClone(root);
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        "update",
        "--check",
        "--contribute",
        "validation/secret-patterns.txt",
        "--from",
        clone,
        "--repo",
        workspace,
      ],
      { encoding: "utf8" }
    );
    assert.notEqual(res.status, 0, "must refuse the read-only + write combination");
    assert.match(res.stderr, /cannot be combined/);
    const branches = git(clone, "branch", "--list", "contribute/*");
    assert.equal(branches, "", "no contribute branch was created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update --contribute --dry-run is a recognized flag combination (not 'unknown flag')", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-contribdry-"));
  try {
    const { clone } = originAndToolkitClone(root);
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const res = spawnSync(
      process.execPath,
      [
        CLI,
        "update",
        "--contribute",
        "validation/secret-patterns.txt",
        "--dry-run",
        "--from",
        clone,
        "--repo",
        workspace,
      ],
      { encoding: "utf8" }
    );
    assert.doesNotMatch(res.stderr, /unknown flag/, "--dry-run must pass flag validation");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Medium #1: --check must not mutate the toolkit's remote-tracking refs ----

test("update --check does not fetch (remote-tracking ref is unchanged)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-checkref-"));
  try {
    const { origin, clone } = originAndToolkitClone(root);
    const refBefore = git(clone, "rev-parse", "refs/remotes/origin/main");
    // Advance origin so a fetch WOULD move the clone's tracking ref.
    writeFileSync(path.join(origin, "n.txt"), "advance\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "advance");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    spawnSync(process.execPath, [CLI, "update", "--check", "--from", clone, "--repo", workspace], {
      encoding: "utf8",
    });
    assert.equal(
      git(clone, "rev-parse", "refs/remotes/origin/main"),
      refBefore,
      "check must not update remote-tracking refs"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Medium #2: an unreachable remote must never read green ------------------

test("update --check does not green-light when the remote is unreachable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-offline-"));
  try {
    const { clone } = originAndToolkitClone(root);
    // Break the remote so ls-remote fails; local tracking (stale) would otherwise say behind 0.
    git(clone, "remote", "set-url", "origin", path.join(root, "does-not-exist"));
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    writeFileSync(
      path.join(workspace, ".aios-toolkit-version"),
      `${git(clone, "rev-parse", "HEAD")}\ntoolkit-version 0.7.0\n`
    );
    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--check", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.doesNotMatch(res.stdout, /up to date/, "unverified remote must not read green");
    assert.match(res.stdout + res.stderr, /verif|offline|unverified/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Medium #3: an interrupted install self-heals on the next run ------------

test("apply reconciles deps when behind===0 but the recorded install is stale (interrupted pull)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-interrupted-"));
  const prevPath = process.env.PATH;
  try {
    const { clone } = originAndToolkitClone(root);
    writeFileSync(path.join(clone, "package-lock.json"), '{"lockfileVersion":3,"v":1}\n');
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "lock");
    // Real node_modules dir present but no install marker → simulates a fast-forward that
    // landed before `npm ci` ran. behind === 0, so the OLD early-return would skip deps forever.
    mkdirSync(path.join(clone, "node_modules"), { recursive: true });

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;

    const first = pullToolkitCheckout(clone, {}, NOOP_IO);
    assert.ok(existsSync(ranFile), "the stale install was repaired (npm ran)");
    assert.equal(first.installed, true);

    // Second run: the marker now matches the lockfile → no redundant reinstall.
    rmSync(ranFile, { force: true });
    const second = pullToolkitCheckout(clone, {}, NOOP_IO);
    assert.ok(!existsSync(ranFile), "a matching marker skips reinstall");
    assert.equal(second.installed, false);
  } finally {
    process.env.PATH = prevPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Review round 2 -----------------------------------------------------------

// #3 — ls-remote must match the EXACT ref, not a sibling that sorts first.
test("remoteStatus picks the tracked branch's sha, not a same-suffixed sibling", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-ambig-ref-"));
  try {
    const origin = path.join(root, "origin");
    const clone = path.join(root, "clone");
    mkdirSync(origin, { recursive: true });
    git(origin, "init", "-q", "-b", "release");
    git(origin, "config", "user.email", "t@t.t");
    git(origin, "config", "user.name", "t");
    writeFileSync(path.join(origin, "f.txt"), "base\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "base");
    execFileSync("git", ["clone", "-q", "-b", "release", origin, clone]);
    // Origin gains a sibling `hotfix/release` (sorts before `release`) at a DIFFERENT sha.
    git(origin, "checkout", "-q", "-b", "hotfix/release");
    writeFileSync(path.join(origin, "f.txt"), "hotfix\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "hotfix");
    git(origin, "checkout", "-q", "release");

    const st = remoteStatus(clone);
    const releaseSha = git(origin, "rev-parse", "release");
    // The clone is level with origin/release → behind 0, verified. If the code grabbed
    // hotfix/release's sha instead, that object isn't local and it would report behind:null.
    assert.equal(st.remoteVerified, true);
    assert.equal(st.behind, 0, "matched refs/heads/release exactly");
    assert.equal(git(clone, "rev-parse", "HEAD"), releaseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #4 — a toolkit with no upstream is "not tracking", NOT "offline"; --check can still green.
test("remoteStatus reports a no-upstream toolkit as verified/current, not offline", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-no-upstream-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    writeFileSync(path.join(dir, "f.txt"), "v1\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    const st = remoteStatus(dir);
    assert.equal(st.upstream, null);
    assert.equal(st.behind, 0);
    assert.equal(
      st.remoteVerified,
      true,
      "no upstream is a known state, not an unreachable remote"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update --check greens a no-upstream toolkit when the workspace stamp matches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-no-upstream-cli-"));
  try {
    const tk = originAndToolkitClone(root).clone;
    // Drop the upstream: a local-only toolkit that tracks nothing (not offline).
    git(tk, "branch", "--unset-upstream");
    git(tk, "remote", "remove", "origin");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    writeFileSync(
      path.join(workspace, ".aios-toolkit-version"),
      `${git(tk, "rev-parse", "HEAD")}\ntoolkit-version 0.7.0\n`
    );
    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--check", "--from", tk, "--repo", workspace],
      {
        encoding: "utf8",
      }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /up to date/, "no-upstream + matching stamp is current");
    assert.doesNotMatch(res.stdout + res.stderr, /offline/i, "must not claim offline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
