import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { MANAGED_PATHS } from "../scripts/toolkit-manifest.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hook = path.join(repoRoot, "hooks", "statusline-command.mjs");
const settings = JSON.parse(
  readFileSync(path.join(repoRoot, "scaffold", ".claude", "settings.json"), "utf8")
);

test("the configured statusLine command runs from a workspace path containing spaces", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "aios statusline "));
  const projectDir = path.join(parent, "workspace with spaces");
  const hooksDir = path.join(projectDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  cpSync(hook, path.join(hooksDir, "statusline-command.mjs"));

  try {
    const result = spawnSync(settings.statusLine.command, {
      shell: true,
      encoding: "utf8",
      input: JSON.stringify({ model: { display_name: "Sonnet" } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "Sonnet");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("the statusLine command renders model, workspace, context, and rate-limit usage", () => {
  const result = spawnSync(process.execPath, [hook], {
    encoding: "utf8",
    input: JSON.stringify({
      model: { display_name: "Sonnet 5" },
      workspace: { project_dir: "/tmp/example-workspace/" },
      context_window: { used_percentage: 12.6 },
      rate_limits: {
        five_hour: { used_percentage: 3.2 },
        seven_day: { used_percentage: 21.8 },
      },
    }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Sonnet 5 | example-workspace | Context: 13% | 5h used: 3% | 7d used: 22%"
  );
});

test("the statusLine command falls back safely for malformed input", () => {
  const result = spawnSync(process.execPath, [hook], {
    encoding: "utf8",
    input: "not-json",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Claude");
});

test("toolkit updates install the statusLine hook as an executable managed file", () => {
  const entry = MANAGED_PATHS.find(
    (candidate) => candidate.dest === "hooks/statusline-command.mjs"
  );

  assert.deepEqual(entry, {
    dest: "hooks/statusline-command.mjs",
    src: "hooks/statusline-command.mjs",
    kind: "file",
    exec: true,
  });
});
