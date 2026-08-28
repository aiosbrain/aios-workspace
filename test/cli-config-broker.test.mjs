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

function assertSecretRejected(document, label) {
  assert.throws(
    () => parseUserConfig(JSON.stringify({ schemaVersion: 2, ...document })),
    (error) => error.code === "AIOS_E_CONFIG_INVALID",
    label
  );
}

test("user/workspace config rejects normalized plaintext-secret fields", () => {
  for (const key of [
    "api_key",
    "apiKeys",
    "API-KEYS",
    "accessToken",
    "access_tokens",
    "provider-token",
    "tokens",
    "password",
    "passwordValue",
    "password_values",
    "clientSecret",
    "provider_secrets",
    "privateKey",
    "private-keys",
    "credentials",
  ]) {
    assertSecretRejected({ nested: { [key]: "fixture-secret" } }, key);
  }

  for (const [label, document] of [
    ["secret array", { apiKeys: ["fixture-one", "fixture-two"] }],
    ["nested secret array", { providers: [{ name: "example", tokens: ["fixture"] }] }],
    ["secret object", { secrets: { example: "fixture" } }],
    ["nested secret value", { providers: { example: { auth: { passwordValue: "fixture" } } } }],
    ["non-empty whitespace", { token: " " }],
    ["non-string material value", { secrets: false }],
    ["literal api-key reference", { apiKeyReference: "literal-plaintext-secret" }],
    ["literal derived reference", { apiKeyReferenceValue: "literal-plaintext-secret" }],
    ["literal value-reference", { apiKeyValueReference: "literal-plaintext-secret" }],
    ["literal value-ref", { tokenValueRef: "literal-plaintext-secret" }],
    ["literal value-source", { passwordValueSource: "literal-plaintext-secret" }],
    ["literal plural-value refs", { privateKeyValuesRefs: ["literal-plaintext-secret"] }],
    ["literal token sources", { tokenSources: ["literal-secret-one"] }],
    ["nested password reference", { passwordRef: { value: "literal-secret-two" } }],
    ["mixed reference collection", { tokenRefs: ["env:VALID_TOKEN", "literal-secret"] }],
    ["nested reference collection", { tokenRefs: [["env:VALID_TOKEN"]] }],
    ["unknown reference scheme", { apiKeyReference: "vault:secret-name" }],
    ["malformed environment reference", { tokenRef: "env:NOT-VALID" }],
    ["malformed keychain reference", { passwordSource: "keychain:contains whitespace" }],
    ["literal credential-source map", { credentialSources: { default: "literal-secret" } }],
    ["nested credential-source map", { credentialSources: { default: { ref: "env:TOKEN" } } }],
  ]) {
    assertSecretRejected(document, label);
  }

  assert.throws(
    () => parseWorkspaceConfig("owner: alex\nprovider_token: fixture-value\n"),
    (error) => error.code === "AIOS_E_CONFIG_INVALID"
  );
});

test("secret policy permits empty fields, references, and non-secret lookalikes", () => {
  for (const [label, document] of [
    ["null", { apiKey: null }],
    ["empty string", { token: "" }],
    ["empty array", { passwords: [] }],
    ["recursively empty array", { secrets: [null, "", [], {}] }],
    ["empty object", { privateKeys: {} }],
    [
      "credential sources",
      { credentialSources: { default: "keychain:item", automation: "env:AIOS_TOKEN" } },
    ],
    ["credential reference", { credentialReference: "keychain:item" }],
    ["credential ref", { credentialRef: "env:AIOS_CREDENTIAL" }],
    ["camel reference", { apiKeyReference: "keychain:service/account" }],
    ["derived reference", { apiKeyReferenceValue: "env:AIOS_API_KEY" }],
    ["value-reference", { apiKeyValueReference: "env:AIOS_API_KEY" }],
    ["value-ref", { tokenValueRef: "keychain:item" }],
    ["value-source", { passwordValueSource: "env:AIOS_PASSWORD" }],
    ["plural-value refs", { privateKeyValuesRefs: ["keychain:primary", "env:AIOS_PRIVATE_KEY"] }],
    ["plural reference", { apiKeyReferences: ["keychain:one", "env:SECOND_API_KEY"] }],
    ["underscored ref", { access_token_ref: "env:AIOS_TOKEN" }],
    ["dashed source", { "private-key-source": "keychain:item" }],
    ["token source", { tokenSource: "keychain:item" }],
    ["nested refs", { providers: { example: { tokenRef: "keychain:item" } } }],
    ["token lookalike", { tokenizer: "cl100k_base", tokenBudget: 4096 }],
    ["password policy", { passwordPolicy: "external-provider" }],
    ["secret rotation", { secretRotation: { enabled: true } }],
  ]) {
    assert.doesNotThrow(
      () => parseUserConfig(JSON.stringify({ schemaVersion: 2, ...document })),
      label
    );
  }
});

test("user config preserves unknown fields on write", async () => {
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
