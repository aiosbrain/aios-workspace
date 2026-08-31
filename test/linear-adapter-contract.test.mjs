// AIO-1067 — adapter credential/setup contract, fully offline:
//   - missing configuration → AIOS_E_CREDENTIAL_MISSING, exit class 3, remediation is the
//     exact bootstrap command (`aios connect linear`);
//   - `aios connect linear` (non-interactive) stores a credential REFERENCE, never a
//     plaintext secret; `aios linear status` reports the source class without values;
//   - `aios disconnect linear` removes the reference and is idempotent;
//   - a fresh user (empty config dir, no env key, workspace sources disabled) can connect
//     and complete a read against the mocked provider — the end of the AC-1 path.
// All credentials are synthetic; fetch is mocked; nothing talks to Linear.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const AIOS = path.join(ROOT, "scripts", "aios.mjs");
const MOCK = path.join(ROOT, "test", "helpers", "mock-linear-provider.mjs");
const SYNTHETIC = "synthetic-contract-key-not-real";

function freshEnv(configDir, extra = {}) {
  const env = {
    ...process.env,
    AIOS_CONFIG_DIR: configDir,
    AIOS_DISABLE_WORKSPACE_CREDENTIALS: "1",
    ...extra,
  };
  delete env.LINEAR_API_KEY;
  delete env.AIOS_AGENT_WORKSPACE; // a fresh user has no agent workspace configured
  return env;
}

const run = (args, env, preload = []) =>
  spawnSync(process.execPath, [...preload, AIOS, ...args], { cwd: ROOT, encoding: "utf8", env });

