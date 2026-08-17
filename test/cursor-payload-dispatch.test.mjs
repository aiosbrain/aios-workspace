/**
 * cursor-payload-dispatch.test.mjs — the multi-root matrix for Cursor's hook dispatch.
 *
 * Cursor decides which repo a hook applies to differently from the other two runtimes.
 * Codex resolves `git rev-parse --show-toplevel` PER INVOCATION; Claude Code uses
 * ${CLAUDE_PROJECT_DIR}, which is correct because a Claude session is single-root by
 * construction. Cursor's ${CURSOR_PROJECT_DIR} is ONE root chosen when the WINDOW
 * opened, so in a multi-root window anchored on a repo that does not vendor this
 * harness the marker test found nothing and every guard silently did not run.
 *
 * These tests drive the LITERAL command strings out of the shipped `.cursor/hooks.json`
 * — not a copy, not a paraphrase — against a fake window anchored on repo A while the
 * payload's cwd is repo B.
 *
 * On the deliberately-not-repeated weakness: the older adapter fixture proved a branch
 * was TAKEN by creating an empty `.harness/`, so the hook exec'd a missing script and
 * returned 126, which `assert.notEqual(status, 0)` happily accepted. Every blocking
 * assertion here pins the exact exit code AND requires the guard's own diagnostic on
 * stderr, so "the guard ran and refused" cannot be confused with "the hook crashed".
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { git, initRepo } from "./toolkit-test-fixtures.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const HOOKS = JSON.parse(readFileSync(path.join(REPO_ROOT, ".cursor/hooks.json"), "utf8"));

/** The command string Cursor actually runs for the strict worktree guard on shell calls. */
const SHELL_GUARD = HOOKS.hooks.beforeShellExecution.find((h) =>
  h.command.includes("strict pre_command guard-worktree.sh")
).command;
/** The same guard on the edit path. */
const EDIT_GUARD = HOOKS.hooks.preToolUse.find((h) =>
  h.command.includes("strict pre_edit guard-worktree.sh")
).command;

let sandbox;
let anchor; // repo A — the root the fake Cursor window opened on. Never has the marker.
let toolkit; // repo B — the repo the agent is actually touching. Vendors .harness + marker.
let toolkitWorktree; // a linked worktree of B, where work is allowed
let plainRepo; // a git repo with neither marker nor harness
let nojqBin; // a PATH directory deliberately missing jq

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "cursor-dispatch-"));

  anchor = path.join(sandbox, "anchor-repo");
  mkdirSync(anchor, { recursive: true });
  initRepo(anchor, "main");
  writeFileSync(path.join(anchor, "README.md"), "anchor\n");
  git(anchor, "add", "-A");
  git(anchor, "commit", "-qm", "init");

  plainRepo = path.join(sandbox, "plain-repo");
  mkdirSync(plainRepo, { recursive: true });
  initRepo(plainRepo, "main");
  writeFileSync(path.join(plainRepo, "README.md"), "plain\n");
  git(plainRepo, "add", "-A");
  git(plainRepo, "commit", "-qm", "init");

  toolkit = path.join(sandbox, "toolkit");
  mkdirSync(path.join(toolkit, "scripts"), { recursive: true });
  initRepo(toolkit, "main");
  writeFileSync(path.join(toolkit, "README.md"), "toolkit\n");
  // The marker: the file that identifies THIS product repo and is never vendored.
  writeFileSync(path.join(toolkit, "scripts/toolkit-manifest.mjs"), "export default {};\n");
  // A real vendored harness. Copied, never symlinked: repo-scope.sh derives the guarded
  // repo from the hooks directory's own location, so a symlink would scope the guard to
  // the source checkout and the fixture would assert nothing.
  cpSync(path.join(REPO_ROOT, ".harness"), path.join(toolkit, ".harness"), { recursive: true });
  git(toolkit, "add", "-A");
  git(toolkit, "commit", "-qm", "init");

  toolkitWorktree = path.join(sandbox, "toolkit-worktrees", "feat");
  mkdirSync(path.dirname(toolkitWorktree), { recursive: true });
  git(toolkit, "worktree", "add", "-q", "-b", "feat/w", toolkitWorktree, "main");

  nojqBin = path.join(sandbox, "nojq-bin");
  mkdirSync(nojqBin, { recursive: true });
  for (const tool of ["git", "sed", "tail", "dirname", "cat", "sh", "basename", "env"]) {
    // symlinkSync happily creates a DANGLING link, so the target has to be checked
    // first — otherwise the fixture silently loses `cat` and proves nothing about jq.
    const target = ["/usr/bin", "/bin", "/opt/homebrew/bin"]
      .map((dir) => path.join(dir, tool))
      .find((candidate) => existsSync(candidate));
    assert.ok(target, `nojq PATH fixture needs ${tool}`);
    symlinkSync(target, path.join(nojqBin, tool));
  }
  assert.equal(
    spawnSync("/bin/sh", ["-c", "command -v jq"], { env: { PATH: nojqBin } }).status,
    1,
    "the nojq PATH fixture must not resolve jq"
  );
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Run a real `.cursor/hooks.json` command exactly as Cursor would: the hook process's
 * cwd and ${CURSOR_PROJECT_DIR} are the WINDOW ANCHOR, and the repo the agent is
 * touching appears only in the stdin payload.
 */
