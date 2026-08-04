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
    writeFileSync(
      path.join(workspace, "aios.yaml"),
      "workspace: agent\nbrain_url: http://127.0.0.1:1\nteam_id: t\n"
    );
    const pm = run(["pm", "status"], cwd, workspace);
    assert.doesNotMatch(pm.stderr, /no aios\.yaml found walking up from cwd/);
    assert.match(pm.stderr, /fetch failed/);
    const push = run(["push", "--dry-run"], cwd, workspace);
    assert.notEqual(push.status, 0);
    assert.match(push.stderr, /no aios\.yaml found walking up from cwd/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a stamped cwd takes precedence over the agent workspace", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "aios-local-workspace-"));
  const agent = mkdtempSync(path.join(tmpdir(), "aios-agent-workspace-"));
  try {
    writeFileSync(path.join(cwd, "aios.yaml"), "{{AIOS_BRAIN_URL}}\n");
    writeFileSync(path.join(agent, "aios.yaml"), "workspace: agent\nbrain_url: \nteam_id: t\n");
    const pm = run(["pm", "status"], cwd, agent);
    assert.match(pm.stderr, /unfilled template placeholder/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agent, { recursive: true, force: true });
  }
});

test("work does not use the agent workspace fallback", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "aios-agent-cwd-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "aios-agent-workspace-"));
  try {
    writeFileSync(path.join(workspace, "aios.yaml"), "workspace: agent\nbrain_url: \nteam_id: t\n");
    const work = run(["work", "done", "AIO-1", "--push"], cwd, workspace);
    assert.notEqual(work.status, 0);
    assert.match(work.stderr, /no aios\.yaml found walking up from cwd/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