test("fresh user: missing configuration is a stable exit-3 error naming the bootstrap", () => {
  const cfg = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-a-"));
  try {
    const result = run(["linear", "get", "AIO-73"], freshEnv(cfg));
    assert.equal(result.status, 3);
    assert.match(result.stderr, /error \[AIOS_E_CREDENTIAL_MISSING\]/);
    assert.match(result.stderr, /^remediation: aios connect linear$/m);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("connect → status → read → disconnect lifecycle with a reference, no plaintext ever stored", () => {
  const cfg = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-b-"));
  try {
    // Non-interactive connect from an arbitrary cwd stores the reference.
    const connect = run(["connect", "linear", "--reference", "env:MY_LINEAR_KEY"], freshEnv(cfg));
    assert.equal(connect.status, 0, connect.stderr);
    const config = readFileSync(path.join(cfg, "config.json"), "utf8");
    assert.match(config, /"linear": "env:MY_LINEAR_KEY"/);
    assert.doesNotMatch(config, new RegExp(SYNTHETIC));

    // Reference present but unresolvable → status reports INCOMPLETE (not silently ok).
    const incomplete = run(["linear", "status"], freshEnv(cfg));
    assert.equal(incomplete.status, 3);
    assert.match(incomplete.stderr, /AIOS_E_CREDENTIAL_INCOMPLETE/);

    // With the referenced secret available, status names the source class, never the value.
    const env = freshEnv(cfg, { MY_LINEAR_KEY: SYNTHETIC });
    const status = run(["linear", "status", "--json"], env);
    assert.equal(status.status, 0, status.stderr);
    const report = JSON.parse(status.stdout);
    assert.deepEqual(report, {
      provider: "linear",
      configured: true,
      source: { name: "user-config", fields: ["apiKey"] },
    });
    assert.doesNotMatch(status.stdout + status.stderr, new RegExp(SYNTHETIC));

    // The fresh-user read completes against the mocked provider.
    const read = run(["linear", "get", "AIO-73"], env, ["--import", MOCK]);
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /^AIO-73 {2}Alpha {2}\[Backlog\] {2}id=issue-a$/m);

    // Disconnect removes the reference and is idempotent.
    const disconnect = run(["disconnect", "linear"], freshEnv(cfg));
    assert.equal(disconnect.status, 0, disconnect.stderr);
    assert.doesNotMatch(readFileSync(path.join(cfg, "config.json"), "utf8"), /env:MY_LINEAR_KEY/);
    const again = run(["disconnect", "linear"], freshEnv(cfg));
    assert.equal(again.status, 0);
    assert.match(again.stdout, /nothing to remove/);
    const missing = run(["linear", "status"], freshEnv(cfg));
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /AIOS_E_CREDENTIAL_MISSING/);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("connect rejects non-reference input instead of storing a plaintext secret", () => {
  const cfg = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-c-"));
  try {
    const result = run(
      ["connect", "linear", "--reference", "lin_api_notareallinearkey"],
      freshEnv(cfg)
    );
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /AIOS_E_USAGE/);
    assert.match(result.stderr, /env:VARIABLE_NAME or keychain:service/);
    assert.throws(() => readFileSync(path.join(cfg, "config.json")), /ENOENT/);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("non-interactive connect without input fails with usage, not a hang", () => {
  const cfg = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-d-"));
  try {
    const result = spawnSync(process.execPath, [AIOS, "connect", "linear"], {
      cwd: ROOT,
      encoding: "utf8",
      env: freshEnv(cfg),
      input: "",
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /AIOS_E_USAGE/);
    assert.match(result.stderr, /--reference env:LINEAR_API_KEY/);
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("environment credentials outrank the user-config reference (one complete source)", async () => {
  const { resolveLinearCredential } = await import("../scripts/connectors/linear/credentials.mjs");
  const resolved = await resolveLinearCredential({
    env: { LINEAR_API_KEY: SYNTHETIC, AIOS_DISABLE_WORKSPACE_CREDENTIALS: "1" },
  });
  assert.equal(resolved.source.name, "environment");
  assert.equal(resolved.values.apiKey, SYNTHETIC);
});

test("keychain-backed --token stores only the reference (injected keychain seam)", async () => {
  const cfg = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-e-"));
  try {
    const { cmdConnectLinear } = await import("../scripts/connectors/linear/setup.mjs");
    const writes = [];
    const code = await cmdConnectLinear(null, ["linear", "--token", SYNTHETIC], {
      env: { AIOS_CONFIG_DIR: cfg },
      platform: "darwin",
      keychainWrite: (service, secret) => {
        writes.push({ service, secret });
        return true;
      },
      keychain: () => "resolves", // injected read seam — never touch the real OS keychain

      stdout: { write: () => {} },
      stderr: { write: () => {} },
    });
    assert.equal(code, 0);
    assert.deepEqual(writes, [{ service: "aios-linear", secret: SYNTHETIC }]);
    const config = readFileSync(path.join(cfg, "config.json"), "utf8");
    assert.match(config, /"linear": "keychain:aios-linear"/);
    assert.doesNotMatch(config, new RegExp(SYNTHETIC));
  } finally {
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("workspace subdirectory invocation resolves the workspace credential and template (Bugbot r1)", () => {
  // Synthetic workspace: aios.yaml + plaintext .env vault key + a stamped issue template
  // that differs from the toolkit's. From a SUBDIRECTORY, every route must behave exactly
  // as from the root: the workspace key reaches the provider (asserted by the mock, never
  // printed) and the workspace's template copy wins over the toolkit's.
  const ws = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-ws-"));
  const sub = path.join(ws, "2-work", "deep");
  mkdirSync(sub, { recursive: true });
  writeFileSync(path.join(ws, "aios.yaml"), "project: synthetic\n");
  writeFileSync(path.join(ws, ".env"), "LINEAR_API_KEY=ws-synthetic-key-not-real\n");
  mkdirSync(path.join(ws, "docs", "agentic-ergonomics"), { recursive: true });
  writeFileSync(
    path.join(ws, "docs", "agentic-ergonomics", "aios-issue-template.md"),
    "# TITLE — synthetic\n\nWORKSPACE-TEMPLATE-MARKER\n"
  );
  const cfg = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-ws-cfg-"));
  const env = freshEnv(cfg, { MOCK_EXPECT_AUTH: "ws-synthetic-key-not-real" });
  delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS; // the workspace source IS the subject here
  const LINEAR_BIN = path.join(ROOT, "scripts", "linear.mjs");
  try {
    const invoke = (bin, args, cwd) =>
      spawnSync(process.execPath, ["--import", MOCK, bin, ...args], { cwd, encoding: "utf8", env });
    // Credential: the workspace vault key is what reaches the provider — root and subdir
    // identically, canonical route and compat delegate identically.
    const cases = [
      invoke(AIOS, ["linear", "get", "AIO-73"], ws),
      invoke(AIOS, ["linear", "get", "AIO-73"], sub),
      invoke(LINEAR_BIN, ["get", "AIO-73"], sub),
    ];
    for (const result of cases) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /ws-synthetic-key/);
    }
    assert.equal(cases[1].stdout, cases[0].stdout, "subdir read must match root read");
    assert.equal(cases[2].stdout, cases[0].stdout, "delegate subdir read must match");
    // Template: the workspace's stamped copy wins from root AND subdirectory, both routes.
    for (const result of [
      invoke(AIOS, ["linear", "template", "aios"], ws),
      invoke(AIOS, ["linear", "template", "aios"], sub),
      invoke(LINEAR_BIN, ["template", "aios"], sub),
    ]) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /WORKSPACE-TEMPLATE-MARKER/);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("nested .env below a workspace never shadows the aios.yaml root (Codex r2)", () => {
  // A package subdirectory carrying its own .env (decoy key) sits INSIDE the workspace.
  // Both routes must still resolve the aios.yaml root: the workspace vault key reaches the
  // provider (mock-asserted, decoy would fail it) and the workspace template still wins.
  const ws = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-nested-"));
  const nested = path.join(ws, "packages", "tool");
  mkdirSync(nested, { recursive: true });
  writeFileSync(path.join(ws, "aios.yaml"), "project: synthetic\n");
  writeFileSync(path.join(ws, ".env"), "LINEAR_API_KEY=ws-synthetic-key-not-real\n");
  writeFileSync(path.join(nested, ".env"), "LINEAR_API_KEY=nested-decoy-key-not-real\n");
  mkdirSync(path.join(ws, "docs", "agentic-ergonomics"), { recursive: true });
  writeFileSync(
    path.join(ws, "docs", "agentic-ergonomics", "aios-issue-template.md"),
    "# TITLE — synthetic\n\nWORKSPACE-TEMPLATE-MARKER\n"
  );
  const cfg = mkdtempSync(path.join(tmpdir(), "aio-1067-contract-nested-cfg-"));
  const env = freshEnv(cfg, { MOCK_EXPECT_AUTH: "ws-synthetic-key-not-real" });
  delete env.AIOS_DISABLE_WORKSPACE_CREDENTIALS;
  const LINEAR_BIN = path.join(ROOT, "scripts", "linear.mjs");
  try {
    const invoke = (bin, args) =>
      spawnSync(process.execPath, ["--import", MOCK, bin, ...args], {
        cwd: nested,
        encoding: "utf8",
        env,
      });
    const canonical = invoke(AIOS, ["linear", "get", "AIO-73"]);
    const delegate = invoke(LINEAR_BIN, ["get", "AIO-73"]);
    for (const result of [canonical, delegate]) {
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout + result.stderr, /decoy|ws-synthetic-key/);
    }
    assert.equal(delegate.stdout, canonical.stdout, "route parity from the nested dir");
    for (const result of [
      invoke(AIOS, ["linear", "template", "aios"]),
      invoke(LINEAR_BIN, ["template", "aios"]),
    ]) {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /WORKSPACE-TEMPLATE-MARKER/);
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});

test("with no aios.yaml anywhere, the nearest .env vault is still found (walk-up fallback)", async () => {
  const { findLinearBase } = await import("../scripts/connectors/linear/credentials.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "aio-1067-noyaml-"));
  const deep = path.join(root, "a", "b");
  mkdirSync(deep, { recursive: true });
  writeFileSync(path.join(root, ".env"), "LINEAR_API_KEY=vault-only-key-not-real\n");
  try {
    assert.equal(findLinearBase(deep), root, "nearest .env wins when no workspace marker exists");
    const bare = path.join(deep, "no-markers");
    mkdirSync(bare, { recursive: true });
    rmSync(path.join(root, ".env"));
    assert.equal(findLinearBase(bare), bare, "no markers at all → the start directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
