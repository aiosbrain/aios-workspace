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

function separatedKey(key, separator) {
  return key.replace(/([a-z0-9])([A-Z])/g, `$1${separator}$2`).toLowerCase();
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
    "authorization",
    "auth",
    "authHeader",
    "bearer",
    "access_key",
    "signingKey",
    "basicAuth",
    "proxyAuth",
    "sessionCookie",
    "sessionId",
    "signature",
    "clientKey",
    "authorizationHeader",
    "bearerHeader",
    "jwt",
    "tokenOauth",
    "apiKeyOauth",
    "passwordOauth",
    "authOauth",
    // `key`/`keys` are iterative wrappers around a recognized secret family (AIO-1066 review).
    "secretKey",
    "secret_Key",
    "SECRET-KEYS",
    "sessionKey",
    "authKey",
    "signatureKey",
    "tokenKey",
    "credentialKey",
    "oauthKey",
    "providerOauthKey",
    "secretKeys",
    "tokenKeys",
    "passwordKeyValue",
    "jwtKeyValues",
    "sigKeyKey",
    // Standalone carriers (AIO-1066 review): connection strings and codes are secrets too.
    "connectionString",
    "connection_string",
    "CONNECTION-STRINGS",
    "databaseUrl",
    "database_url",
    "jdbcUrl",
    "dsn",
    "dsns",
    "primaryDsn",
    "accessCode",
    "access_codes",
    "passcode",
    "passphrase",
    "dbConnectionStringValue",
    "connectionStringKey",
  ]) {
    assertSecretRejected({ nested: { [key]: "fixture-secret" } }, key);
  }

  for (const key of ["secretKey", "tokenKeys", "authKey"]) {
    assertSecretRejected({ [key]: "fixture-secret" }, `top-level ${key}`);
    assertSecretRejected({ [key]: ["fixture-secret"] }, `array ${key}`);
  }

  for (const [label, document] of [
    ["secret array", { apiKeys: ["fixture-one", "fixture-two"] }],
    ["nested secret array", { providers: [{ name: "example", tokens: ["fixture"] }] }],
    ["secret object", { secrets: { example: "fixture" } }],
    ["nested secret value", { providers: { example: { auth: { passwordValue: "fixture" } } } }],
    ["non-empty whitespace", { token: " " }],
    ["non-string material value", { secrets: false }],
  ]) {
    assertSecretRejected(document, label);
  }

  assert.throws(
    () => parseWorkspaceConfig("owner: alex\nprovider_token: fixture-value\n"),
    (error) => error.code === "AIOS_E_CONFIG_INVALID"
  );
});

test("secret policy rejects generated casing, separator, plural, and value variants", () => {
  for (const stem of [
    "authorization",
    "authHeader",
    "bearer",
    "accessKey",
    "signingKey",
    "basicAuth",
    "proxyAuth",
    "sessionCookie",
    "sessionId",
    "signature",
    "sig",
    "clientKey",
    "authorizationHeader",
    "bearerHeader",
    "jwt",
  ]) {
    for (const suffix of ["", "s", "Value", "Values"]) {
      const candidate = `${stem}${suffix}`;
      for (const key of [
        candidate,
        candidate.toUpperCase(),
        separatedKey(candidate, "-"),
        separatedKey(candidate, "_"),
      ]) {
        assertSecretRejected({ fuzzed: { [key]: "fixture-secret" } }, `variant ${key}`);
      }
    }
  }
});

