/**
 * adapter-worktree-guard.test.mjs — fixture battery proving the ACTIVE Claude Code
 * and Codex project configs (.claude/settings.json, .codex/hooks.json) invoke
 * guard-worktree.sh with strict primary-checkout policy, not just a dormant
 * template (AIO-578). Mirrors the Cursor precedent (PR #431,
 * .harness/adapters/cursor/run-strict-guard.sh) for the two runtimes whose
 * active wiring the audit found missing.
 *
 * Drives the runtime-specific `.harness/adapters/<runtime>/run-strict-guard.sh`
 * wrapper exactly as the native hook config does: raw runtime-shaped JSON on
 * stdin, exit code as the verdict (0 allow, 2 policy block, 3 evaluation
 * failure — both non-zero outcomes are "blocked" from the runtime's point of
 * view). guard-worktree.sh itself already has an exhaustive portable-policy
 * battery (.harness/evals/guards.test.sh); this file is scoped to proving the
 * two adapters' ACTIVE wiring reaches that policy with the strict env vars set,
 * not to re-deriving the policy's own edge cases.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { git, initRepo } from "./toolkit-test-fixtures.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const GUARDS = {
  "claude-code": path.join(REPO_ROOT, ".harness/adapters/claude-code/run-strict-guard.sh"),
  codex: path.join(REPO_ROOT, ".harness/adapters/codex/run-strict-guard.sh"),
};

let sandbox; // temp root
let primary; // fake primary checkout (main branch)
let worktree; // linked worktree of `primary`

before(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "adapter-wtg-"));

  primary = path.join(sandbox, "repo");
  mkdirSync(primary, { recursive: true });
  initRepo(primary, "main");
  writeFileSync(path.join(primary, "README.md"), "hi\n");
  git(primary, "add", "-A");
  git(primary, "commit", "-qm", "init");

  worktree = path.join(sandbox, "repo-worktrees", "feat");
  mkdirSync(path.dirname(worktree), { recursive: true });
  git(primary, "worktree", "add", "-q", "-b", "feat/w", worktree, "main");
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

/**
 * Run `<runtime>/run-strict-guard.sh <event> guard-worktree.sh` with `payload` on stdin.
 *
 * `HARNESS_GUARDED_ROOT` points the policy at the sandbox. guard-worktree polices exactly
 * ONE repository — the one vendoring the harness — so without this the sandbox is out of
 * scope by construction and every block-expecting case here would pass while asserting
 * nothing. The sandbox is what stands in for "the guarded repo" in these fixtures.
 */
function runGuard(runtime, event, payload, guardedRoot = sandbox) {
  const input = typeof payload === "string" ? payload : JSON.stringify(payload);
  const res = spawnSync("/bin/sh", [GUARDS[runtime], event, "guard-worktree.sh"], {
    input,
    encoding: "utf8",
    env: { ...process.env, HARNESS_GUARDED_ROOT: guardedRoot },
  });
  return res.status;
}

const claudeWrite = (filePath, cwd) => ({
  tool_name: "Write",
  tool_input: { file_path: filePath, content: "x" },
  cwd,
  session_id: "s",
});

const claudeBash = (command, cwd) => ({
  tool_name: "Bash",
  tool_input: { command },
  cwd,
  session_id: "s",
});

const codexPatch = (filePath, cwd) => ({
  tool_name: "apply_patch",
  tool_input: {
    command: `*** Begin Patch\n*** Add File: ${filePath}\n+x\n*** End Patch`,
  },
  cwd,
  session_id: "s",
});

const codexCommand = (command, cwd) => ({
  tool_name: "shell",
  tool_input: { command },
  cwd,
  session_id: "s",
});

