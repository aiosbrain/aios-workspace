import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseUserConfig,
  parseWorkspaceConfig,
  resolveUserConfigPath,
  writeUserConfig,
} from "../scripts/cli/config-broker.mjs";

test("platform user-config paths and absolute override are deterministic", () => {
  assert.equal(
    resolveUserConfigPath({ platform: "linux", home: "/home/alex", env: {} }),
    "/home/alex/.config/aios/config.json"
  );
  assert.equal(
    resolveUserConfigPath({
      platform: "linux",
      home: "/home/alex",
      env: { XDG_CONFIG_HOME: "/cfg" },
    }),
    "/cfg/aios/config.json"
  );
  assert.equal(
    resolveUserConfigPath({ platform: "darwin", home: "/Users/alex", env: {} }),
    "/Users/alex/Library/Application Support/aios/config.json"
  );
  assert.equal(
    resolveUserConfigPath({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\alex\\AppData\\Roaming" },
    }),
    "C:\\Users\\alex\\AppData\\Roaming\\aios\\config.json"
  );
  assert.equal(
    resolveUserConfigPath({ platform: "linux", env: { AIOS_CONFIG_DIR: "/opt/config" } }),
    "/opt/config/config.json"
  );
  assert.throws(
    () => resolveUserConfigPath({ platform: "linux", env: { AIOS_CONFIG_DIR: "relative" } }),
    (error) => error.code === "AIOS_E_CONFIG_INVALID"
  );
});

test("user/workspace config rejects plaintext secrets and preserves unknown fields", async () => {
  assert.throws(
    () => parseUserConfig('{"schemaVersion":2,"api_key":"not-a-real-key"}'),
    (error) => error.code === "AIOS_E_CONFIG_INVALID"
  );
  assert.throws(
    () => parseWorkspaceConfig("owner: alex\nprovider_token: fixture-value\n"),
    (error) => error.code === "AIOS_E_CONFIG_INVALID"
  );
  for (const key of ["apiKey", "accessToken", "provider-token", "privateKey"]) {
    assert.throws(
      () => parseUserConfig(JSON.stringify({ schemaVersion: 2, nested: { [key]: "fixture" } })),
      (error) => error.code === "AIOS_E_CONFIG_INVALID",
      key
    );
  }
  assert.doesNotThrow(() =>
    parseUserConfig(
      JSON.stringify({ schemaVersion: 2, credentialSources: { apiKeyReference: "keychain:item" } })
    )
  );
  const root = mkdtempSync(path.join(tmpdir(), "aios-config-broker-"));
  const target = path.join(root, "config.json");
  try {
    writeFileSync(target, '{"schemaVersion":2,"futureField":{"enabled":true}}\n', { mode: 0o600 });
    await writeUserConfig(target, { defaultWorkspace: "/workspace" });
    const document = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(document.futureField, { enabled: true });
    assert.equal(document.defaultWorkspace, "/workspace");
    if (process.platform !== "win32") assert.equal(statSync(target).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