function runHook(command, { anchorDir = anchor, payload, env = {} } = {}) {
  const res = spawnSync("/bin/sh", ["-c", command], {
    cwd: anchorDir,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CURSOR_PROJECT_DIR: anchorDir, ...env },
  });
  return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

const shellPayload = (command, cwd) => ({
  hook_event_name: "beforeShellExecution",
  conversation_id: "c1",
  command,
  cwd,
});

const editPayload = (filePath, cwd) => ({
  hook_event_name: "preToolUse",
  conversation_id: "c1",
  tool_name: "Write",
  tool_input: { file_path: filePath, content: "x" },
  cwd,
});

/** A block is only proven when the exit code AND the guard's own diagnostic are right. */
function assertGuardBlocked(result, label) {
  assert.equal(result.status, 2, `${label}: expected a policy block (2), got ${result.status}`);
  assert.match(
    result.stderr,
    /BLOCKED by guard-worktree/,
    `${label}: exit 2 without the guard's diagnostic means the hook crashed, not that the guard ran`
  );
}

// ── 1. marker present + dispatcher present ───────────────────────────────────
// The defect: a window anchored on a repo without the marker never ran the guard at
// all. The payload names the toolkit, so the guard must run and refuse.

test("anchored elsewhere: a shell write into the toolkit primary is blocked", () => {
  assertGuardBlocked(
    runHook(SHELL_GUARD, { payload: shellPayload("rm -f README.md", toolkit) }),
    "shell write in toolkit primary"
  );
});

test("anchored elsewhere: an edit in the toolkit primary is blocked", () => {
  assertGuardBlocked(
    runHook(EDIT_GUARD, { payload: editPayload(path.join(toolkit, "newfile.md"), toolkit) }),
    "edit in toolkit primary"
  );
});

test("anchored elsewhere: work inside a linked worktree of the toolkit is allowed", () => {
  const res = runHook(EDIT_GUARD, {
    payload: editPayload(path.join(toolkitWorktree, "newfile.md"), toolkitWorktree),
  });
  assert.equal(res.status, 0, res.stderr);
});

test("anchored elsewhere: a read-only command in the toolkit primary is allowed", () => {
  const res = runHook(SHELL_GUARD, {
    payload: shellPayload('grep -rn "deepseek" scripts/', toolkit),
  });
  assert.equal(res.status, 0, res.stderr);
});

test("anchored ON the toolkit still enforces (no regression for single-root windows)", () => {
  assertGuardBlocked(
    runHook(SHELL_GUARD, {
      anchorDir: toolkit,
      payload: shellPayload("rm -f README.md", toolkit),
    }),
    "single-root window"
  );
});

test("a payload cwd that is not the toolkit cannot switch enforcement off", () => {
  // ${CURSOR_PROJECT_DIR} stays in the candidate list, so payload text can only ADD a
  // root. Anchored on the toolkit, a spoofed cwd elsewhere must not disable the guard.
  assertGuardBlocked(
    runHook(SHELL_GUARD, {
      anchorDir: toolkit,
      payload: shellPayload(`rm -f ${path.join(toolkit, "README.md")}`, plainRepo),
    }),
    "spoofed payload cwd"
  );
});

// ── 2. marker present + dispatcher MISSING ───────────────────────────────────
// The anti-tamper branch AIO-864 lost by accident: a deleted guard must be loud
// (exit 3 → could-not-evaluate → block), never a silent allow.

test("marker present but the dispatcher is missing fails closed with exit 3", () => {
  const dispatcher = path.join(toolkit, ".harness/adapters/cursor/dispatch.sh");
  const stashed = path.join(sandbox, "dispatch.stashed.sh");
  cpSync(dispatcher, stashed);
  rmSync(dispatcher);
  try {
    const res = runHook(SHELL_GUARD, { payload: shellPayload("rm -f README.md", toolkit) });
    assert.equal(res.status, 3, res.stderr);
    assert.match(res.stderr, /dispatch\.sh is missing/);
  } finally {
    cpSync(stashed, dispatcher);
    spawnSync("chmod", ["+x", dispatcher]);
  }
});

// ── 3. marker ABSENT ─────────────────────────────────────────────────────────

