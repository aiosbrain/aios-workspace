import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "aios.mjs");
const run = (args, cwd, workspace) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, AIOS_AGENT_WORKSPACE: workspace },
  });

test("integration commands use an explicit agent workspace but push stays fail-closed", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "aios-agent-cwd-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "aios-agent-workspace-"));
  try {
    writeFileSync(path.join(workspace, "aios.yaml"), "workspace: agent\nbrain_url: \nteam_id: t\n");
    const pm = run(["pm", "status"], cwd, workspace);
    assert.doesNotMatch(pm.stderr, /no aios\.yaml found walking up from cwd/);
    const push = run(["push", "--dry-run"], cwd, workspace);
    assert.notEqual(push.status, 0);
    assert.match(push.stderr, /no aios\.yaml found walking up from cwd/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
