// test/operator-loop/asks-wire-hydration.test.mjs — `aios asks wire` must not
// break the AIO-920 invariant from inside link-worktree-env.sh (AIO-1014).
//
// Two properties, both observed failing in the PR #631 review:
//   1. Path shape: a repo that carries the capture hooks in-tree gets
//      `${CLAUDE_PROJECT_DIR}`-relative commands (the tracked-settings
//      convention), never this machine's absolute toolkit path — an absolute
//      path swept into a tracked settings.json by `git commit -am` publishes a
//      machine-local path to the branch. The absolute-path fallback survives
//      ONLY for repos with no in-tree copy of the hooks (john-workspace).
//   2. Hydration refusal: invoked with --hydration (as link-worktree-env.sh
//      does), wire must leave a settings.json committed in the branch's HEAD
//      byte-for-byte alone — the branch copy is authoritative, and the
//      staleness notice (worktree-settings-notice.mjs) is the signal, not an
//      unasked edit that dirties the worktree.
//
// Sibling to asks-wire.test.mjs (merge + idempotency), which pins the
// no-in-tree-hooks absolute fallback; new coverage lives here per the
// new-tests-in-new-files rule.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: GIT_ENV }).trim();

function run(dir, args) {
  try {
    const stdout = execFileSync("node", [CLI, "asks", ...args, "--repo", dir], {
      cwd: dir,
      encoding: "utf8",
      env: GIT_ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const settingsPath = (dir) => path.join(dir, ".claude", "settings.json");

/** Drop stub copies of the capture hooks at <dir>/hooks/ — the in-tree layout. */
function seedInTreeHooks(dir) {
  mkdirSync(path.join(dir, "hooks"), { recursive: true });
  for (const f of ["asks-capture.mjs", "decision-capture.mjs"])
    writeFileSync(path.join(dir, "hooks", f), "// stub\n");
}

/** A git repo whose HEAD commits a settings.json missing the UserPromptSubmit hook. */
function repoWithTrackedPartialSettings() {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-tracked-"));
  seedInTreeHooks(dir);
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  const partial =
    JSON.stringify(
      {
        hooks: {
          Notification: [
            {
              hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/hooks/asks-capture.mjs" }],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "command", command: "${CLAUDE_PROJECT_DIR}/hooks/asks-capture.mjs" }],
            },
          ],
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
  writeFileSync(settingsPath(dir), partial);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "settings predating the UserPromptSubmit hook");
  return { dir, partial };
}

test("wire writes ${CLAUDE_PROJECT_DIR}-relative commands when the repo carries the hooks in-tree", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-rel-"));
  try {
    seedInTreeHooks(dir);
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    const commands = Object.values(s.hooks)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command));
    assert.equal(commands.length, 4);
    for (const cmd of commands) {
      assert.match(
        cmd,
        /^\$\{CLAUDE_PROJECT_DIR\}\/hooks\/(asks|decision)-capture\.mjs$/,
        `machine-absolute path written for an in-tree hook: ${cmd}`
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire keeps the absolute toolkit-path fallback for repos with no in-tree hooks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-abs-"));
  try {
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    assert.ok(
      s.hooks.Notification[0].hooks[0].command.includes(
        path.join(ROOT, "hooks", "asks-capture.mjs")
      ),
      "a repo without the hooks in-tree still gets the toolkit's absolute path"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire --hydration leaves a HEAD-committed settings.json byte-for-byte alone", () => {
  const { dir, partial } = repoWithTrackedPartialSettings();
  try {
    const r = run(dir, ["wire", "--hydration", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const { results } = JSON.parse(r.stdout);
    assert.equal(results[0].ok, true);
    assert.equal(results[0].changed, false, "hydration must not modify a tracked settings.json");
    assert.equal(results[0].skipped, "tracked-in-branch");
    assert.equal(
      readFileSync(settingsPath(dir), "utf8"),
      partial,
      "tracked settings.json content changed during hydration"
    );
    assert.equal(
      git(dir, "status", "--porcelain", "--", ".claude/settings.json"),
      "",
      "hydration dirtied the tracked settings.json"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire --hydration says so in human output, not a success-shaped 'already wired'", () => {
  const { dir } = repoWithTrackedPartialSettings();
  try {
    const r = run(dir, ["wire", "--hydration"]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /committed in branch/i);
    assert.equal(git(dir, "status", "--porcelain", "--", ".claude/settings.json"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire --hydration still wires an UNtracked settings.json (seed path unchanged)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-hydr-seed-"));
  try {
    seedInTreeHooks(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@t.t");
    git(dir, "config", "user.name", "t");
    writeFileSync(path.join(dir, "README.md"), "x\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-qm", "no settings committed");
    const r = run(dir, ["wire", "--hydration", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const { results } = JSON.parse(r.stdout);
    assert.equal(results[0].changed, true);
    const s = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    assert.equal(
      s.hooks.UserPromptSubmit[0].hooks[0].command,
      "${CLAUDE_PROJECT_DIR}/hooks/asks-capture.mjs"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interactive wire (no --hydration) may update a tracked settings.json — repo-relatively", () => {
  const { dir } = repoWithTrackedPartialSettings();
  try {
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const { results } = JSON.parse(r.stdout);
    assert.equal(results[0].changed, true);
    assert.deepEqual(results[0].added, ["UserPromptSubmit → asks-capture.mjs"]);
    const s = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    assert.equal(
      s.hooks.UserPromptSubmit[0].hooks[0].command,
      "${CLAUDE_PROJECT_DIR}/hooks/asks-capture.mjs",
      "an explicit wire into a tracked file must still never write a machine-absolute path"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
