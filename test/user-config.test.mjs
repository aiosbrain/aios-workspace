import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isWithinGuardScope,
  loadUserConfig,
  userConfigPath,
  writeUserConfig,
} from "../scripts/cli/user-config.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-user-config-"));
  const workspace = path.join(root, "workspace");
  const other = path.join(root, "other");
  const config = path.join(root, "config");
  mkdirSync(workspace);
  mkdirSync(other);
  writeFileSync(path.join(workspace, "aios.yaml"), "workspace: test\n");
  return { root, workspace, other, env: { ...process.env, XDG_CONFIG_HOME: config } };
}

test("writes and reads a canonical versioned XDG config with restrictive permissions", () => {
  const f = fixture();
  try {
    const saved = writeUserConfig(
      { defaultWorkspace: f.workspace, guardScopes: [f.workspace, f.other, f.other] },
      { env: f.env }
    );
    assert.equal(saved.schemaVersion, 1);
    assert.deepEqual(saved.guardScopes, [realpathSync(f.workspace), realpathSync(f.other)]);
    assert.deepEqual(loadUserConfig({ env: f.env }), saved);
    assert.equal(statSync(userConfigPath(f.env)).mode & 0o777, 0o600);
    assert.doesNotMatch(readFileSync(userConfigPath(f.env), "utf8"), /API_KEY|token/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects relative XDG roots and non-workspace defaults", () => {
  const f = fixture();
  try {
    assert.throws(() => userConfigPath({ XDG_CONFIG_HOME: "relative" }), /absolute path/);
    assert.throws(
      () => writeUserConfig({ defaultWorkspace: f.other }, { env: f.env }),
      /stamped AIOS workspace/
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("guard scopes use canonical path containment, not string prefixes", () => {
  const f = fixture();
  try {
    const config = writeUserConfig(
      { defaultWorkspace: f.workspace, guardScopes: [f.workspace] },
      { env: f.env }
    );
    assert.equal(isWithinGuardScope(f.workspace, config), true);
    assert.equal(isWithinGuardScope(f.other, config), false);
  } finally {
    try {
      chmodSync(f.root, 0o700);
    } catch {}
    rmSync(f.root, { recursive: true, force: true });
  }
});
