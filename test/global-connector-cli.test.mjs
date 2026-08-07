import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("global Slack and Linear entrypoints work outside an AIOS repository", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "aios-global-connectors-"));
  try {
    const slack = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/slack.mjs"), "dm", "--help"],
      {
        cwd,
        encoding: "utf8",
      }
    );
    assert.equal(slack.status, 0, slack.stderr);
    assert.match(slack.stdout, /message-stdin/);

    const linear = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/linear.mjs"), "template", "aios"],
      { cwd, encoding: "utf8" }
    );
    assert.equal(linear.status, 0, linear.stderr);
    assert.match(linear.stdout, /What \/ why/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("global entrypoints consult an explicit agent workspace outside the repo", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "aios-global-connectors-cwd-"));
  const agentWorkspace = mkdtempSync(path.join(tmpdir(), "aios-global-connectors-agent-"));
  const env = { ...process.env, AIOS_AGENT_WORKSPACE: agentWorkspace };
  try {
    const slack = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/slack.mjs"), "dm", "--help"],
      { cwd, env, encoding: "utf8" }
    );
    assert.equal(slack.status, 0, slack.stderr);

    const linear = spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts/linear.mjs"), "template", "aios"],
      { cwd, env, encoding: "utf8" }
    );
    assert.equal(linear.status, 0, linear.stderr);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentWorkspace, { recursive: true, force: true });
  }
});