for (const runtime of ["claude-code", "codex"]) {
  const editEvent = runtime === "codex" ? codexPatch : claudeWrite;
  const cmdEvent = runtime === "codex" ? codexCommand : claudeBash;

  test(`${runtime}: pre_edit blocks a direct write in the primary checkout (on main)`, () => {
    assert.equal(
      runGuard(runtime, "pre_edit", editEvent(path.join(primary, "newfile.md"), primary)),
      2
    );
  });

  test(`${runtime}: pre_edit allows a write inside a linked worktree`, () => {
    assert.equal(
      runGuard(runtime, "pre_edit", editEvent(path.join(worktree, "newfile.md"), worktree)),
      0
    );
  });

  test(`${runtime}: pre_command blocks shell redirection into the primary`, () => {
    assert.equal(
      runGuard(runtime, "pre_command", cmdEvent(`echo hack > ${primary}/hacked.txt`, worktree)),
      2
    );
  });

  test(`${runtime}: pre_command blocks a commit inside the primary checkout`, () => {
    assert.equal(runGuard(runtime, "pre_command", cmdEvent("git commit -m x", primary)), 2);
  });

  test(`${runtime}: pre_command allows committing inside a linked worktree`, () => {
    assert.equal(runGuard(runtime, "pre_command", cmdEvent("git commit -m x", worktree)), 0);
  });

  test(`${runtime}: pre_command allows creating a NEW sibling worktree from the primary`, () => {
    const sibling = path.join(sandbox, "repo-worktrees", "example");
    assert.equal(
      runGuard(
        runtime,
        "pre_command",
        cmdEvent(`git worktree add -b feat/example ${sibling} origin/main`, primary)
      ),
      0
    );
  });

  test(`${runtime}: a malformed event fails closed`, () => {
    const status = runGuard(runtime, "pre_edit", "not-json");
    assert.notEqual(status, 0, "malformed payload must never be treated as an allow");
  });
}

// ── active config wiring ─────────────────────────────────────────────────────
// Proves the PRODUCT REPO's own .claude/settings.json and .codex/hooks.json — not
// just the adapter template under .harness/adapters/ — actually invoke
// guard-worktree.sh, and that the pre-existing Local Bugbot Stop gate survives
// untouched alongside it (the coexistence requirement).

test("active .claude/settings.json wires guard-worktree.sh AND keeps the Bugbot Stop gate", () => {
  const settings = JSON.parse(readFileSync(path.join(REPO_ROOT, ".claude/settings.json"), "utf8"));
  const preToolUse = JSON.stringify(settings.hooks.PreToolUse);
  assert.match(preToolUse, /run-strict-guard\.sh/);
  assert.match(preToolUse, /guard-worktree\.sh/);
  assert.match(preToolUse, /"matcher":\s*"Write\|Edit\|MultiEdit"/);
  assert.match(preToolUse, /"matcher":\s*"Bash"/);

  const stop = JSON.stringify(settings.hooks.Stop);
  assert.match(stop, /run-local-bugbot-gate\.sh/);
});

test("active .codex/hooks.json wires guard-worktree.sh AND keeps the Bugbot Stop gate", () => {
  const hooks = JSON.parse(readFileSync(path.join(REPO_ROOT, ".codex/hooks.json"), "utf8"));
  const preToolUse = JSON.stringify(hooks.hooks.PreToolUse);
  assert.match(preToolUse, /run-strict-guard\.sh/);
  assert.match(preToolUse, /guard-worktree\.sh/);
  assert.match(preToolUse, /"matcher":\s*"apply_patch\|Edit\|Write"/);
  assert.match(preToolUse, /"matcher":\s*"Bash"/);

  const stop = JSON.stringify(hooks.hooks.Stop);
  assert.match(stop, /run-local-bugbot-gate\.sh/);
});

// An `Edit|Write` matcher does not fire on Codex's actual file-edit tool, which is
// `apply_patch` — the fixtures (.harness/evals/fixtures/native/codex/apply-patch.json),
// normalize.sh's `tool_name` default, and the runtime-conformance table all name it. A
// guard wired only to Edit/Write is inert on the exact path AIO-578 exists to close, so
// every Codex edit matcher is pinned here, in the active config AND in the adapter
// template that ships to every workspace.
for (const [label, rel] of [
  ["active", ".codex/hooks.json"],
  ["template", ".harness/adapters/codex/hooks.json"],
]) {
  test(`${label} Codex config matches apply_patch on every pre-edit hook`, () => {
    const hooks = JSON.parse(readFileSync(path.join(REPO_ROOT, rel), "utf8"));
    const editMatchers = Object.values(hooks.hooks)
      .flat()
      .map((entry) => entry.matcher)
      .filter((m) => typeof m === "string" && /Edit|Write/.test(m));

    assert.ok(editMatchers.length > 0, `${rel} declares no edit matcher at all`);
    for (const matcher of editMatchers) {
      assert.ok(
        matcher.split("|").includes("apply_patch"),
        `${rel}: matcher ${JSON.stringify(matcher)} never fires on Codex's apply_patch tool`
      );
    }
  });
}