test("secret policy rejects literal or malformed reference-shaped fields", () => {
  for (const [label, document] of [
    ["api-key reference", { apiKeyReference: "literal-plaintext-secret" }],
    ["derived reference", { apiKeyReferenceValue: "literal-plaintext-secret" }],
    ["value-reference", { apiKeyValueReference: "literal-plaintext-secret" }],
    ["value-ref", { tokenValueRef: "literal-plaintext-secret" }],
    ["value-source", { passwordValueSource: "literal-plaintext-secret" }],
    ["plural-value refs", { privateKeyValuesRefs: ["literal-plaintext-secret"] }],
    ["authorization reference", { authorizationRef: "literal-plaintext-secret" }],
    ["auth reference", { authValueReference: "literal-plaintext-secret" }],
    ["auth-header source", { authHeaderSource: "literal-plaintext-secret" }],
    ["bearer reference", { bearerValueRef: "literal-plaintext-secret" }],
    ["access-key reference", { accessKeyReference: "literal-plaintext-secret" }],
    ["signing-key references", { signingKeyValuesRefs: ["literal-plaintext-secret"] }],
    ["basic-auth reference", { basicAuthRef: "literal-plaintext-secret" }],
    ["proxy-auth header reference", { proxyAuthHeaderReference: "literal-plaintext-secret" }],
    ["session-cookie reference", { sessionCookieRef: "literal-plaintext-secret" }],
    ["session-id source", { sessionIdValueSource: "literal-plaintext-secret" }],
    ["signature header reference", { signatureHeaderRef: "literal-plaintext-secret" }],
    ["sig reference", { sigReference: "literal-plaintext-secret" }],
    ["client-key references", { clientKeyValuesRefs: ["literal-plaintext-secret"] }],
    ["JWT header reference", { jwtHeaderReference: "literal-plaintext-secret" }],
    ["mixed wrapper ordering", { bearerValueHeaderReference: "literal-plaintext-secret" }],
    ["token OAuth reference", { tokenOauthRef: "literal-plaintext-secret" }],
    ["API-key OAuth reference", { apiKeyOauthValueReference: "literal-plaintext-secret" }],
    ["password OAuth source", { passwordOauthHeaderSource: "literal-plaintext-secret" }],
    ["token sources", { tokenSources: ["literal-secret-one"] }],
    ["nested password reference", { passwordRef: { value: "literal-secret-two" } }],
    ["mixed collection", { tokenRefs: ["env:VALID_TOKEN", "literal-secret"] }],
    ["nested collection", { tokenRefs: [["env:VALID_TOKEN"]] }],
    ["unknown scheme", { apiKeyReference: "vault:secret-name" }],
    ["malformed environment reference", { tokenRef: "env:NOT-VALID" }],
    ["malformed keychain reference", { passwordSource: "keychain:contains whitespace" }],
    ["literal credential-source map", { credentialSources: { default: "literal-secret" } }],
    ["nested credential-source map", { credentialSources: { default: { ref: "env:TOKEN" } } }],
  ]) {
    assertSecretRejected(document, label);
  }
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
    ["authorization reference", { authorizationRef: "env:AIOS_AUTHORIZATION" }],
    ["auth reference", { authValueReference: "keychain:auth" }],
    ["auth-header source", { authHeaderSource: "env:AIOS_AUTH_HEADER" }],
    ["bearer reference", { bearerValueRef: "keychain:bearer" }],
    ["access-key reference", { accessKeyReference: "env:AIOS_ACCESS_KEY" }],
    [
      "signing-key references",
      { signingKeyValuesRefs: ["keychain:signing", "env:AIOS_SIGNING_KEY"] },
    ],
    ["basic-auth reference", { basicAuthRef: "env:AIOS_BASIC_AUTH" }],
    ["proxy-auth header reference", { proxyAuthHeaderReference: "keychain:proxy-auth" }],
    ["session-cookie reference", { sessionCookieRef: "env:AIOS_SESSION_COOKIE" }],
    ["session-id source", { sessionIdValueSource: "keychain:session-id" }],
    ["signature header reference", { signatureHeaderRef: "env:AIOS_SIGNATURE" }],
    ["sig reference", { sigReference: "keychain:signature" }],
    ["client-key references", { clientKeyValuesRefs: ["env:AIOS_CLIENT_KEY"] }],
    ["JWT header reference", { jwtHeaderReference: "keychain:jwt" }],
    ["mixed wrapper ordering", { bearerValueHeaderReference: "env:AIOS_BEARER" }],
    ["plural reference", { apiKeyReferences: ["keychain:one", "env:SECOND_API_KEY"] }],
    ["connection-string reference", { connectionStringRef: "env:DATABASE_URL" }],
    ["dsn source", { dsnSource: "keychain:db/primary" }],
    ["underscored ref", { access_token_ref: "env:AIOS_TOKEN" }],
    ["dashed source", { "private-key-source": "keychain:item" }],
    ["token source", { tokenSource: "keychain:item" }],
    ["nested refs", { providers: { example: { tokenRef: "keychain:item" } } }],
    ["token lookalike", { tokenizer: "cl100k_base", tokenBudget: 4096 }],
    ["oauth lookalike", { oauth: "enabled", oauthEndpoint: "https://example.test/oauth" }],
    ["provider OAuth lookalike", { providerOauth: "enabled" }],
    ["authorization metadata", { authorizationPolicy: "external-provider" }],
    ["auth-header metadata", { authHeaderName: "X-Custom-Auth" }],
    ["bearer metadata", { bearerFormat: "RFC6750" }],
    ["access-key metadata", { accessKeyLabel: "automation" }],
    ["signing-key metadata", { signingKeyAlgorithm: "EdDSA" }],
    ["session metadata", { sessionTimeout: 3600 }],
    ["cookie metadata", { cookiePolicy: "strict" }],
    ["signature metadata", { signatureAlgorithm: "EdDSA" }],
    ["client-key metadata", { clientKeyLabel: "automation" }],
    ["JWT metadata", { jwtFormat: "compact" }],
    ["password policy", { passwordPolicy: "external-provider" }],
    ["secret rotation", { secretRotation: { enabled: true } }],
    // Benign `key` fields: the wrapper is only secret-bearing over a secret-family stem.
    ["bare key", { key: "workspace", keys: ["a", "b"] }],
    ["sort key", { sortKey: "updatedAt" }],
    ["primary key", { primaryKey: "id", partitionKey: "tenant", foreignKeys: ["owner"] }],
    ["key metadata", { secretKeyLabel: "automation", tokenKeyFormat: "opaque", keyName: "x" }],
    ["oauth-key metadata", { oauthKeyId: "kid-1" }],
    ["connection metadata", { connectionTimeout: 30, connectionPool: 8, maxConnections: 4 }],
    ["database metadata", { databaseName: "aios", databaseHost: "db.internal" }],
    ["dsn metadata", { dsnLabel: "primary", dsnFormat: "uri" }],
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
