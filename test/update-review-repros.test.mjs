import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  chmodSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

import {
  pullToolkitCheckout,
  acquireRemoteState,
  removePinnedSnapshot,
  assertGitToolkitSource,
} from "../scripts/toolkit-pull.mjs";
import {
  cmdUpdate,
  conflictMarkerPaths,
  vendorSafety,
  assertDestPathSafe,
  plannedDestRels,
} from "../scripts/update.mjs";
import { MANAGED_PATHS } from "../scripts/toolkit-manifest.mjs";
import { git, initRepo, advance, originAndToolkitClone } from "./toolkit-test-fixtures.mjs";
import { UpdateError } from "../scripts/cli-common.mjs";

// Regressions for the adversarial review rounds on `aios update` (code-review-pr343.md's 8
// findings, then two further build-readiness rounds on the follow-up refactor). Each rebuilds
// the reviewer's real-repo scenario and asserts the safety property now holds.

const CLI = fileURLToPath(new URL("../scripts/aios.mjs", import.meta.url));
const UPDATE_MODULE = fileURLToPath(new URL("../scripts/update.mjs", import.meta.url));
const NOOP_IO = { log: () => {}, warn: () => {} };

/** pullToolkitCheckout's apply mode pins a snapshot in the OS tmpdir (not under the caller's
 *  temp root), so any test that calls it directly must clean it up explicitly or it leaks a
 *  git-worktree registration + temp dir across runs. */
function cleanupPullResult(dir, result) {
  if (result?.snapshotDir) removePinnedSnapshot(dir, result.snapshotDir);
}

/** Put a fake `npm` first on PATH that records each call and exits 0. Returns { ranFile, env }. */
function fakeNpm(root, { realistic = false } = {}) {
  const bin = path.join(root, "fakebin");
  mkdirSync(bin, { recursive: true });
  const ranFile = path.join(root, "npm-ran.log");
  // `realistic` mimics real npm's on-disk side effects (npm runs with cwd = the toolkit
  // dir): a lockfile-less `npm install` GENERATES package-lock.json, and every completed
  // install writes node_modules/.package-lock.json. The default stub stays side-effect-free
  // — but any test asserting marker-convergence behavior must use realistic, or it tests
  // the stub, not npm (the round-7 lesson: the plain stub masked a two-reinstall loop).
  const script = realistic
    ? `#!/bin/sh
echo "$@" >> ${JSON.stringify(ranFile)}
if [ "$1" = "install" ] && [ ! -f package-lock.json ]; then printf '{"generated":true}\\n' > package-lock.json; fi
mkdir -p node_modules
printf '{}\\n' > node_modules/.package-lock.json
exit 0
`
    : `#!/bin/sh\necho "$@" >> ${JSON.stringify(ranFile)}\nexit 0\n`;
  writeFileSync(path.join(bin, "npm"), script);
  chmodSync(path.join(bin, "npm"), 0o755);
  return { ranFile, binPath: `${bin}${path.delimiter}${process.env.PATH}` };
}

/** Put a fake `npm` first on PATH that ALWAYS fails (both `ci` and its `install` fallback). */
function failingNpm(root) {
  const bin = path.join(root, "fakebin-fail");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "npm"), `#!/bin/sh\nexit 1\n`);
  chmodSync(path.join(bin, "npm"), 0o755);
  return `${bin}${path.delimiter}${process.env.PATH}`;
}

// ---- High #1: npm ci must never follow a symlinked node_modules -------------