test("a repo without the marker is not policed, even while the toolkit is the anchor", () => {
  const res = runHook(SHELL_GUARD, {
    anchorDir: plainRepo,
    payload: shellPayload("rm -f README.md", plainRepo),
  });
  assert.equal(res.status, 0, res.stderr);
});

test("a repo without the marker is not policed when the anchor also lacks it", () => {
  const res = runHook(EDIT_GUARD, {
    payload: editPayload(path.join(plainRepo, "notes.md"), plainRepo),
  });
  assert.equal(res.status, 0, res.stderr);
});

// ── 4. not a git repo at all ─────────────────────────────────────────────────

test("a payload cwd outside any git repo is allowed, not an evaluation failure", () => {
  const loose = path.join(sandbox, "loose");
  mkdirSync(loose, { recursive: true });
  const res = runHook(SHELL_GUARD, {
    anchorDir: loose,
    payload: shellPayload("rm -f whatever.txt", loose),
  });
  assert.equal(res.status, 0, res.stderr);
});

test("a payload with no cwd at all falls back to the anchor rather than failing", () => {
  const res = runHook(HOOKS.hooks.stop.at(-1).command, {
    anchorDir: plainRepo,
    payload: { hook_event_name: "stop", status: "aborted", loop_count: 0 },
  });
  assert.equal(res.status, 0, res.stderr);
});

// ── 5. jq absent ─────────────────────────────────────────────────────────────
// failClosed + exit 3 turned "a CLI is missing" into a deny for every tool call in the
// session — including the command that installs jq. It must degrade loudly instead.

test("a machine without jq gets a loud allow naming jq, not a session-wide deny", () => {
  const res = runHook(SHELL_GUARD, {
    payload: shellPayload("rm -f README.md", toolkit),
    env: { PATH: nojqBin },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /\bjq\b/);
  assert.match(res.stderr, /brew install jq|apt-get install jq/);
  assert.match(res.stderr, /NOT enforcing/);
});

test("HARNESS_REQUIRE_JQ=1 restores fail-closed on a missing interpreter", () => {
  const res = runHook(SHELL_GUARD, {
    payload: shellPayload("rm -f README.md", toolkit),
    env: { PATH: nojqBin, HARNESS_REQUIRE_JQ: "1" },
  });
  assert.equal(res.status, 3, res.stderr);
  assert.match(res.stderr, /\bjq\b/);
});

// ── shipped-config shape ─────────────────────────────────────────────────────

test("every Cursor hook uses the identical payload-cwd locator and no bare anchor path", () => {
  const commands = Object.values(HOOKS.hooks)
    .flat()
    .map((entry) => entry.command);
  assert.ok(commands.length >= 9, `expected the full hook set, saw ${commands.length}`);

  const locatorOf = (command) => command.slice(0, command.lastIndexOf("' aios-cursor-hook ") + 1);
  const [first, ...rest] = commands.map(locatorOf);
  assert.ok(first.includes("rev-parse --show-toplevel"), "locator must resolve a git root");
  assert.ok(first.includes('"(cwd|file_path)"'), "locator must read the payload, not the anchor");
  for (const other of rest) {
    assert.equal(other, first, "every hook must share one reviewed locator");
  }

  for (const command of commands) {
    // The anchor survives only as the SECOND candidate inside the locator. No hook may
    // still build a script path out of it — that is the bug this file exists to close.
    assert.doesNotMatch(
      command.slice(command.lastIndexOf("' aios-cursor-hook ")),
      /CURSOR_PROJECT_DIR/,
      `hook still resolves an argument through the window anchor: ${command}`
    );
    assert.match(command, /\.harness\/adapters\/cursor\/dispatch\.sh/);
  }
});

test("the stop hook still reaches the shared Bugbot gate, with the resolved root", () => {
  // The gate path moved from hooks.json into the dispatcher, so the wiring assertion
  // moves with it: `bugbot` is the kind, and the dispatcher passes the root it resolved.
  assert.match(JSON.stringify(HOOKS.hooks.stop), /cursor\/dispatch\.sh bugbot/);
  const dispatch = readFileSync(
    path.join(REPO_ROOT, ".harness/adapters/cursor/dispatch.sh"),
    "utf8"
  );
  assert.match(dispatch, /run-local-bugbot-gate\.sh" cursor "\$ROOT"/);
});

test("the vendored Cursor template dispatches the same way for any harness repo", () => {
  const template = JSON.parse(
    readFileSync(path.join(REPO_ROOT, ".harness/adapters/cursor/hooks.json"), "utf8")
  );
  for (const entry of Object.values(template.hooks).flat()) {
    assert.match(entry.command, /rev-parse --show-toplevel/);
    assert.match(entry.command, /\.harness\/adapters\/cursor\/dispatch\.sh/);
  }
});
