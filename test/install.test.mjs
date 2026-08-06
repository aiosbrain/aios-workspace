import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkInstall, cmdInstall } from "../scripts/install.mjs";
import { installStatePath, userConfigPath } from "../scripts/cli/user-config.mjs";

async function quiet(run) {
  const original = console.log;
  console.log = () => {};
  try {
    return await run();
  } finally {
    console.log = original;
  }
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-install-"));
  const workspace = path.join(root, "workspace");
  const scope = path.join(root, "scope");
  mkdirSync(workspace);
  mkdirSync(scope);
  writeFileSync(path.join(workspace, "aios.yaml"), "workspace: install-test\n");
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_STATE_HOME: path.join(root, "state"),
    AIOS_INSTALL_SKIP_GLOBAL: "1",
  };
  return { root, workspace, scope, env };
}

test("installer is idempotent and keeps secrets out of XDG files", async () => {
  const f = fixture();
  try {
    const args = ["--workspace", f.workspace, "--guard-scope", f.scope, "--yes"];
    assert.equal(await quiet(() => cmdInstall(args, { env: f.env })), 0);
    const firstConfig = readFileSync(userConfigPath(f.env), "utf8");
    assert.equal(await quiet(() => cmdInstall(args, { env: f.env })), 0);
    assert.equal(readFileSync(userConfigPath(f.env), "utf8"), firstConfig);
    assert.equal(checkInstall({ env: f.env }).healthy, true);
    assert.doesNotMatch(firstConfig, /API_KEY|token/i);
    assert.ok(existsSync(installStatePath(f.env)));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("uninstall preserves config by default and purge removes it", async () => {
  const f = fixture();
  try {
    const installArgs = ["--workspace", f.workspace, "--yes"];
    await quiet(() => cmdInstall(installArgs, { env: f.env }));
    await quiet(() => cmdInstall(["--uninstall"], { env: f.env }));
    assert.ok(existsSync(userConfigPath(f.env)));
    assert.equal(existsSync(installStatePath(f.env)), false);
    await quiet(() => cmdInstall(installArgs, { env: f.env }));
    await quiet(() => cmdInstall(["--uninstall", "--purge"], { env: f.env }));
    assert.equal(existsSync(userConfigPath(f.env)), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("--yes fails closed without an explicit or cwd workspace", async () => {
  const f = fixture();
  const cwd = process.cwd();
  try {
    process.chdir(f.root);
    await assert.rejects(() => quiet(() => cmdInstall(["--yes"], { env: f.env })), /requires --workspace/);
  } finally {
    process.chdir(cwd);
    rmSync(f.root, { recursive: true, force: true });
  }
});
