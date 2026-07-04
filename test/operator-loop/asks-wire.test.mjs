// test/operator-loop/asks-wire.test.mjs — `aios asks wire` settings merge + idempotency (AIO-167).

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const HOOKS = path.join(ROOT, "hooks");

function run(dir, args) {
  try {
    const stdout = execFileSync("node", [CLI, "asks", ...args, "--repo", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function settingsPath(dir) {
  return path.join(dir, ".claude", "settings.json");
}

test("wire creates settings.json with absolute hook paths when absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-bare-"));
  try {
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const { results } = JSON.parse(r.stdout);
    assert.equal(results.length, 1);
    assert.equal(results[0].changed, true);
    const s = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    assert.ok(
      s.hooks.Notification[0].hooks[0].command.includes(path.join(HOOKS, "asks-capture.mjs"))
    );
    assert.ok(
      s.hooks.PostToolUse[0].hooks[0].command.includes(path.join(HOOKS, "decision-capture.mjs"))
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire merges without disturbing unrelated hooks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-merge-"));
  try {
    const claude = path.join(dir, ".claude");
    mkdirSync(claude, { recursive: true });
    const before = {
      permissions: { allow: ["Bash(echo:*)"] },
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: "/tmp/guard.sh" }],
          },
        ],
      },
    };
    writeFileSync(settingsPath(dir), JSON.stringify(before, null, 2) + "\n");
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const after = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
    assert.deepEqual(after.permissions, before.permissions);
    assert.deepEqual(after.hooks.PreToolUse, before.hooks.PreToolUse);
    assert.ok(after.hooks.Notification?.length);
    assert.ok(after.hooks.Stop?.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire skips corrupt JSON with non-zero exit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-corrupt-"));
  try {
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(settingsPath(dir), "{ not json");
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 1, r.stdout);
    const { results } = JSON.parse(r.stdout);
    assert.equal(results[0].ok, false);
    assert.equal(readFileSync(settingsPath(dir), "utf8"), "{ not json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire skips malformed hooks shape with non-zero exit", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-bad-hooks-"));
  try {
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(settingsPath(dir), JSON.stringify({ hooks: "nope" }) + "\n");
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 1);
    const { results } = JSON.parse(r.stdout);
    assert.match(results[0].error, /hooks/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire is idempotent when hooks already present (relative path)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-idem-"));
  try {
    mkdirSync(path.join(dir, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath(dir),
      JSON.stringify({
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
      }) + "\n"
    );
    const before = readFileSync(settingsPath(dir), "utf8");
    const r = run(dir, ["wire", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const { results } = JSON.parse(r.stdout);
    assert.equal(results[0].changed, false);
    assert.equal(readFileSync(settingsPath(dir), "utf8"), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wire --dry-run writes nothing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-wire-dry-"));
  try {
    const r = run(dir, ["wire", "--dry-run", "--json"]);
    assert.equal(r.code, 0, r.stderr);
    const { results } = JSON.parse(r.stdout);
    assert.equal(results[0].changed, true);
    assert.throws(() => readFileSync(settingsPath(dir), "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
