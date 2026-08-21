// test/worktree-settings-notice.test.mjs — the hydration-time settings staleness
// notice (AIO-1014, follow-up to AIO-920). Post-AIO-920 a worktree keeps its
// branch's committed .claude/settings.json, so a long-lived branch is pinned to
// its branch-point hook set: a new guard landing on main never reaches existing
// worktrees, and the hydration skip message reads as success. The notice module
// compares the branch's committed hook list against main's and prints ONE line
// naming what the branch is missing — it never rewrites the file.
//
// Unit tests exercise the pure diff/format functions directly; the integration
// tests run `runNotice` against throwaway git repos (global/system git config
// masked, same isolation as test/worktree-hydration-settings.test.mjs).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  extractHookIdentities,
  diffHookIdentities,
  formatNotice,
  runNotice,
} from "../scripts/worktree-settings-notice.mjs";

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

const settingsWith = (hooks) => JSON.stringify({ hooks }, null, 2) + "\n";
const hookGroup = (basename, matcher) => ({
  ...(matcher !== undefined ? { matcher } : {}),
  hooks: [{ type: "command", command: `\${CLAUDE_PROJECT_DIR}/hooks/${basename}` }],
});

// ── unit: extractHookIdentities ──────────────────────────────────────────────

test("extractHookIdentities lists event:script pairs, including scripts buried in compound shell commands", () => {
  const text = settingsWith({
    Notification: [hookGroup("asks-capture.mjs")],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command:
              '/bin/sh "${CLAUDE_PROJECT_DIR}/hooks/run-local-bugbot-gate.sh" claude "${CLAUDE_PROJECT_DIR}"',
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "Write|Edit",
        hooks: [
          {
            type: "command",
            command:
              'root="${CLAUDE_PROJECT_DIR}"; guard="$root/.harness/adapters/claude-code/run-strict-guard.sh"; exec "$guard" pre_edit guard-worktree.sh',
          },
        ],
      },
    ],
  });
  const ids = extractHookIdentities(text);
  assert.ok(ids.has("Notification:asks-capture.mjs"));
  assert.ok(ids.has("Stop:run-local-bugbot-gate.sh"));
  assert.ok(ids.has("PreToolUse:run-strict-guard.sh"));
  assert.ok(ids.has("PreToolUse:guard-worktree.sh"));
});

test("extractHookIdentities returns null on unparseable JSON and an empty set on a missing/odd hooks key", () => {
  assert.equal(extractHookIdentities("{ not json"), null);
  assert.equal(extractHookIdentities(JSON.stringify({})).size, 0);
  assert.equal(extractHookIdentities(JSON.stringify({ hooks: "nope" })).size, 0);
  assert.equal(extractHookIdentities(JSON.stringify({ hooks: { Stop: "nope" } })).size, 0);
});

// ── unit: diffHookIdentities ─────────────────────────────────────────────────

test("diffHookIdentities names hooks main has that the branch lacks, sorted, and nothing else", () => {
  const branch = settingsWith({ Stop: [hookGroup("asks-capture.mjs")] });
  const main = settingsWith({
    Stop: [hookGroup("asks-capture.mjs"), hookGroup("session-pulse.mjs")],
    UserPromptSubmit: [hookGroup("asks-capture.mjs")],
  });
  assert.deepEqual(diffHookIdentities(branch, main), [
    "Stop:session-pulse.mjs",
    "UserPromptSubmit:asks-capture.mjs",
  ]);
  // Extra branch-only hooks are NOT "behind" — the diff is one-directional.
  assert.deepEqual(diffHookIdentities(main, branch), []);
});

test("diffHookIdentities is empty when either side is unparseable (fail-quiet, never a false alarm)", () => {
  const ok = settingsWith({ Stop: [hookGroup("asks-capture.mjs")] });
  assert.deepEqual(diffHookIdentities("{ nope", ok), []);
  assert.deepEqual(diffHookIdentities(ok, "{ nope"), []);
});

// ── unit: formatNotice ───────────────────────────────────────────────────────

test("formatNotice is null for no drift and a single line naming the missing hooks otherwise", () => {
  assert.equal(formatNotice([]), null);
  const line = formatNotice(["Stop:session-pulse.mjs", "UserPromptSubmit:asks-capture.mjs"]);
  assert.match(line, /branch settings behind main/);
  assert.match(line, /Stop:session-pulse\.mjs/);
  assert.match(line, /UserPromptSubmit:asks-capture\.mjs/);
  assert.ok(!line.includes("\n"), "notice must be one line");
});

// ── integration: runNotice against real git worktrees ────────────────────────

const OLD_SETTINGS = settingsWith({ Notification: [hookGroup("asks-capture.mjs")] });
const NEW_SETTINGS = settingsWith({
  Notification: [hookGroup("asks-capture.mjs")],
  UserPromptSubmit: [hookGroup("asks-capture.mjs")],
});

let sandbox;
let primary;
let preSettingsSha; // main before .claude/settings.json existed
let oldSettingsSha; // main while settings had only the old hook set

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "wt-settings-notice-"));
  primary = path.join(sandbox, "repo");
  mkdirSync(primary, { recursive: true });
  git(primary, "init", "-q", "-b", "main");
  git(primary, "config", "user.email", "t@t.t");
  git(primary, "config", "user.name", "t");
  writeFileSync(path.join(primary, "README.md"), "throwaway\n");
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "init: no settings yet");
  preSettingsSha = git(primary, "rev-parse", "HEAD");

  mkdirSync(path.join(primary, ".claude"), { recursive: true });
  writeFileSync(path.join(primary, ".claude", "settings.json"), OLD_SETTINGS);
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "settings: old hook set");
  oldSettingsSha = git(primary, "rev-parse", "HEAD");

  writeFileSync(path.join(primary, ".claude", "settings.json"), NEW_SETTINGS);
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "settings: add UserPromptSubmit hook");
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

test("runNotice reports a branch whose committed settings predate a hook on main", () => {
  const wt = addWorktree("stale", oldSettingsSha);
  const notice = runNotice({ worktree: wt, env: GIT_ENV });
  assert.ok(notice, "expected a staleness notice");
  assert.match(notice, /branch settings behind main/);
  assert.match(notice, /UserPromptSubmit:asks-capture\.mjs/);
});

test("runNotice is silent when the branch's committed settings match main's hook set", () => {
  const wt = addWorktree("current", "main");
  assert.equal(runNotice({ worktree: wt, env: GIT_ENV }), null);
});

test("runNotice is silent when the branch has no committed settings at all (seed path, nothing to compare)", () => {
  const wt = addWorktree("pre-settings", preSettingsSha);
  assert.equal(runNotice({ worktree: wt, env: GIT_ENV }), null);
});

test("runNotice is silent outside a git repo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wt-notice-nogit-"));
  try {
    assert.equal(runNotice({ worktree: dir, env: GIT_ENV }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