test("apply skips npm through a SYMLINKED node_modules (never erases the shared target)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-symlink-"));
  const prevPath = process.env.PATH;
  let result;
  try {
    // package-lock.json is seeded via extraOriginFiles (part of the shared initial commit),
    // not committed directly to the clone afterward — a commit landing in the clone but not
    // origin would make the clone genuinely "ahead" of its tracked remote, which the
    // consolidated remote-state classifier now correctly refuses to fast-forward past.
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "package-lock.json": '{"lockfileVersion":3}\n' },
    });
    const shared = path.join(root, "shared-node-modules");
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(shared, "SENTINEL"), "precious\n");
    symlinkSync(shared, path.join(clone, "node_modules"));

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;
    result = pullToolkitCheckout(clone, {}, NOOP_IO); // apply mode, current — reconcile path

    assert.ok(!existsSync(ranFile), "npm must NOT be invoked through the symlink");
    assert.ok(existsSync(path.join(clone, "node_modules")), "the symlink survives");
    assert.ok(existsSync(path.join(shared, "SENTINEL")), "the shared target is untouched");
  } finally {
    process.env.PATH = prevPath;
    cleanupPullResult(path.join(root, "toolkit"), result);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- High #2: an already-current alternate --from still hands off ------------

test("apply --from an already-current OTHER checkout runs THAT checkout's CLI (not our stale modules)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-altfrom-"));
  try {
    const marker = path.join(root, "B-RAN");
    // Give B's CLI observable behavior: writing a marker when it runs the vendor phase. Seeded
    // via extraOriginFiles (part of the ONE shared initial commit both origin and clone start
    // from), not committed to the clone afterward — a commit landing only in the clone would
    // make it genuinely "ahead" of its tracked remote, which is correctly refused as diverged.
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: {
        "scripts/aios.mjs": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "B\\n");\n`,
      },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(process.execPath, [CLI, "update", "--from", clone, "--repo", workspace], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(marker), "B's CLI ran the vendor phase even though B was already current");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    let r = conflictMarkerPaths(root);
    assert.deepEqual(r.paths, [entry.src]);
    assert.deepEqual(r.errors, []);
    // A BARE, label-less opener/closer (no trailing space) must still be caught.
    writeFileSync(abs, "<<<<<<<\nmine\n=======\ntheirs\n>>>>>>>\n");
    assert.deepEqual(conflictMarkerPaths(root).paths, [entry.src]);
    // A clean file is not flagged.
    writeFileSync(abs, "resolved content\n");
    assert.deepEqual(conflictMarkerPaths(root).paths, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflictMarkerPaths does NOT flag an isolated opener with no divider/closer (doc example)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-marker-negative-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const abs = path.join(root, entry.src);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      "Here's what a git conflict marker looks like:\n<<<<<<< HEAD\nexample only\n"
    );
    assert.deepEqual(
      conflictMarkerPaths(root).paths,
      [],
      "an opener with no divider/closer must never flag — real conflicts always have all three"
    );
    // A file with a divider-shaped line but no real opener/closer must also not flag.
    writeFileSync(abs, "=======\njust a heading divider, not a conflict\n");
    assert.deepEqual(conflictMarkerPaths(root).paths, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("conflictMarkerPaths scans SEED_IF_ABSENT files too, not just MANAGED_PATHS", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-marker-seed-"));
  try {
    const abs = path.join(root, "scaffold", "comms-config.json");
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "<<<<<<< ours\n{}\n=======\n{}\n>>>>>>> theirs\n");
    assert.deepEqual(
      conflictMarkerPaths(root).paths,
      ["scaffold/comms-config.json"],
      "a marker in a seed-only source file must be caught, same as a managed one"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply --no-pull refuses a source whose managed file has staged conflict markers", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-marker-cli-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { clone } = originAndToolkitClone(root, {
      realEntrypoint: true, // the spawned --vendor-apply-only child must actually run vendorSafety
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
    assert.equal(
      git(clone, "branch", "--list", "contribute/*"),
      "",
      "no contribute branch was created"
    );
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

test("apply reconciles deps when current but the recorded install is stale (interrupted pull)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-interrupted-"));
  const prevPath = process.env.PATH;
  let first, second;
  try {
    // As above: seed via extraOriginFiles so the clone stays level with origin (a commit
    // landing only in the clone would make it genuinely "ahead" and refused as diverged).
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "package-lock.json": '{"lockfileVersion":3,"v":1}\n' },
    });
    mkdirSync(path.join(clone, "node_modules"), { recursive: true });
    // A marker recorded for an older, since-moved lockfile — the exact shape a killed
    // `npm ci` leaves behind (the marker is only rewritten AFTER npm succeeds). A checkout
    // with NO marker at all is the pre-marker-era case, which must NOT reinstall — that's
    // covered by its own repro below.
    writeFileSync(
      path.join(clone, ".git", "aios-installed-lock"),
      "stale-hash-from-interrupted-install\n"
    );

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;

    first = pullToolkitCheckout(clone, {}, NOOP_IO);
    assert.ok(existsSync(ranFile), "the stale install was repaired (npm ran)");
    assert.equal(first.installed, true);

    rmSync(ranFile, { force: true });
    second = pullToolkitCheckout(clone, {}, NOOP_IO);
    assert.ok(!existsSync(ranFile), "a matching marker skips reinstall");
    assert.equal(second.installed, false);
  } finally {
    process.env.PATH = prevPath;
    cleanupPullResult(path.join(root, "toolkit"), first);
    cleanupPullResult(path.join(root, "toolkit"), second);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Round 2: ls-remote must match the EXACT ref, not a sibling that sorts first ----

test("acquireRemoteState picks the tracked branch's sha, not a same-suffixed sibling", () => {
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

    const st = acquireRemoteState(clone, { mode: "readonly" });
    const releaseSha = git(origin, "rev-parse", "release");
    assert.equal(st.state, "current", "matched refs/heads/release exactly");
    assert.equal(git(clone, "rev-parse", "HEAD"), releaseSha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update --check greens a no-upstream toolkit when the workspace stamp matches", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-no-upstream-cli-"));
  try {
    const tk = originAndToolkitClone(root).clone;
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

// ---- Round 3: build-readiness review on the consolidation refactor -----------

test("vendorSafety is fail-closed: a git-index failure blocks, it is not treated as 'no conflicts'", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-vendorsafety-fail-"));
  try {
    mkdirSync(root, { recursive: true }); // not a git repo at all → unmergedPaths throws
    const vs = vendorSafety(root);
    assert.equal(vs.safe, false, "an uninspectable git index must never read as safe");
    assert.ok(vs.errors.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--vendor-apply-only rejects every incompatible flag before any read/write", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-vao-allowlist-"));
  try {
    const { clone } = originAndToolkitClone(root);
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    for (const bad of ["--check", "--preview", "--dry-run", "--stash", "--no-pull"]) {
      const res = spawnSync(
        process.execPath,
        [CLI, "update", "--vendor-apply-only", bad, "--from", clone, "--repo", workspace],
        { encoding: "utf8" }
      );
      assert.notEqual(res.status, 0, `--vendor-apply-only + ${bad} must be refused`);
      assert.match(res.stderr, /accepts only --from\/--repo\/--force\/--result-file/);
      assert.ok(
        !existsSync(path.join(workspace, ".aios-toolkit-version")),
        `${bad}: nothing was vendored`
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--dry-run alone (no --contribute) is a true no-op — zero writes anywhere", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-dryrun-noop-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { [entry.src]: "content\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const before = readdirSync(workspace).sort();
    const clonedHeadBefore = git(clone, "rev-parse", "HEAD");

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--dry-run", "--no-install", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(
      readdirSync(workspace).sort(),
      before,
      "workspace directory listing unchanged"
    );
    assert.ok(!existsSync(path.join(workspace, ".aios-toolkit-version")), "no stamp written");
    assert.equal(git(clone, "rev-parse", "HEAD"), clonedHeadBefore, "toolkit source untouched");
    assert.match(res.stdout, /preview only/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sequenced check -> preview -> apply on a conflicted source: all three agree, apply never silently proceeds", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-sequenced-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { clone } = originAndToolkitClone(root, {
      realEntrypoint: true, // the apply leg spawns a real child; must actually run vendorSafety
      extraOriginFiles: { [entry.src]: "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const run = (args) =>
      spawnSync(process.execPath, [CLI, "update", ...args, "--from", clone, "--repo", workspace], {
        encoding: "utf8",
      });

    const checkRes = run(["--check"]);
    const previewRes = run(["--preview"]);
    const applyRes = run([]);

    // Note: stdout legitimately contains "toolkit up to date — main at origin/main." — that's
    // the git-level remote-status line (the LOCAL toolkit checkout is in sync with ITS
    // remote), a separate, true fact from the overall check VERDICT. Match the verdict's own
    // specific wording ("up to date — v...", not "toolkit up to date — ...") so this doesn't
    // false-fail on the legitimate sub-message.
    assert.doesNotMatch(
      checkRes.stdout,
      /(?<!toolkit )up to date — v/,
      "check must not green a conflicted source"
    );
    assert.match(checkRes.stdout, /conflict/i);
    assert.match(
      previewRes.stdout,
      /conflict/i,
      "preview must also flag it, not silently show a clean plan"
    );
    assert.notEqual(applyRes.status, 0, "apply must refuse, matching what check/preview reported");
    assert.ok(!existsSync(path.join(workspace, ".aios-toolkit-version")), "apply wrote nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an arbitrary pre-set AIOS_UPDATE_VENDOR_CHILD env value has ZERO effect on the hand-off", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-envpollution-"));
  const prevEnv = process.env.AIOS_UPDATE_VENDOR_CHILD;
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { clone } = originAndToolkitClone(root, {
      realEntrypoint: true, // the spawned child must actually vendor for this to prove anything
      extraOriginFiles: { [entry.src]: "vendored content\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    // Simulate a leaked/exported value from an unrelated debug session or CI step. The
    // structurally-non-recursive --vendor-apply-only design has no env-var guard left to
    // fool — this must vendor normally, exactly as if the var were unset.
    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--no-install", "--from", clone, "--repo", workspace],
      { encoding: "utf8", env: { ...process.env, AIOS_UPDATE_VENDOR_CHILD: "1" } }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.ok(
      existsSync(path.join(workspace, entry.dest)),
      "vendored normally despite the polluted env var"
    );
    assert.ok(existsSync(path.join(workspace, ".aios-toolkit-version")));
  } finally {
    if (prevEnv === undefined) delete process.env.AIOS_UPDATE_VENDOR_CHILD;
    else process.env.AIOS_UPDATE_VENDOR_CHILD = prevEnv;
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply --stash preserves the user's uncommitted toolkit edits AND vendors from the clean, post-pull snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-stash-lifecycle-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { origin, clone } = originAndToolkitClone(root, {
      realEntrypoint: true, // must actually vendor the post-pull, post-stash-restore content
      extraOriginFiles: { [entry.src]: "v1\n" },
    });
    // Advance origin so there's something to pull.
    writeFileSync(path.join(origin, entry.src), "v2\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "advance");
    // Uncommitted, unrelated local edit in the toolkit checkout.
    writeFileSync(path.join(clone, "my-scratch-notes.txt"), "not for vendoring\n");

    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--stash", "--no-install", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      readFileSync(path.join(clone, "my-scratch-notes.txt"), "utf8"),
      "not for vendoring\n",
      "the user's stashed edit was restored exactly"
    );
    assert.equal(
      readFileSync(path.join(workspace, entry.dest), "utf8"),
      "v2\n",
      "vendored the POST-pull content, not the pre-pull state"
    );
    assert.ok(
      !readdirSync(workspace).includes("my-scratch-notes.txt"),
      "the user's unrelated scratch file was never vendored (it isn't a managed path anyway, but confirms the snapshot excludes uncommitted state)"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply refuses a dirty --no-pull source outright (no coherent sha could represent it)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-nopull-dirty-"));
  try {
    const { clone } = originAndToolkitClone(root);
    writeFileSync(path.join(clone, "uncommitted.txt"), "oops\n");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--no-pull", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /dirty/);
    assert.ok(!existsSync(path.join(workspace, ".aios-toolkit-version")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a source mutated AFTER the pinned snapshot is taken does not affect what gets vendored", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-coherency-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { clone } = originAndToolkitClone(root, {
      realEntrypoint: true, // must actually vendor the pinned content for this to prove anything
      extraOriginFiles: { [entry.src]: "pinned content\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    // Directly exercise the library call so the mutation can land in the narrow window
    // between the pull (which pins the snapshot) and the vendor hand-off actually reading it.
    const script = `
      import { cmdUpdate } from ${JSON.stringify(UPDATE_MODULE)};
      import { writeFileSync } from "node:fs";
      const result = await cmdUpdate(${JSON.stringify(workspace)}, {}, ["--no-install", "--from", ${JSON.stringify(clone)}, "--repo", ${JSON.stringify(workspace)}]);
      console.log("RESULT_JSON:" + JSON.stringify(result));
    `;
    // Mutate the SOURCE checkout concurrently isn't reproducible deterministically in a unit
    // test without hooking internals, so this instead proves the STRUCTURAL guarantee: the
    // snapshot is a real git object independent of the source directory once created —
    // mutate the clone's working tree right after spawning and confirm the vendored content
    // still matches what was committed at spawn time, not a later edit.
    writeFileSync(path.join(clone, entry.src), "pinned content\n"); // baseline, unchanged
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(path.join(workspace, entry.dest), "utf8"), "pinned content\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Note: the "pinned snapshot is missing its CLI entrypoint" defensive check in cmdUpdate
// is not independently unit-testable through the public CLI surface — `resolveSource`
// already requires `looksLikeToolkit(--from)` (which itself checks for
// scripts/aios.mjs) to pass before a snapshot is ever pinned FROM that same validated
// checkout, so the guard exists purely as defense-in-depth for a state that can't be
// reached via a normal invocation.

// ---- Round 3 (Bugbot follow-up): buildResult's "error" mode must block, snapshots must
// never leak on a failure downstream of pinning ------------------------------------------

test("an UpdateError result (mode: error) always reports applyAllowed: false", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-error-blocks-"));
  try {
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    // A bad --from is the simplest reliable way to make cmdUpdate hit its own outer
    // UpdateError catch (resolveSource throws before any of the other signals exist).
    const script = `
      import { cmdUpdate } from ${JSON.stringify(UPDATE_MODULE)};
      const r = await cmdUpdate(${JSON.stringify(workspace)}, {}, ["--check", "--from", "/does/not/exist"]);
      console.log("RESULT_JSON:" + JSON.stringify(r));
    `;
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
    });
    const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
    const result = JSON.parse(line.slice("RESULT_JSON:".length));
    assert.equal(result.mode, "error");
    assert.equal(result.exitStatus, 1);
    assert.equal(
      result.applyAllowed,
      false,
      "an error result must never default to applyAllowed: true — onboarding relies on this to suppress the apply confirmation"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pinned snapshot is not leaked when npm fails during dependency reconciliation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-npm-leak-"));
  const prevPath = process.env.PATH;
  try {
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "package-lock.json": '{"lockfileVersion":3}\n' },
    });
    mkdirSync(path.join(clone, "node_modules"), { recursive: true }); // real dir, not symlinked
    // Stale marker → a reinstall is genuinely pending (a marker-less checkout would seed
    // the marker and skip npm instead — see the pre-marker-era repro).
    writeFileSync(path.join(clone, ".git", "aios-installed-lock"), "stale-hash\n");
    process.env.PATH = failingNpm(root);

    let threw = null;
    try {
      pullToolkitCheckout(clone, {}, NOOP_IO); // throws — nothing to clean up on the success path
    } catch (e) {
      threw = e;
    }
    assert.ok(threw, "npm failure must surface as a thrown UpdateError, not a silent success");
    assert.match(threw.message, /reconciling toolkit dependencies failed/);
    // The critical assertion: no dangling worktree registration left on the source repo.
    const worktrees = git(clone, "worktree", "list");
    assert.equal(
      worktrees.split("\n").length,
      1,
      `snapshot worktree must be cleaned up on npm failure, not leaked — got:\n${worktrees}`
    );
  } finally {
    process.env.PATH = prevPath;
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Round 4 (Bugbot follow-up): destination containment, readonly count-failure
// divergence detection, and post-stash sourceClean accuracy -------------------------------

test("assertDestPathSafe refuses a manifest dest that escapes the workspace via ../ traversal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-containment-traversal-"));
  try {
    assert.throws(
      () => assertDestPathSafe(root, "../../etc/escaped.txt"),
      /outside the workspace/,
      "a dest path escaping the repo root via .. must be refused"
    );
    // A normal, contained path must NOT throw.
    assert.doesNotThrow(() => assertDestPathSafe(root, "scripts/aios.mjs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("assertDestPathSafe refuses a manifest dest whose parent chain is a symlink escaping the workspace", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-containment-symlink-"));
  try {
    const outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
    const repo = path.join(root, "repo");
    mkdirSync(repo, { recursive: true });
    symlinkSync(outside, path.join(repo, "escape-link"));
    assert.throws(
      () => assertDestPathSafe(repo, "escape-link/payload.txt"),
      /parent path is not a real workspace directory/,
      "a symlinked parent directory must be refused, not silently followed"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply --force refuses a managed destination that is itself a symlink", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-containment-final-symlink-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { clone } = originAndToolkitClone(root, {
      realEntrypoint: true,
      extraOriginFiles: { [entry.src]: "toolkit replacement\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const outside = path.join(root, "outside-shared-file");
    writeFileSync(outside, "must survive\n");
    const dest = path.join(workspace, entry.dest);
    mkdirSync(path.dirname(dest), { recursive: true });
    symlinkSync(outside, dest);

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--no-pull", "--force", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.notEqual(res.status, 0, "a final-component symlink must block apply");
    assert.match(res.stderr, /destination is a symlink/);
    assert.equal(readFileSync(outside, "utf8"), "must survive\n", "outside target was untouched");
    assert.ok(!existsSync(path.join(workspace, ".aios-toolkit-version")), "no stamp was written");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local-checkout apply stamps the live toolkit path, not the disposable snapshot", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-stamp-live-source-"));
  try {
    const entry = MANAGED_PATHS.find((e) => e.kind !== "dir");
    const { clone } = originAndToolkitClone(root, {
      realEntrypoint: true,
      extraOriginFiles: { [entry.src]: "vendored content\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--no-pull", "--force", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, res.stderr);
    const stamp = readFileSync(path.join(workspace, ".aios-toolkit-version"), "utf8");
    assert.match(
      stamp,
      new RegExp(`^source ${clone.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`, "m")
    );
    assert.doesNotMatch(stamp, /aios-vendor-snapshot-/, "snapshot path is removed after apply");
    assert.ok(existsSync(clone), "the stamped local source remains usable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("acquireRemoteState readonly: local-only commits are still detected as diverged even when the ls-remote sha isn't locally fetched", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-readonly-divergence-"));
  try {
    const { origin, clone } = originAndToolkitClone(root);
    // Advance origin so the remote sha the clone will discover via ls-remote is NOT locally
    // present — reproduces the "rev-list against an unfetched object fails" path.
    writeFileSync(path.join(origin, "advance.txt"), "v2\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "advance");
    // The clone ALSO has a local-only commit never pushed anywhere.
    writeFileSync(path.join(clone, "local-only.txt"), "never pushed\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local-only work");

    const st = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(
      st.state,
      "diverged",
      "must not collapse to a plain 'behind' that would leave applyAllowed true for a checkout apply will refuse"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preview reports remote divergence and blocks applyAllowed without pulling", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-preview-divergence-"));
  try {
    const { clone } = originAndToolkitClone(root);
    writeFileSync(path.join(clone, "local-only.txt"), "never pushed\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local-only work");
    const headBefore = git(clone, "rev-parse", "HEAD");

    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const result = await cmdUpdate(workspace, {}, ["--preview", "--from", clone]);
    assert.equal(result.remoteState.state, "diverged");
    assert.equal(result.applyAllowed, false, "preview must agree with apply's divergence gate");
    assert.equal(git(clone, "rev-parse", "HEAD"), headBefore, "preview must not pull or reset");
    assert.deepEqual(readdirSync(workspace), ["aios.yaml"], "preview must not write the workspace");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("toolkit-self check blocks applyAllowed for a dirty checkout", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-self-check-dirty-"));
  try {
    const { clone } = originAndToolkitClone(root);
    writeFileSync(path.join(clone, "scratch.txt"), "uncommitted\n");

    const result = await cmdUpdate(clone, {}, ["--check"]);
    assert.equal(result.sourceClean, "dirty");
    assert.equal(result.applyAllowed, false, "self-check must agree with apply's dirty-tree gate");
    assert.match(result.reasons.join("\n"), /uncommitted changes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply --stash: the returned result reports sourceClean 'clean' (from the pinned snapshot), not the pre-stash 'dirty' value", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-stash-sourceclean-"));
  let result;
  try {
    const { clone } = originAndToolkitClone(root);
    writeFileSync(path.join(clone, "my-local-notes.txt"), "uncommitted\n");
    result = pullToolkitCheckout(clone, { stash: true }, NOOP_IO);
    assert.equal(
      result.sourceClean,
      "clean",
      "the pinned snapshot was taken from a clean tree — the result must reflect that, not the pre-stash dirty state"
    );
  } finally {
    cleanupPullResult(path.join(root, "toolkit"), result);
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Round 5 (code review on 2026d2b): four confirmed findings ---------------------------
// 1) pre-marker checkouts must not eat a destructive first-run `npm ci`;
// 2) offline + missing tracking ref must fail closed, not vendor;
// 3) a pre-protocol snapshot must be refused with an actionable message, not "unknown flag";
// 4) a failed vendor child must never report applyAllowed: true.

test("first apply on a pre-marker checkout seeds the install marker instead of running npm", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-premarker-"));
  const prevPath = process.env.PATH;
  let result;
  try {
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "package-lock.json": '{"lockfileVersion":3}\n' },
    });
    // A healthy install that predates marker tracking: node_modules exists, no marker.
    // `.package-lock.json` is npm's own completed-install artifact — its presence is what
    // lets the seed path trust the install (an interrupted `npm ci` never writes it).
    mkdirSync(path.join(clone, "node_modules"), { recursive: true });
    writeFileSync(path.join(clone, "node_modules", "SENTINEL"), "healthy\n");
    writeFileSync(
      path.join(clone, "node_modules", ".package-lock.json"),
      '{"lockfileVersion":3}\n'
    );

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;
    result = pullToolkitCheckout(clone, {}, NOOP_IO); // apply mode, current, lockfile unmoved

    assert.ok(
      !existsSync(ranFile),
      "npm must NOT run — `npm ci` deletes node_modules first, so offline this would destroy a working install"
    );
    assert.equal(result.installed, false);
    assert.ok(
      existsSync(path.join(clone, "node_modules", "SENTINEL")),
      "the existing install is untouched"
    );
    const marker = path.join(clone, ".git", "aios-installed-lock");
    assert.ok(
      existsSync(marker),
      "the marker is seeded so future lockfile moves reconcile normally"
    );
    assert.ok(
      readFileSync(marker, "utf8").trim().length > 0,
      "marker records the current lockfile hash"
    );
  } finally {
    process.env.PATH = prevPath;
    cleanupPullResult(path.join(root, "toolkit"), result);
    rmSync(root, { recursive: true, force: true });
  }
});

test("offline + pruned tracking ref: an indeterminate divergence estimate hard-blocks, never vendors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-pruned-ref-offline-"));
  try {
    const { origin, clone } = originAndToolkitClone(root);
    // Local-only commit the classifier can no longer see once the tracking ref is gone.
    writeFileSync(path.join(clone, "local-work.txt"), "never pushed\n");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "local-only");
    // The setup an earlier `fetch --prune` leaves behind when the upstream branch was
    // renamed/missing: config intact, refs/remotes/origin/<branch> deleted. Then offline.
    git(clone, "update-ref", "-d", "refs/remotes/origin/main");
    rmSync(origin, { recursive: true, force: true });

    const applySt = acquireRemoteState(clone, { mode: "apply", warn: () => {} });
    assert.equal(
      applySt.state,
      "local-status-error",
      "apply: 'unreachable' here would vendor a checkout whose local-only commits can't be ruled out"
    );
    const readonlySt = acquireRemoteState(clone, { mode: "readonly", warn: () => {} });
    assert.equal(readonlySt.state, "local-status-error", "readonly must agree with apply");

    assert.throws(
      () => pullToolkitCheckout(clone, {}, NOOP_IO),
      /couldn't validate the local toolkit repository state/,
      "apply must hard-refuse, exactly like any other uninspectable local state"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply from a toolkit predating the hand-off protocol fails with an actionable message, not 'unknown flag'", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-prehandoff-"));
  try {
    // A committed scripts/update.mjs that does NOT know --vendor-apply-only — the shape of
    // every real pre-protocol toolkit (test stubs without update.mjs are exempt from the probe).
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: {
        "scripts/update.mjs": "// legacy toolkit CLI — no hand-off support\n",
      },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(process.execPath, [CLI, "update", "--from", clone, "--repo", workspace], {
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, "must refuse, not spawn a child that dies on flag validation");
    assert.match(
      res.stderr,
      /predates the self-update hand-off protocol/,
      "the error must name the real problem and the fix, not echo the child's 'unknown flag'"
    );
    const worktrees = git(clone, "worktree", "list");
    assert.equal(
      worktrees.split("\n").length,
      1,
      `the pinned snapshot must be cleaned up on refusal, not leaked — got:\n${worktrees}`
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a vendor child that fails yields applyAllowed: false (never 'apply-safe' on a failed apply)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-failed-apply-"));
  try {
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: {
        // Child CLI dies before writing --result-file — the crashed-child shape.
        "scripts/aios.mjs": "process.exit(1);\n",
        // Passes the hand-off probe (names --vendor-apply-only) so the spawn really happens.
        "scripts/update.mjs": "// stub that claims --vendor-apply-only support for the probe\n",
      },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const result = await cmdUpdate(workspace, {}, ["--from", clone]);
    assert.equal(result.mode, "apply");
    assert.equal(result.exitStatus, 1);
    assert.equal(result.applied, false);
    assert.equal(
      result.applyAllowed,
      false,
      "green pre-flight signals must not make a FAILED apply read as apply-safe — programmatic callers gate on .applyAllowed"
    );
    assert.match(result.reasons.join("\n"), /vendor step failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Round 6 (fast-follows from the 2026d2b review): self-update no-op, detached HEAD,
// --no-pull --stash, catalog stamp honesty, half-configured tracking ---------------------

test("self-update: a current-but-dirty toolkit checkout is a no-op success, not a refusal", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-self-dirty-noop-"));
  try {
    const { clone } = originAndToolkitClone(root);
    writeFileSync(path.join(clone, "wip.txt"), "uncommitted work\n");

    const result = await cmdUpdate(clone, {}, []);
    assert.equal(
      result.exitStatus,
      0,
      "nothing is pulled and nothing is vendored — WIP in the checkout gates nothing"
    );
    assert.equal(readFileSync(path.join(clone, "wip.txt"), "utf8"), "uncommitted work\n");
    assert.equal(
      git(clone, "worktree", "list").split("\n").length,
      1,
      "the self-update no-op must not pin (or leak) a snapshot worktree"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("self-update: a BEHIND toolkit with a dirty tree still refuses the pull without --stash", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-self-dirty-behind-"));
  try {
    const { origin, clone } = originAndToolkitClone(root);
    writeFileSync(path.join(origin, "note.txt"), "advance\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "advance");
    writeFileSync(path.join(clone, "wip.txt"), "uncommitted work\n");

    const result = await cmdUpdate(clone, {}, []);
    assert.equal(result.mode, "error", "a real pull over a dirty tree must still be refused");
    assert.match(result.reasons.join("\n"), /dirty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached HEAD toolkit checkout is refused, never greened as no-upstream", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-detached-"));
  try {
    const { clone } = originAndToolkitClone(root);
    git(clone, "checkout", "-q", "--detach");

    const st = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(st.state, "local-status-error", "detached HEAD is not 'no-upstream'");
    assert.match(st.detail, /detached HEAD/);

    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const result = await cmdUpdate(workspace, {}, ["--check", "--from", clone]);
    assert.equal(
      result.applyAllowed,
      false,
      "a checkout pinned at an arbitrary sha must never be advertised as apply-safe"
    );
    assert.match(result.reasons.join("\n"), /detached HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--no-pull --stash: the dirty toolkit is stashed, committed state vendored, WIP restored", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-nopull-stash-"));
  try {
    const { clone } = originAndToolkitClone(root);
    writeFileSync(path.join(clone, "wip.txt"), "uncommitted\n");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const result = await cmdUpdate(workspace, {}, ["--no-pull", "--stash", "--from", clone]);
    assert.equal(result.exitStatus, 0, "the user explicitly asked for auto-stash — honor it");
    assert.equal(
      readFileSync(path.join(clone, "wip.txt"), "utf8"),
      "uncommitted\n",
      "the WIP is restored after the snapshot is pinned"
    );
    assert.equal(
      git(clone, "worktree", "list").split("\n").length,
      1,
      "no leaked snapshot worktree"
    );

    const refused = await cmdUpdate(workspace, {}, ["--no-pull", "--from", clone]);
    assert.equal(refused.mode, "error", "without --stash the dirty source is still refused");
    assert.match(refused.reasons.join("\n"), /dirty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed gen-catalog leaves the version stamp unwritten (never 'up to date' over drifted catalogs)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-catalog-fail-"));
  try {
    const { clone } = originAndToolkitClone(root, {
      realEntrypoint: true, // the child must run the REAL cmdVendorApplyOnly for this to prove anything
      extraOriginFiles: { "scripts/gen-catalog.mjs": "process.exit(1);\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const res = spawnSync(
      process.execPath,
      [CLI, "update", "--no-install", "--from", clone, "--repo", workspace],
      { encoding: "utf8" }
    );
    assert.equal(res.status, 0, res.stderr); // same reasons-not-crash model as merge conflicts
    assert.ok(
      !existsSync(path.join(workspace, ".aios-toolkit-version")),
      "an apply whose catalogs failed to regenerate must NOT be stamped — --check would report 'up to date' over drifted catalogs forever"
    );
    assert.match(res.stdout + res.stderr, /catalog/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("half-configured branch tracking is refused WITH the broken config key named", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-halfconfig-"));
  try {
    const { clone } = originAndToolkitClone(root);
    git(clone, "config", "--unset", "branch.main.merge");

    const st = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(st.state, "local-status-error", "half-configured tracking stays fail-closed");
    assert.match(st.detail, /branch\.main\.merge/, "the error must name the missing key");
    assert.match(st.detail, /set-upstream-to|unset-upstream/, "…and the one-command fix");

    assert.throws(
      () => pullToolkitCheckout(clone, {}, NOOP_IO),
      /branch\.main/,
      "the apply refusal surfaces the same actionable detail"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Round 7 (code-review-56d58d0.md): the ten verified findings -------------------------
// 1) assertDestPathSafe must throw UpdateError and refuse BEFORE any write (no partial
//    vendor, no unstructured --check crash);
// 2) a two-step preview→apply flow must be pinnable to the previewed sha;
// 3) the pinned snapshot must never leak past a failed apply (one finally owns it);
// 4) self-update with committed-ahead-only local work is a no-op success, not a refusal;
// 5) --no-pull in the toolkit checkout must report a real signal, never applyAllowed:true
//    from nothing;
// 6) --contribute must throw UpdateError, never process.exit, and never claim applyAllowed;
// 7) an interrupted pre-marker install must reinstall, not be seeded as healthy;
// 8) a lockfile-less source must converge its install marker (no reinstall loop);
// 9) a non-git toolkit source is refused up front with the real diagnosis (and never runs
//    git against an enclosing repo);
// 10) readonly classification fails closed when the divergence estimate itself fails.

test("R7-1: a symlinked managed destination refuses the whole vendor before any write", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-preflight-"));
  try {
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: {
        "scaffold/scripts/aios.mjs": "// managed shim\n",
        "hooks/team-ops-guard.sh": "#!/bin/sh\n",
      },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, "hooks"), { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    // The symlinked dest (hooks/team-ops-guard.sh) sorts AFTER scripts/aios.mjs in
    // MANAGED_PATHS — without the pre-flight, scripts/aios.mjs would already be vendored
    // by the time the per-file assert fired mid-loop.
    const outside = path.join(root, "outside-target");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(workspace, "hooks", "team-ops-guard.sh"));

    const result = await cmdUpdate(workspace, {}, [
      "--vendor-apply-only",
      "--from",
      clone,
      "--stamp-source",
      clone,
    ]);
    assert.equal(result.mode, "error", "structured error result, not a crash");
    assert.equal(result.exitStatus, 1);
    assert.equal(result.applyAllowed, false);
    assert.match(result.reasons.join("\n"), /destination is a symlink/);
    assert.ok(
      !existsSync(path.join(workspace, "scripts", "aios.mjs")),
      "no managed file was written before the refusal — all-or-nothing"
    );
    assert.equal(readFileSync(outside, "utf8"), "outside\n", "the symlink target is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-1b: read-only --check with a symlinked seed destination returns a structured error, not a crash", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-checksafe-"));
  try {
    // Ship a seed file so missingSeedPaths walks it; symlink its workspace destination.
    const { SEED_IF_ABSENT } = await import("../scripts/toolkit-manifest.mjs");
    const seedEntry = SEED_IF_ABSENT.find((e) => e.kind !== "dir");
    assert.ok(seedEntry, "a file-kind seed entry exists");
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { [seedEntry.src]: "seed body\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, path.dirname(seedEntry.dest)), { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const outside = path.join(root, "outside-seed");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(workspace, seedEntry.dest));

    // In-process: previously this THREW a plain Error out of cmdUpdate (dispatcher crash).
    const result = await cmdUpdate(workspace, {}, ["--check", "--from", clone]);
    assert.equal(result.mode, "error");
    assert.equal(result.applyAllowed, false);
    assert.match(result.reasons.join("\n"), /symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-2: --expect-src-head refuses an apply whose source moved since the preview", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-pin-"));
  try {
    const { clone } = originAndToolkitClone(root);
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const preview = await cmdUpdate(workspace, {}, ["--preview", "--from", clone]);
    assert.ok(preview.srcHead, "preview reports the sha it classified");

    // The source moves between preview and apply. (--no-pull applies localOnly — no remote
    // classification — so the pin, not a 'diverged' refusal, is what must catch this.)
    advance(clone, "moved after preview\n");

    const apply = await cmdUpdate(workspace, {}, [
      "--from",
      clone,
      "--no-pull",
      "--expect-src-head",
      preview.srcHead,
    ]);
    assert.equal(apply.mode, "error");
    assert.match(apply.reasons.join("\n"), /moved since it was previewed/);
    assert.ok(
      !existsSync(path.join(workspace, ".aios-toolkit-version")),
      "nothing was vendored or stamped"
    );
    // No snapshot worktree may survive the refusal (the finally owns the lifetime).
    const worktrees = git(clone, "worktree", "list", "--porcelain");
    assert.ok(!worktrees.includes("aios-vendor-snapshot-"), "no leaked snapshot worktree");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-3: a refused hand-off (pre-protocol source) leaves no snapshot worktree behind", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-leak-"));
  try {
    // The snapshot's own update.mjs predates the hand-off protocol (no flag string) — the
    // refusal fires AFTER the snapshot is pinned, so it exercises the cleanup finally.
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "scripts/update.mjs": "// ancient CLI, no hand-off support\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const result = await cmdUpdate(workspace, {}, ["--from", clone]);
    assert.equal(result.mode, "error");
    assert.match(result.reasons.join("\n"), /predates the self-update hand-off protocol/);
    const worktrees = git(clone, "worktree", "list", "--porcelain");
    assert.ok(
      !worktrees.includes("aios-vendor-snapshot-"),
      "the pinned snapshot was removed on the failure path"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-4: self-update with committed local work (ahead-only) is a no-op success, not a refusal", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-ahead-"));
  try {
    const { origin, clone } = originAndToolkitClone(root);
    advance(clone, "committed local work\n"); // ahead 1, behind 0 — the normal dev state
    const result = pullToolkitCheckout(clone, { selfUpdate: true, noInstall: true }, NOOP_IO);
    assert.equal(result.pulled, 0);
    assert.equal(result.snapshotDir, null, "self-update pins no snapshot");
    assert.equal(result.remoteState.state, "diverged", "the classification itself is honest");

    // Ahead AND behind still refuses — that genuinely needs a (impossible) fast-forward.
    advance(origin, "remote moved too\n");
    assert.throws(
      () => pullToolkitCheckout(clone, { selfUpdate: true, noInstall: true }, NOOP_IO),
      /not a fast-forward/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-5: --no-pull in the toolkit checkout reports real cleanliness, never allowed-from-nothing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-nopull-"));
  try {
    const { clone } = originAndToolkitClone(root);
    const clean = await cmdUpdate(clone, {}, ["--no-pull"]);
    assert.equal(clean.sourceClean, "clean", "the signal is actually evaluated now");
    assert.equal(clean.applyAllowed, true);

    writeFileSync(path.join(clone, "wip.txt"), "wip\n"); // untracked → dirty
    const dirty = await cmdUpdate(clone, {}, ["--no-pull"]);
    assert.equal(dirty.sourceClean, "dirty");
    assert.equal(dirty.applyAllowed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-6: --contribute throws UpdateError (structured result), never process.exit, never applyAllowed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-contribute-"));
  try {
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "hooks/team-ops-guard.sh": "#!/bin/sh\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, "hooks"), { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    writeFileSync(path.join(workspace, "hooks", "team-ops-guard.sh"), "#!/bin/sh\n# local edit\n");

    // Expected failure (not a managed file): previously die() killed the host process here.
    const bad = await cmdUpdate(workspace, {}, [
      "--contribute",
      "not-managed.txt",
      "--from",
      clone,
    ]);
    assert.equal(bad.mode, "error");
    assert.equal(bad.exitStatus, 1);
    assert.equal(bad.applyAllowed, false);
    assert.match(bad.reasons.join("\n"), /isn't a toolkit-managed file/);

    // Success path (--dry-run): a contribute result never advertises apply permission.
    const plan = await cmdUpdate(workspace, {}, [
      "--contribute",
      "hooks/team-ops-guard.sh",
      "--dry-run",
      "--from",
      clone,
    ]);
    assert.equal(plan.mode, "contribute");
    assert.equal(plan.exitStatus, 0);
    assert.equal(plan.applyAllowed, false, "contribute is not an apply");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-7/R8: a pre-marker node_modules WITHOUT npm's completed-install artifact is left untouched — never seeded healthy, never destructively reinstalled", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-interrupted-"));
  const prevPath = process.env.PATH;
  let result;
  try {
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "package-lock.json": '{"lockfileVersion":3}\n' },
    });
    // No .package-lock.json means UNVERIFIABLE, not broken: this shape is BOTH an
    // interrupted `npm ci` AND a healthy pnpm/yarn/bun install (none of them write npm's
    // artifact). The update must neither record it healthy (the original R7-7 bug) nor
    // destroy it (`npm ci` deletes node_modules first — offline that wipes a working
    // non-npm install unrecoverably). Envelope rule: warn, leave it alone, no marker.
    mkdirSync(path.join(clone, "node_modules"), { recursive: true });
    writeFileSync(path.join(clone, "node_modules", "HALF-INSTALLED"), "partial\n");

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;
    const warnings = [];
    result = pullToolkitCheckout(clone, {}, { log: () => {}, warn: (m) => warnings.push(m) });

    assert.ok(!existsSync(ranFile), "npm is never run against an unverifiable node_modules");
    assert.ok(
      existsSync(path.join(clone, "node_modules", "HALF-INSTALLED")),
      "the existing node_modules is left untouched"
    );
    const marker = path.join(clone, ".git", "aios-installed-lock");
    assert.ok(
      !existsSync(marker),
      "no marker — the state is re-evaluated every run, not recorded healthy"
    );
    assert.match(warnings.join("\n"), /can't verify/i, "the owner is told, with the manual fix");
  } finally {
    process.env.PATH = prevPath;
    cleanupPullResult(path.join(root, "toolkit"), result);
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-8: a lockfile-less source converges its install marker instead of reinstalling forever", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-nolock-"));
  const prevPath = process.env.PATH;
  let r1, r2;
  try {
    const { clone } = originAndToolkitClone(root); // NO package-lock.json anywhere
    mkdirSync(path.join(clone, "node_modules"), { recursive: true });
    writeFileSync(path.join(clone, "node_modules", ".package-lock.json"), "{}\n");
    // A stale marker from an earlier lockfile'd era: previously this mismatched forever
    // (the marker write was gated on a non-null lockfile hash).
    writeFileSync(path.join(clone, ".git", "aios-installed-lock"), "stale-old-hash\n");

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;
    r1 = pullToolkitCheckout(clone, {}, NOOP_IO);
    cleanupPullResult(clone, r1);
    assert.ok(existsSync(ranFile), "first run reconciles (npm install)");
    assert.match(readFileSync(ranFile, "utf8"), /install/);
    assert.equal(
      readFileSync(path.join(clone, ".git", "aios-installed-lock"), "utf8").trim(),
      "no-lockfile",
      "the marker converges on the sentinel"
    );

    rmSync(ranFile, { force: true });
    r2 = pullToolkitCheckout(clone, {}, NOOP_IO);
    assert.ok(!existsSync(ranFile), "second run skips npm — no reinstall loop");
  } finally {
    process.env.PATH = prevPath;
    cleanupPullResult(path.join(root, "toolkit"), r2);
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-9: a non-git toolkit source is refused up front with the real diagnosis", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-nongit-"));
  try {
    // Standalone non-git copy (unpacked tarball shape).
    const tarball = path.join(root, "toolkit-copy");
    mkdirSync(path.join(tarball, "scaffold"), { recursive: true });
    mkdirSync(path.join(tarball, "scripts"), { recursive: true });
    writeFileSync(path.join(tarball, "scripts", "aios.mjs"), "// entry\n");
    assert.throws(
      () => pullToolkitCheckout(tarball, { localOnly: true }, NOOP_IO),
      (e) => e instanceof UpdateError && /not a git checkout/.test(e.message),
      "honest refusal, not a misleading cleanliness error"
    );

    // The same copy nested INSIDE another repository: git ops would resolve the ENCLOSING
    // repo (previously --stash could stash that repo's unrelated WIP).
    const host = path.join(root, "host-repo");
    mkdirSync(host, { recursive: true });
    initRepo(host);
    writeFileSync(path.join(host, "unrelated.txt"), "host repo WIP\n");
    const nested = path.join(host, "toolkit-copy");
    mkdirSync(path.join(nested, "scaffold"), { recursive: true });
    mkdirSync(path.join(nested, "scripts"), { recursive: true });
    writeFileSync(path.join(nested, "scripts", "aios.mjs"), "// entry\n");
    assert.throws(
      () => pullToolkitCheckout(nested, { localOnly: true, stash: true }, NOOP_IO),
      (e) => e instanceof UpdateError && /enclosing/i.test(e.message),
      "refused before any git op could act on the enclosing repository"
    );
    assert.equal(
      readFileSync(path.join(host, "unrelated.txt"), "utf8"),
      "host repo WIP\n",
      "the enclosing repo's WIP was never stashed or touched"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R7-10: readonly classification fails closed when the stale divergence estimate itself fails", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r7-readonly-"));
  try {
    const { origin, clone } = originAndToolkitClone(root);
    advance(origin, "remote moved\n"); // remote sha exists but is NOT fetched locally
    git(clone, "update-ref", "-d", "refs/remotes/origin/main"); // pruned tracking ref
    const rs = acquireRemoteState(clone, { mode: "readonly" });
    assert.equal(
      rs.state,
      "local-status-error",
      "previously a plain 'behind' — applyAllowed:true, then apply refused as diverged after the user confirmed"
    );
    assert.match(rs.detail, /tracking ref is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Round 8 (post-#361 delta review): envelope choke point + all-or-nothing closure ----
// The round-8 rule change: the supported source envelope (docs/design-self-update.md) is
// enforced at ONE choke point (resolveSource), invariants live on shared enumerations
// (plannedDestRels/deletionCandidates, REMOTE_APPLY_ALLOW_STATES), and the update never
// destroys what it can't verify (the non-npm node_modules rule, tested in R7-7/R8 above).

test("R8-1: --contribute refuses a nested non-git source at the choke point — never touches the enclosing repo", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-contribute-"));
  try {
    // A toolkit-shaped non-git copy nested inside an unrelated repository: previously
    // --contribute's git ops (fetch/worktree/branch/push) resolved the ENCLOSING repo —
    // the exact hazard R7-9 closed for update/apply but not for contribute.
    const host = path.join(root, "host-repo");
    mkdirSync(host, { recursive: true });
    initRepo(host);
    writeFileSync(path.join(host, "unrelated.txt"), "host repo WIP\n");
    git(host, "add", "-A");
    git(host, "commit", "-qm", "host init");
    const nested = path.join(host, "toolkit-copy");
    mkdirSync(path.join(nested, "scaffold"), { recursive: true });
    mkdirSync(path.join(nested, "scripts"), { recursive: true });
    writeFileSync(path.join(nested, "scripts", "aios.mjs"), "// entry\n");

    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, "hooks"), { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    writeFileSync(path.join(workspace, "hooks", "team-ops-guard.sh"), "#!/bin/sh\n# local\n");

    const result = await cmdUpdate(workspace, {}, [
      "--contribute",
      "hooks/team-ops-guard.sh",
      "--from",
      nested,
    ]);
    assert.equal(result.mode, "error", "structured envelope refusal, not a crash");
    assert.match(result.reasons.join("\n"), /enclosing/i);
    assert.equal(
      git(host, "branch", "--list").includes("contribute"),
      false,
      "no contribute/* branch was ever created in the enclosing repo"
    );
    assert.equal(git(host, "stash", "list"), "", "nothing was ever stashed in the enclosing repo");
    assert.equal(
      readFileSync(path.join(host, "unrelated.txt"), "utf8"),
      "host repo WIP\n",
      "the enclosing repo's files are untouched"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-2: the pre-flight scan covers upstream-DELETION targets — a symlinked deletion dest refuses before any write", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-deletion-"));
  try {
    const { origin, clone } = originAndToolkitClone(root, {
      extraOriginFiles: {
        "scaffold/.claude/skills/keep.md": "v1\n",
        "scaffold/.claude/skills/doomed.md": "v1\n",
      },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    // First apply stamps the base (both skills vendored).
    const first = await cmdUpdate(workspace, {}, [
      "--vendor-apply-only",
      "--from",
      clone,
      "--stamp-source",
      clone,
    ]);
    assert.equal(first.exitStatus, 0);
    assert.ok(existsSync(path.join(workspace, ".claude/skills/doomed.md")));

    // Upstream deletes doomed.md and touches keep.md; the clone pulls it.
    rmSync(path.join(origin, "scaffold/.claude/skills/doomed.md"));
    writeFileSync(path.join(origin, "scaffold/.claude/skills/keep.md"), "v2\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "delete doomed, touch keep");
    git(clone, "pull", "-q");

    // The workspace owner replaced the doomed dest with a symlink. The deletion target is
    // absent from src by definition, so an entryFiles-only scan would pass, vendor keep.md
    // (v2), then die mid-loop in applyDeletions — the half-vendored/no-stamp state.
    const outside = path.join(root, "outside-target");
    writeFileSync(outside, "outside\n");
    rmSync(path.join(workspace, ".claude/skills/doomed.md"));
    symlinkSync(outside, path.join(workspace, ".claude/skills/doomed.md"));

    const second = await cmdUpdate(workspace, {}, [
      "--vendor-apply-only",
      "--from",
      clone,
      "--stamp-source",
      clone,
    ]);
    assert.equal(second.mode, "error", "structured refusal, not a crash");
    assert.match(second.reasons.join("\n"), /symlink/);
    assert.equal(
      readFileSync(path.join(workspace, ".claude/skills/keep.md"), "utf8"),
      "v1\n",
      "NOTHING was vendored before the refusal — all-or-nothing includes deletion targets"
    );
    assert.equal(readFileSync(outside, "utf8"), "outside\n", "the symlink target is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-3: plannedDestRels enumerates the COMPLETE write+delete set (files, sidecars, deletions)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-planned-"));
  try {
    const { origin, clone } = originAndToolkitClone(root, {
      extraOriginFiles: {
        "scaffold/.claude/skills/keep.md": "v1\n",
        "scaffold/.claude/skills/doomed.md": "v1\n",
      },
    });
    const baseSha = git(clone, "rev-parse", "HEAD");
    rmSync(path.join(origin, "scaffold/.claude/skills/doomed.md"));
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "delete doomed");
    git(clone, "pull", "-q");

    const planned = plannedDestRels(clone, baseSha);
    assert.ok(planned.includes(".claude/skills/keep.md"), "managed write");
    assert.ok(planned.includes(".claude/skills/keep.md.aios-incoming"), "conflict sidecar");
    assert.ok(planned.includes(".claude/skills/keep.md.aios-merge"), "merge sidecar");
    assert.ok(planned.includes(".claude/skills/doomed.md"), "upstream-deletion target");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-4: a lockfile-less reinstall converges after ONE install with REAL npm behavior (lockfile gets generated)", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-realnpm-"));
  const prevPath = process.env.PATH;
  let r1, r2;
  try {
    const { clone } = originAndToolkitClone(root); // NO package-lock.json anywhere
    mkdirSync(path.join(clone, "node_modules"), { recursive: true });
    writeFileSync(path.join(clone, "node_modules", ".package-lock.json"), "{}\n");
    writeFileSync(path.join(clone, ".git", "aios-installed-lock"), "stale-old-hash\n");
    // package-lock.json is generated INTO the source by npm; keep git clean about it.
    writeFileSync(path.join(clone, ".git", "info", "exclude"), "package-lock.json\n");

    // realistic: `npm install` generates package-lock.json (what real npm does) — the
    // marker must record the POST-npm state, or run 2 mismatches and reinstalls again.
    const { ranFile, binPath } = fakeNpm(root, { realistic: true });
    process.env.PATH = binPath;
    r1 = pullToolkitCheckout(clone, {}, NOOP_IO);
    cleanupPullResult(clone, r1);
    assert.ok(existsSync(ranFile), "first run reconciles (npm install)");
    assert.ok(existsSync(path.join(clone, "package-lock.json")), "npm generated a lockfile");
    const marker = readFileSync(path.join(clone, ".git", "aios-installed-lock"), "utf8").trim();
    assert.notEqual(
      marker,
      "no-lockfile",
      "the marker records the post-npm state, not the stale pre-npm key"
    );
    assert.notEqual(marker, "stale-old-hash");

    rmSync(ranFile, { force: true });
    r2 = pullToolkitCheckout(clone, {}, NOOP_IO);
    assert.ok(!existsSync(ranFile), "second run skips npm — converged after exactly ONE reinstall");
  } finally {
    process.env.PATH = prevPath;
    cleanupPullResult(path.join(root, "toolkit"), r2);
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-5: a non-git source is an envelope refusal in EVERY mode — --check included (structured, documented exception)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-envelope-"));
  try {
    const tarball = path.join(root, "toolkit-copy");
    mkdirSync(path.join(tarball, "scaffold"), { recursive: true });
    mkdirSync(path.join(tarball, "scripts"), { recursive: true });
    writeFileSync(path.join(tarball, "scripts", "aios.mjs"), "// entry\n");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const result = await cmdUpdate(workspace, {}, ["--check", "--from", tarball]);
    assert.equal(result.mode, "error", "envelope refusal is structured even under --check");
    assert.equal(result.exitStatus, 1);
    assert.equal(result.applyAllowed, false);
    assert.match(result.reasons.join("\n"), /not a git checkout/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-6: the toolkit-self branch honors --expect-src-head instead of silently ignoring it", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-selfpin-"));
  try {
    const { clone } = originAndToolkitClone(root);
    const head = git(clone, "rev-parse", "HEAD");

    const mismatch = await cmdUpdate(clone, {}, [
      "--no-pull",
      "--expect-src-head",
      "0000000000000000000000000000000000000000",
    ]);
    assert.equal(mismatch.mode, "error", "a stale pin refuses even on the self no-op branch");
    assert.match(mismatch.reasons.join("\n"), /doesn't match/);

    const match = await cmdUpdate(clone, {}, ["--no-pull", "--expect-src-head", head]);
    assert.equal(match.exitStatus, 0);
    assert.equal(match.srcHead, head, "toolkit-self results now carry srcHead");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-7: the scan never asserts paths the write loop won't touch — a dropped-entirely managed dir with a local symlink squatter still applies", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-droppeddir-"));
  try {
    const { origin, clone } = originAndToolkitClone(root, {
      extraOriginFiles: {
        "scaffold/.claude/skills/keep.md": "v1\n",
        "scaffold/.claude/commands/gone.md": "v1\n",
      },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const first = await cmdUpdate(workspace, {}, [
      "--vendor-apply-only",
      "--from",
      clone,
      "--stamp-source",
      clone,
    ]);
    assert.equal(first.exitStatus, 0);
    const baseSha = git(clone, "rev-parse", "HEAD");

    // Upstream drops the ENTIRE commands dir; the workspace owner replaced their copy
    // with a symlink. mergeManaged skips the whole absent entry (writes AND deletions),
    // so the scan must too — asserting that never-touched symlink would wrongly refuse
    // every other in-envelope update (the scanned-set ⊃ touched-set drift).
    rmSync(path.join(origin, "scaffold/.claude/commands"), { recursive: true });
    writeFileSync(path.join(origin, "scaffold/.claude/skills/keep.md"), "v2\n");
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "drop commands dir, touch keep");
    git(clone, "pull", "-q");

    const outside = path.join(root, "outside-target");
    writeFileSync(outside, "outside\n");
    rmSync(path.join(workspace, ".claude/commands/gone.md"));
    symlinkSync(outside, path.join(workspace, ".claude/commands/gone.md"));

    assert.ok(
      !plannedDestRels(clone, baseSha).some((p) => p.startsWith(".claude/commands/")),
      "no planned dest under an entry absent from the snapshot"
    );
    const second = await cmdUpdate(workspace, {}, [
      "--vendor-apply-only",
      "--from",
      clone,
      "--stamp-source",
      clone,
    ]);
    assert.equal(second.exitStatus, 0, "the apply proceeds — the symlink is never touched");
    assert.equal(
      readFileSync(path.join(workspace, ".claude/skills/keep.md"), "utf8"),
      "v2\n",
      "in-envelope updates still landed"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-8: the envelope gate holds on the toolkit-self --no-pull branch — a nested non-git copy refuses instead of no-op'ing against the enclosing repo", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-selfenvelope-"));
  try {
    const host = path.join(root, "host-repo");
    mkdirSync(host, { recursive: true });
    initRepo(host);
    writeFileSync(path.join(host, "unrelated.txt"), "host\n");
    git(host, "add", "-A");
    git(host, "commit", "-qm", "host init");
    const nested = path.join(host, "toolkit-copy");
    mkdirSync(path.join(nested, "scaffold"), { recursive: true });
    mkdirSync(path.join(nested, "scripts"), { recursive: true });
    writeFileSync(path.join(nested, "scripts", "aios.mjs"), "// entry\n");

    // Previously: exit 0, "--no-pull — nothing to re-vendor", with sourceClean/srcHead
    // silently read from the ENCLOSING repo via git -C resolution.
    const result = await cmdUpdate(nested, {}, ["--no-pull"]);
    assert.equal(result.mode, "error", "envelope refusal, not a wrong-repo no-op success");
    assert.match(result.reasons.join("\n"), /enclosing/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-9: --vendor-apply-only refuses a nested non-git source — never vendors, never stamps a FOREIGN repo's sha", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-vendorenvelope-"));
  try {
    const host = path.join(root, "host-repo");
    mkdirSync(host, { recursive: true });
    initRepo(host);
    writeFileSync(path.join(host, "unrelated.txt"), "host\n");
    git(host, "add", "-A");
    git(host, "commit", "-qm", "host init");
    const nested = path.join(host, "toolkit-copy");
    mkdirSync(path.join(nested, "scaffold", "scripts"), { recursive: true });
    mkdirSync(path.join(nested, "scripts"), { recursive: true });
    writeFileSync(path.join(nested, "scripts", "aios.mjs"), "// entry\n");
    writeFileSync(path.join(nested, "scaffold", "scripts", "aios.mjs"), "// managed shim\n");

    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    // Previously: exit 0, files vendored from the copy, and .aios-toolkit-version line 1
    // stamped with the ENCLOSING host repo's HEAD — a foreign merge base corrupting every
    // future 3-way merge. The envelope gate must hold on this entry path too.
    const result = await cmdUpdate(workspace, {}, [
      "--vendor-apply-only",
      "--from",
      nested,
      "--stamp-source",
      nested,
    ]);
    assert.equal(result.mode, "error");
    assert.match(result.reasons.join("\n"), /enclosing/i);
    assert.ok(
      !existsSync(path.join(workspace, ".aios-toolkit-version")),
      "no stamp — especially not one carrying the enclosing repo's sha"
    );
    assert.ok(
      !existsSync(path.join(workspace, "scripts", "aios.mjs")),
      "nothing was vendored from the unvetted copy"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-10: an unverifiable node_modules survives even a lockfile-moving pull — never-destroy holds unconditionally", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-lockmoved-"));
  const prevPath = process.env.PATH;
  let result;
  try {
    const { origin, clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "package-lock.json": '{"lockfileVersion":3}\n' },
    });
    // Pre-marker, non-npm-shaped node_modules (no completion artifact) …
    mkdirSync(path.join(clone, "node_modules"), { recursive: true });
    writeFileSync(path.join(clone, "node_modules", "PNPM-INSTALLED"), "healthy\n");
    // … and THIS run's pull moves the lockfile (the branch that previously skipped the
    // never-destroy rule and went straight to a destructive `npm ci`).
    writeFileSync(path.join(origin, "package-lock.json"), '{"lockfileVersion":3,"v":2}\n');
    git(origin, "add", "-A");
    git(origin, "commit", "-qm", "bump lockfile");

    const { ranFile, binPath } = fakeNpm(root);
    process.env.PATH = binPath;
    const warnings = [];
    result = pullToolkitCheckout(clone, {}, { log: () => {}, warn: (m) => warnings.push(m) });

    assert.ok(!existsSync(ranFile), "npm never runs against the unverifiable install");
    assert.ok(
      existsSync(path.join(clone, "node_modules", "PNPM-INSTALLED")),
      "the non-npm install survives the lockfile-moving pull"
    );
    assert.match(warnings.join("\n"), /can't verify/i);
  } finally {
    process.env.PATH = prevPath;
    cleanupPullResult(path.join(root, "toolkit"), result);
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-11: --expect-src-head's contract is binary — refused with read-only modes and without --no-pull, never accepted-and-ignored", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-pincontract-"));
  try {
    const { clone } = originAndToolkitClone(root);
    const head = git(clone, "rev-parse", "HEAD");
    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");

    const inCheck = await cmdUpdate(workspace, {}, [
      "--check",
      "--expect-src-head",
      head,
      "--from",
      clone,
    ]);
    assert.equal(inCheck.mode, "error", "read-only modes apply nothing to pin");
    assert.match(inCheck.reasons.join("\n"), /cannot be combined with --check/);

    const noPin = await cmdUpdate(workspace, {}, ["--expect-src-head", head, "--from", clone]);
    assert.equal(noPin.mode, "error", "a pull would move past the pinned state");
    assert.match(noPin.reasons.join("\n"), /requires --no-pull/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-12: an inherited GIT_DIR can't defeat the envelope probe (git sets it for every hook it runs)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-gitenv-"));
  const prevGitDir = process.env.GIT_DIR;
  const prevWorkTree = process.env.GIT_WORK_TREE;
  try {
    const host = path.join(root, "host-repo");
    mkdirSync(host, { recursive: true });
    initRepo(host);
    writeFileSync(path.join(host, "unrelated.txt"), "host\n");
    git(host, "add", "-A");
    git(host, "commit", "-qm", "host init");

    // A toolkit-shaped NON-git dir, standalone (not even nested).
    const copy = path.join(root, "toolkit-copy");
    mkdirSync(path.join(copy, "scaffold"), { recursive: true });
    mkdirSync(path.join(copy, "scripts"), { recursive: true });
    writeFileSync(path.join(copy, "scripts", "aios.mjs"), "// entry\n");

    // `git -C <dir>` does NOT override an inherited GIT_DIR: without scrubbing,
    // `rev-parse --show-toplevel` answers <dir> itself, so the containment probe reads
    // "this dir IS its own git toplevel" for a directory that is not a repo at all —
    // fail-OPEN, and every later git op then lands on the GIT_DIR repo.
    process.env.GIT_DIR = path.join(host, ".git");
    delete process.env.GIT_WORK_TREE;

    assert.throws(
      () => assertGitToolkitSource(copy),
      (e) => e instanceof UpdateError && /not a git checkout/.test(e.message),
      "the probe resolves from -C alone, never from an inherited git environment"
    );

    const workspace = path.join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    const result = await cmdUpdate(workspace, {}, ["--check", "--from", copy]);
    assert.equal(result.mode, "error", "end-to-end: the envelope still refuses under GIT_DIR");
    assert.match(result.reasons.join("\n"), /not a git checkout/);
  } finally {
    if (prevGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = prevGitDir;
    if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = prevWorkTree;
    rmSync(root, { recursive: true, force: true });
  }
});

test("R8-13: the vendor child is spawned with a scrubbed git env (old snapshots' unsanitized git calls can't inherit GIT_DIR)", () => {
  // The child runs the SNAPSHOT's own update.mjs, which may predate the git-env
  // hardening — scrubbing must therefore happen at the spawn boundary, not only at our
  // own call sites, or the process that actually writes the workspace + version stamp
  // resolves against the wrong repository.
  const src = readFileSync(UPDATE_MODULE, "utf8");
  const spawnCall = src.slice(src.indexOf("spawnSync(process.execPath"));
  const spawnOpts = spawnCall.slice(0, spawnCall.indexOf("});") + 3);
  assert.match(spawnOpts, /env:\s*gitEnv\(\)/, "the hand-off spawn passes a scrubbed env");
});

test("R8-14: --check/--preview run the SAME containment pre-flight as apply — no offer-then-refuse", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-r8-previewcontain-"));
  try {
    const { clone } = originAndToolkitClone(root, {
      extraOriginFiles: { "hooks/team-ops-guard.sh": "#!/bin/sh\n" },
    });
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, "hooks"), { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "owner: t\n");
    // A MANAGED (not seed) destination replaced by a symlink: previously --check/--preview
    // never ran the managed-dest containment scan, so applyAllowed came back true,
    // onboarding offered the apply, and only the apply refused — after the user confirmed.
    const outside = path.join(root, "outside-target");
    writeFileSync(outside, "outside\n");
    symlinkSync(outside, path.join(workspace, "hooks", "team-ops-guard.sh"));

    for (const mode of ["--check", "--preview"]) {
      const result = await cmdUpdate(workspace, {}, [mode, "--from", clone]);
      assert.equal(result.applyAllowed, false, `${mode} must not advertise an apply that refuses`);
      assert.match(result.reasons.join("\n"), /symlink/, `${mode} names the real blocker`);
    }
    assert.equal(readFileSync(outside, "utf8"), "outside\n", "read-only modes wrote nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
