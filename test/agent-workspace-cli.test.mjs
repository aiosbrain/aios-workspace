import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "scripts", "aios.mjs");
const run = (args, cwd, workspace, extraEnv = {}) =>
  spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, AIOS_AGENT_WORKSPACE: workspace, ...extraEnv },
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
    assert.notEqual(pm.status, 0);
    assert.doesNotMatch(pm.stderr, /no aios\.yaml found walking up from cwd/);
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

test("account commands use the XDG default after cwd and env fallbacks", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-default-workspace-"));
  const cwd = path.join(root, "cwd");
  const workspace = path.join(root, "workspace");
  const xdg = path.join(root, "config");
  try {
    mkdirSync(cwd);
    mkdirSync(workspace);
    mkdirSync(path.join(xdg, "aios"), { recursive: true });
    writeFileSync(path.join(workspace, "aios.yaml"), "{{AIOS_BRAIN_URL}}\n");
    writeFileSync(
      path.join(xdg, "aios", "config.json"),
      JSON.stringify({ schemaVersion: 1, defaultWorkspace: workspace, guardScopes: [workspace] })
    );
    const pm = run(["pm", "status"], cwd, "", { XDG_CONFIG_HOME: xdg });
    assert.notEqual(pm.status, 0);
    assert.match(pm.stderr, /unfilled template placeholder/);

    const push = run(["push", "--dry-run"], cwd, "", { XDG_CONFIG_HOME: xdg });
    assert.notEqual(push.status, 0);
    assert.match(push.stderr, /no aios\.yaml found walking up from cwd/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit --repo wins while cwd is inside another stamped workspace", () => {
  const local = mkdtempSync(path.join(tmpdir(), "aios-local-workspace-"));
  const explicit = mkdtempSync(path.join(tmpdir(), "aios-explicit-workspace-"));
  try {
    writeFileSync(path.join(local, "aios.yaml"), "workspace: local\nbrain_url:\nteam_id: t\n");
    writeFileSync(path.join(explicit, "aios.yaml"), "{{AIOS_BRAIN_URL}}\n");
    const pm = run(["pm", "status", "--repo", explicit], local, "");
    assert.notEqual(pm.status, 0);
    assert.match(pm.stderr, /unfilled template placeholder/);
  } finally {
    rmSync(local, { recursive: true, force: true });
    rmSync(explicit, { recursive: true, force: true });
  }
});
