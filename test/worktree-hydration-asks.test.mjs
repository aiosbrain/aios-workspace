// test/worktree-hydration-asks.test.mjs — end-to-end: the AIO-920 invariant
// holds through the WHOLE hydration run, asks-wire step included (AIO-1014).
//
// The PR #631 review's live repro: a worktree cut from a branch whose committed
// .claude/settings.json predates the newest capture hook came out of hydration
// DIRTY — link-worktree-env.sh correctly skipped the settings copy ("branch
// copy wins"), then invoked `aios asks wire`, which rewrote the tracked file
// with a machine-absolute toolkit path a later `git commit -am` swept into the
// feature branch. This test runs the real scripts/link-worktree-env.sh with a
// real `asks wire` behind it (a fixture-primary scripts/aios.mjs that forwards
// to THIS checkout's CLI) against throwaway git repos and asserts:
//   * the tracked settings.json survives hydration byte-for-byte, worktree clean;
//   * the staleness notice names the hook the branch is missing vs main — the
//     wanted signal, replacing the silent success-shaped skip;
//   * a branch predating the file still gets seeded (AIO-920 semantics intact).
//
// Git runs with global/system config masked, same isolation as
// test/worktree-hydration-settings.test.mjs (the sibling that pins the copy
// semantics without the asks-wire step).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HYDRATE_SCRIPT = path.join(REPO_ROOT, "scripts", "link-worktree-env.sh");
const REAL_CLI = path.join(REPO_ROOT, "scripts", "aios.mjs");
const NOTICE_SCRIPT = path.join(REPO_ROOT, "scripts", "worktree-settings-notice.mjs");

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const relHook = (basename) => ({
  hooks: [{ type: "command", command: `\${CLAUDE_PROJECT_DIR}/hooks/${basename}` }],
});
const OLD_SETTINGS =
  JSON.stringify(
    {
      hooks: {
        Notification: [relHook("asks-capture.mjs")],
        Stop: [relHook("asks-capture.mjs")],
        PostToolUse: [
          {
            matcher: "AskUserQuestion|ExitPlanMode",
            hooks: [
              { type: "command", command: "${CLAUDE_PROJECT_DIR}/hooks/decision-capture.mjs" },
            ],
          },
        ],
      },
    },
    null,
    2
  ) + "\n";
const NEW_SETTINGS = OLD_SETTINGS.replace(
  '"Notification"',
  `"UserPromptSubmit": [{"hooks":[{"type":"command","command":"\${CLAUDE_PROJECT_DIR}/hooks/asks-capture.mjs"}]}],\n    "Notification"`
);

let sandbox;
let primary;
let preSettingsSha; // main before .claude/settings.json existed
let oldSettingsSha; // main while the settings carried the OLD hook set

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "wt-hydrate-asks-"));

  // A minimal repo shaped like the toolkit: the real hydration script, a
  // scripts/aios.mjs that forwards to THIS checkout's CLI (so hydration's
  // `node $main_worktree/scripts/aios.mjs asks wire ...` runs the genuine
  // code), the real staleness-notice script, and in-tree hook stubs.
  primary = path.join(sandbox, "repo");
  mkdirSync(path.join(primary, "scripts"), { recursive: true });
  mkdirSync(path.join(primary, "hooks"), { recursive: true });
  git(primary, "init", "-q", "-b", "main");
  git(primary, "config", "user.email", "t@t.t");
  git(primary, "config", "user.name", "t");
  copyFileSync(HYDRATE_SCRIPT, path.join(primary, "scripts", "link-worktree-env.sh"));
  copyFileSync(NOTICE_SCRIPT, path.join(primary, "scripts", "worktree-settings-notice.mjs"));
  writeFileSync(
    path.join(primary, "scripts", "aios.mjs"),
    `// test stub — forwards to the real toolkit CLI\nawait import(${JSON.stringify(pathToFileURL(REAL_CLI).href)});\n`
  );
  for (const f of ["asks-capture.mjs", "decision-capture.mjs"])
    writeFileSync(path.join(primary, "hooks", f), "// stub\n");
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "init: hydration script + CLI, no settings yet");
  preSettingsSha = git(primary, "rev-parse", "HEAD");

  mkdirSync(path.join(primary, ".claude"), { recursive: true });
  writeFileSync(path.join(primary, ".claude", "settings.json"), OLD_SETTINGS);
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "settings: old hook set (no UserPromptSubmit)");
  oldSettingsSha = git(primary, "rev-parse", "HEAD");

  writeFileSync(path.join(primary, ".claude", "settings.json"), NEW_SETTINGS);
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "settings: add the UserPromptSubmit asks hook");
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function addWorktree(name, ref) {
  const dir = path.join(sandbox, "repo-worktrees", name);
  mkdirSync(path.dirname(dir), { recursive: true });
  git(primary, "worktree", "add", "-q", "-b", `feat/${name}`, dir, ref);
  return dir;
}

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

test("hydration of a stale-settings branch leaves the tracked file untouched and prints the behind-main notice", () => {
  const wt = addWorktree("stale", oldSettingsSha);
  const out = hydrate(wt);

  // The asks-wire step really ran (its failure path would also leave the file
  // untouched — don't let an error impersonate the refusal).
  assert.ok(!out.includes("asks wire: skipped"), `asks wire did not run:\n${out}`);
  assert.match(out, /aios asks wire/);

  assert.equal(
    readFileSync(settingsIn(wt), "utf8"),
    OLD_SETTINGS,
    `hydration modified the branch's committed settings.json.\noutput:\n${out}`
  );
  assert.equal(
    git(wt, "status", "--porcelain", "--", ".claude/settings.json"),
    "",
    `hydration dirtied the tracked settings.json.\noutput:\n${out}`
  );

  // The wanted mitigation: a one-line signal instead of a success-shaped skip.
  assert.match(out, /branch settings behind main/);
  assert.match(out, /UserPromptSubmit:asks-capture\.mjs/);
});

test("hydration of an up-to-date branch prints no staleness notice", () => {
  const wt = addWorktree("current", "main");
  const out = hydrate(wt);
  assert.equal(readFileSync(settingsIn(wt), "utf8"), NEW_SETTINGS);
  assert.ok(!out.includes("branch settings behind main"), `false-positive notice:\n${out}`);
});

test("hydration still seeds + wires a branch that predates settings.json entirely", () => {
  const wt = addWorktree("pre-settings", preSettingsSha);
  const out = hydrate(wt);
  const s = JSON.parse(readFileSync(settingsIn(wt), "utf8"));
  assert.ok(s.hooks?.UserPromptSubmit, "seeded settings carry the current hook set");
  assert.ok(
    !out.includes("branch settings behind main"),
    `no notice on the seed path (nothing committed to compare):\n${out}`
  );
});
