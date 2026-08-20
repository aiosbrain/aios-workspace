/**
 * worktree-hydration-settings.test.mjs — proves worktree hydration never
 * overwrites a `.claude/settings.json` that is TRACKED in the worktree's branch
 * (AIO-920). The file is committed and test-asserted
 * (test/adapter-worktree-guard.test.mjs reads it from REPO_ROOT), so hydration
 * copying the PRIMARY checkout's copy over it made guard-test results depend on
 * how current the primary happened to be — a stale primary produced a false RED
 * (observed during AIO-751), and a primary AHEAD of the branch could make a
 * genuinely broken change look green.
 *
 * Runs the real scripts/link-worktree-env.sh from THIS checkout against
 * throwaway git repos, exactly as the post-checkout hook / `aios worktree add`
 * invoke it: cwd inside the fresh worktree. Sibling to
 * adapter-worktree-guard.test.mjs, which asserts the guard wiring the settings
 * file carries.
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
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { git, initRepo } from "./toolkit-test-fixtures.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HYDRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "link-worktree-env.sh");

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
  initRepo(primary, "main");
  copyFileSync(HYDRATE_SCRIPT, path.join(primary, "scripts", "link-worktree-env.sh"));
  chmodSync(path.join(primary, "scripts", "link-worktree-env.sh"), 0o755);
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
  });
  assert.equal(res.status, 0, `hydration failed:\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

test("hydration never overwrites the branch's tracked settings.json with the primary's divergent copy", () => {
  const wt = addWorktree("tracked", "main");
  assert.equal(
    readFileSync(path.join(wt, ".claude", "settings.json"), "utf8"),
    BRANCH_SETTINGS,
    "precondition: worktree checked out its branch's committed settings.json"
  );

  // Simulate a primary that has drifted from the branch under test (ahead OR
  // behind — either direction, its working copy differs from the branch's
  // committed copy).
  writeFileSync(path.join(primary, ".claude", "settings.json"), PRIMARY_SETTINGS);

  const out = hydrate(wt);

  assert.equal(
    readFileSync(path.join(wt, ".claude", "settings.json"), "utf8"),
    BRANCH_SETTINGS,
    `worktree guard config must be the BRANCH's committed copy, independent of the primary checkout's state.\nhydration output:\n${out}`
  );

  // The primary itself is untouched either way — belt and braces.
  assert.equal(
    readFileSync(path.join(primary, ".claude", "settings.json"), "utf8"),
    PRIMARY_SETTINGS
  );
});

test("hydration still seeds settings.json on a branch that predates the file", () => {
  const wt = addWorktree("older", preSettingsSha);
  assert.ok(
    !safeRead(path.join(wt, ".claude", "settings.json")),
    "precondition: older branch has no settings.json"
  );

  writeFileSync(path.join(primary, ".claude", "settings.json"), PRIMARY_SETTINGS);
  const out = hydrate(wt);

  assert.equal(
    readFileSync(path.join(wt, ".claude", "settings.json"), "utf8"),
    PRIMARY_SETTINGS,
    `a branch with no tracked settings.json still gets the primary's copy.\nhydration output:\n${out}`
  );
});

function safeRead(p) {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
