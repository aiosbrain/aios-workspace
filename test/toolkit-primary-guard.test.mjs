/**
 * toolkit-primary-guard.test.mjs — end-to-end battery for the IC cross-repo
 * Cursor guard (scaffold/.cursor/hooks/guard-toolkit-primary.sh).
 *
 * Builds a sandbox with a fake toolkit PRIMARY checkout (+ a linked worktree)
 * and a fake IC workspace, then drives the hook exactly as Cursor does: raw
 * hook JSON on stdin, CURSOR_PROJECT_DIR/AIOS_TOOLKIT_DIR in the env, exit
 * code as the verdict (0 allow, 2 block, 3 evaluation failure -> failClosed).
 *
 * Every case here is a regression test for a reviewer-found bypass on PR #431:
 * relative/symlink/deep-new-path targets, cwd-inside-primary commands,
 * redirect-masked cp destinations, archive extraction, Move/Rename destination
 * keys, and malformed-payload fail-open.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { git, initRepo } from "./toolkit-test-fixtures.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOK = path.join(REPO_ROOT, "scaffold/.cursor/hooks/guard-toolkit-primary.sh");

let sandbox; // temp root
let toolkit; // fake toolkit PRIMARY checkout
let toolkitWorktree; // linked worktree of the toolkit
let icWorkspace; // fake IC workspace (CURSOR_PROJECT_DIR)

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "tk-guard-"));

  toolkit = path.join(sandbox, "aios", "aios-workspace");
  mkdirSync(path.join(toolkit, "scripts"), { recursive: true });
  initRepo(toolkit, "main");
  writeFileSync(path.join(toolkit, "scripts", "aios.mjs"), "// marker\n");
  writeFileSync(path.join(toolkit, "CLAUDE.md"), "doc\n");
  git(toolkit, "add", "-A");
  git(toolkit, "commit", "-qm", "init");
  // the hook delegates into the toolkit's own .harness
  cpSync(path.join(REPO_ROOT, ".harness"), path.join(toolkit, ".harness"), { recursive: true });

  toolkitWorktree = path.join(sandbox, "aios", "aios-workspace-worktrees", "w");
  mkdirSync(path.dirname(toolkitWorktree), { recursive: true });
  git(toolkit, "worktree", "add", "-q", "-b", "feat/w", toolkitWorktree, "main");

  icWorkspace = path.join(sandbox, "ic");
  mkdirSync(icWorkspace, { recursive: true });
  initRepo(icWorkspace, "master");
  writeFileSync(path.join(icWorkspace, "note.md"), "hi\n");
  git(icWorkspace, "add", "-A");
  git(icWorkspace, "commit", "-qm", "init");
  symlinkSync(path.join(toolkit, "CLAUDE.md"), path.join(icWorkspace, "link-into-toolkit.md"));
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

function runHook(mode, payload, env = {}) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const res = spawnSync("/bin/sh", [HOOK, mode], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      CURSOR_PROJECT_DIR: icWorkspace,
      AIOS_TOOLKIT_DIR: toolkit,
      ...env,
    },
  });
  return res.status;
}

const editEvent = (filePath, extraToolInput = {}) => ({
  tool_name: "Write",
  tool_input: { file_path: filePath, content: "x", ...extraToolInput },
  cwd: icWorkspace,
  conversation_id: "c",
});

const cmdEvent = (command, cwd) => ({
  command,
  cwd: cwd ?? icWorkspace,
  conversation_id: "c",
});

// ── pre_edit ────────────────────────────────────────────────────────────────

test("pre_edit blocks a write into the toolkit primary", () => {
  assert.equal(runHook("pre_edit", editEvent(path.join(toolkit, "newfile.md"))), 2);
});

test("pre_edit blocks a relative path that resolves into the toolkit", () => {
  assert.equal(runHook("pre_edit", editEvent("../aios/aios-workspace/newfile.md")), 2);
});

test("pre_edit blocks a symlink leaf pointing into the toolkit", () => {
  assert.equal(runHook("pre_edit", editEvent(path.join(icWorkspace, "link-into-toolkit.md"))), 2);
});

test("pre_edit blocks a deep not-yet-existing toolkit path", () => {
  assert.equal(runHook("pre_edit", editEvent(path.join(toolkit, "new1", "new2", "f.md"))), 2);
});

test("pre_edit blocks a Move whose DESTINATION key targets the toolkit", () => {
  // source is IC-local; only the destination reaches into the primary
  const payload = {
    tool_name: "Move",
    tool_input: {
      path: path.join(icWorkspace, "note.md"),
      destination: path.join(toolkit, "stolen.md"),
    },
    cwd: icWorkspace,
    conversation_id: "c",
  };
  assert.equal(runHook("pre_edit", payload), 2);
});

test("pre_edit blocks a Rename via an unanticipated key name", () => {
  const payload = {
    tool_name: "Rename",
    tool_input: {
      path: path.join(icWorkspace, "note.md"),
      new_path: path.join(toolkit, "renamed.md"),
    },
    cwd: icWorkspace,
    conversation_id: "c",
  };
  assert.equal(runHook("pre_edit", payload), 2);
});

test("pre_edit allows IC-local writes", () => {
  assert.equal(runHook("pre_edit", editEvent(path.join(icWorkspace, "note.md"))), 0);
});

test("pre_edit allows writes into a toolkit WORKTREE", () => {
  assert.equal(runHook("pre_edit", editEvent(path.join(toolkitWorktree, "f.md"))), 0);
});

test("pre_edit keeps the aios.yaml exemption", () => {
  assert.equal(runHook("pre_edit", editEvent(path.join(toolkit, "aios.yaml"))), 0);
});

// ── pre_command ─────────────────────────────────────────────────────────────

test("pre_command allows pathless IC-local commands", () => {
  assert.equal(runHook("pre_command", cmdEvent("git status")), 0);
});

test("pre_command allows IC-local redirects", () => {
  assert.equal(runHook("pre_command", cmdEvent("echo hi > local.txt")), 0);
});

test("pre_command blocks a redirect into the toolkit (absolute)", () => {
  assert.equal(runHook("pre_command", cmdEvent(`echo x > ${toolkit}/f.txt`)), 2);
});

test("pre_command blocks a redirect into the toolkit (relative)", () => {
  assert.equal(runHook("pre_command", cmdEvent("echo x > ../aios/aios-workspace/f.txt")), 2);
});

test("pre_command blocks a cp destination hidden by a trailing redirect", () => {
  assert.equal(runHook("pre_command", cmdEvent(`cp /tmp/src ${toolkit}/f.txt >/tmp/cp.log`)), 2);
});

test("pre_command blocks mkdir -p of a deep new toolkit path", () => {
  assert.equal(runHook("pre_command", cmdEvent(`mkdir -p ${toolkit}/new1/new2`)), 2);
});

test("pre_command blocks tar extraction into the toolkit primary", () => {
  assert.equal(runHook("pre_command", cmdEvent(`tar -C ${toolkit} -xf /tmp/a.tar`)), 2);
});

test("pre_command blocks unzip -d into the toolkit primary", () => {
  assert.equal(runHook("pre_command", cmdEvent(`unzip /tmp/a.zip -d ${toolkit}`)), 2);
});

test("pre_command allows tar CREATE reading from the toolkit", () => {
  assert.equal(runHook("pre_command", cmdEvent(`tar -cf /tmp/b.tar -C ${toolkit} CLAUDE.md`)), 0);
});

test("pre_command blocks branch creation via relative cd into the toolkit", () => {
  assert.equal(
    runHook("pre_command", cmdEvent("cd ../aios/aios-workspace && git checkout -b feat/x")),
    2
  );
});

test("pre_command blocks a commit when cwd IS the toolkit primary", () => {
  assert.equal(runHook("pre_command", cmdEvent("git commit -m x", toolkit)), 2);
});

test("pre_command blocks a destructive reset when cwd IS the toolkit primary", () => {
  assert.equal(runHook("pre_command", cmdEvent("git reset --hard HEAD~1", toolkit)), 2);
});

test("pre_command allows commits in a toolkit worktree cwd", () => {
  assert.equal(runHook("pre_command", cmdEvent("git commit -m x", toolkitWorktree)), 0);
});

test("pre_command allows read-only access to toolkit files", () => {
  assert.equal(runHook("pre_command", cmdEvent(`cat ${toolkit}/CLAUDE.md`)), 0);
});

// ── failure modes ───────────────────────────────────────────────────────────

test("malformed JSON fails closed (exit 3) for pre_edit", () => {
  assert.equal(runHook("pre_edit", "not-json"), 3);
});

test("malformed JSON fails closed (exit 3) for pre_command", () => {
  assert.equal(runHook("pre_command", '{"command": bad'), 3);
});

test("broken AIOS_TOOLKIT_DIR fails closed (exit 2)", () => {
  assert.equal(
    runHook("pre_edit", editEvent(path.join(icWorkspace, "note.md")), {
      AIOS_TOOLKIT_DIR: path.join(sandbox, "nope"),
    }),
    2
  );
});

test("HARNESS_ALLOW_PRIMARY_CHECKOUT=1 overrides", () => {
  assert.equal(
    runHook("pre_edit", editEvent(path.join(toolkit, "newfile.md")), {
      HARNESS_ALLOW_PRIMARY_CHECKOUT: "1",
    }),
    0
  );
});
