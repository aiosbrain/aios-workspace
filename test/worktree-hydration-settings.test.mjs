/**
 * worktree-hydration-settings.test.mjs — proves worktree hydration never
 * overwrites a `.claude/settings.json` that is COMMITTED in the worktree's
 * branch (AIO-920). The file is committed and test-asserted
 * (test/adapter-worktree-guard.test.mjs reads it from REPO_ROOT), so hydration
 * copying the PRIMARY checkout's copy over it made guard-test results depend on
 * how current the primary happened to be — a stale primary produced a false RED
 * (observed during AIO-751), and a primary AHEAD of the branch could make a
 * genuinely broken change look green.
 *
 * Committed-in-HEAD semantics (not index) are pinned here too: a staged
 * deletion (`git rm --cached`) must not open the door to a primary clobber, and
 * a missing-on-disk committed copy must be restored from HEAD — not skipped —
 * or a self-heal after an agent deletes the file would leave the worktree with
 * no guard config while reporting success.
 *
 * Runs the real scripts/link-worktree-env.sh from THIS checkout against
 * throwaway git repos, exactly as the post-checkout hook / `aios worktree add`
 * invoke it: cwd inside the fresh worktree. Git runs with global/system config
 * masked (same isolation as test/helpers/worktree-self-heal-harness.mjs) so a
 * developer's `core.autocrlf`/`commit.gpgsign`/`core.hooksPath` can't skew the
 * byte-exact asserts. Sibling to adapter-worktree-guard.test.mjs, which asserts
 * the guard wiring the settings file carries.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HYDRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "link-worktree-env.sh");

// Mask the developer's global/system git config for BOTH the fixture's git
// calls and the hydration script's own — the hardened pattern from
// test/helpers/worktree-self-heal-harness.mjs.
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const BRANCH_SETTINGS = JSON.stringify({ marker: "branch-committed", hooks: {} }, null, 2) + "\n";
const PRIMARY_SETTINGS = JSON.stringify({ marker: "primary-divergent", hooks: {} }, null, 2) + "\n";

let sandbox; // temp root
let primary; // throwaway primary checkout (main)
let preSettingsSha; // main commit BEFORE .claude/settings.json existed

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "wt-hydrate-settings-"));

  // A minimal repo shaped like the toolkit: the hydration script under test is
  // committed at scripts/link-worktree-env.sh (only that — no worktree-init.mjs,
  // so hydration takes its dependency-free fallback paths), plus a tracked
  // .claude/settings.json added in a SECOND commit so an "older branch" can be
  // cut from before the file existed.
  primary = path.join(sandbox, "repo");
  mkdirSync(path.join(primary, "scripts"), { recursive: true });
  git(primary, "init", "-q", "-b", "main");
  git(primary, "config", "user.email", "t@t.t");
  git(primary, "config", "user.name", "t");
  copyFileSync(HYDRATE_SCRIPT, path.join(primary, "scripts", "link-worktree-env.sh"));
  writeFileSync(path.join(primary, "README.md"), "throwaway\n");
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "init: hydration script, no settings yet");
  preSettingsSha = git(primary, "rev-parse", "HEAD");

  mkdirSync(path.join(primary, ".claude"), { recursive: true });
  writeFileSync(path.join(primary, ".claude", "settings.json"), BRANCH_SETTINGS);
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "add tracked .claude/settings.json");
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/** `git worktree add -b <branch> <dir> <ref>` under the sandbox, returns the dir. */
function addWorktree(name, ref) {
  const dir = path.join(sandbox, "repo-worktrees", name);
  mkdirSync(path.dirname(dir), { recursive: true });
  git(primary, "worktree", "add", "-q", "-b", `feat/${name}`, dir, ref);
  return dir;
}

/** Run the committed hydration script from inside `worktreeDir`, like the hook does. */
function hydrate(worktreeDir) {
  const res = spawnSync("bash", [path.join(primary, "scripts", "link-worktree-env.sh")], {
    cwd: worktreeDir,
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(res.status, 0, `hydration failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

const settingsIn = (dir) => path.join(dir, ".claude", "settings.json");

test("hydration never overwrites the branch's committed settings.json with the primary's divergent copy", () => {
  const wt = addWorktree("tracked", "main");
  assert.equal(
    readFileSync(settingsIn(wt), "utf8"),
    BRANCH_SETTINGS,
    "precondition: worktree checked out its branch's committed settings.json"
  );

  // Simulate a primary that has drifted from the branch under test (ahead OR
  // behind — either direction, its working copy differs from the branch's
  // committed copy).
  writeFileSync(settingsIn(primary), PRIMARY_SETTINGS);

  const out = hydrate(wt);

  assert.equal(
    readFileSync(settingsIn(wt), "utf8"),
    BRANCH_SETTINGS,
    `worktree guard config must be the BRANCH's committed copy, independent of the primary checkout's state.\nhydration output:\n${out}`
  );

  // The primary itself is untouched either way — belt and braces.
  assert.equal(readFileSync(settingsIn(primary), "utf8"), PRIMARY_SETTINGS);
});

test("a committed settings.json deleted from the working tree is restored from HEAD, not skipped or primary-copied", () => {
  const wt = addWorktree("deleted-on-disk", "main");
  rmSync(settingsIn(wt));
  writeFileSync(settingsIn(primary), PRIMARY_SETTINGS);

  const out = hydrate(wt);

  assert.equal(
    readFileSync(settingsIn(wt), "utf8"),
    BRANCH_SETTINGS,
    `a missing committed copy must come back from HEAD — a bare skip leaves the worktree with NO guard config while reporting success.\nhydration output:\n${out}`
  );
});

test("a staged deletion (git rm --cached) does not let the primary clobber the on-disk branch copy", () => {
  const wt = addWorktree("staged-deletion", "main");
  git(wt, "rm", "--cached", "-q", ".claude/settings.json");
  assert.equal(
    readFileSync(settingsIn(wt), "utf8"),
    BRANCH_SETTINGS,
    "precondition: staged deletion keeps the branch content on disk"
  );
  writeFileSync(settingsIn(primary), PRIMARY_SETTINGS);

  const out = hydrate(wt);

  assert.equal(
    readFileSync(settingsIn(wt), "utf8"),
    BRANCH_SETTINGS,
    `the file is committed in HEAD; an index-only staged deletion must not re-open the primary-copy path.\nhydration output:\n${out}`
  );
});

test("hydration still seeds settings.json on a branch that predates the file", () => {
  const wt = addWorktree("older", preSettingsSha);
  assert.ok(!existsSync(settingsIn(wt)), "precondition: older branch has no settings.json");

  writeFileSync(settingsIn(primary), PRIMARY_SETTINGS);
  const out = hydrate(wt);

  assert.equal(
    readFileSync(settingsIn(wt), "utf8"),
    PRIMARY_SETTINGS,
    `a branch with no committed settings.json still gets the primary's copy.\nhydration output:\n${out}`
  );
});
