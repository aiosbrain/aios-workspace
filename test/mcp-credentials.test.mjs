import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readGlobalCredential,
  validateCredentialTuple,
  assertWindowsCredentialAcl,
  readWindowsCredentialAcl,
} from "../scripts/mcp-credentials.mjs";
import { resolveBrainConfig } from "../scripts/mcp-config.mjs";

const tuple = { brain_url: "https://global.example", api_key: "synthetic-global-key" };
function fixture(fn) {
  const home = mkdtempSync(path.join(tmpdir(), "mcp-credential-test-"));
  const directory = path.join(home, ".aios");
  const file = path.join(directory, "credentials.json");
  mkdirSync(directory, { mode: 0o700 });
  const write = (value = { version: 1, default: tuple }) =>
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
  try {
    return fn({ home, directory, file, write });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("global reader validates private default tuple and does not require team", () =>
  fixture(({ home, write }) => {
    assert.equal(readGlobalCredential({ home }), null);
    write();
    const config = resolveBrainConfig({ cwd: home, home, env: {} });
    assert.equal(config.api_key, tuple.api_key);
    assert.equal(config.credential_source, "global-file");
    assert.equal(config.team_id, "");
    assert.deepEqual(config.missing, []);
    assert.equal(readGlobalCredential({ home }).brain_url, tuple.brain_url);
  }));

test("credential sources stay paired to their origins and environment/workspace overrides remain compatible", () =>
  fixture(({ home, write }) => {
    write();
    const resolve = (env = {}) => resolveBrainConfig({ cwd: home, home, env });
    assert.equal(resolve({ AIOS_BRAIN_URL: tuple.brain_url + "/api/v1" }).api_key, tuple.api_key);
    assert.throws(
      () => resolve({ AIOS_BRAIN_URL: "https://other.example" }),
      /differs from the stored credential origin/
    );
    const explicit = resolve({
      AIOS_BRAIN_URL: "https://other.example",
      AIOS_API_KEY: "synthetic-other-key",
    });
    assert.equal(explicit.credential_source, "environment");
    assert.equal(explicit.api_key, "synthetic-other-key");
    assert.equal(explicit.brain_url, "https://other.example");
    assert.deepEqual(resolve({ AIOS_API_KEY: "synthetic-other-key" }).missing, ["AIOS_BRAIN_URL"]);
    writeFileSync(
      path.join(home, "aios.yaml"),
      "brain_url: https://workspace.example\napi_key_env: WORKSPACE_KEY\n"
    );
    writeFileSync(path.join(home, ".env"), "WORKSPACE_KEY=synthetic-workspace-key\n");
    assert.equal(
      resolve().api_key,
      tuple.api_key,
      "global tuple precedes legacy workspace defaults"
    );
    assert.equal(
      resolve({ AIOS_BRAIN_URL: "https://workspace.example" }).api_key,
      "synthetic-workspace-key"
    );
    assert.equal(
      resolve({ WORKSPACE_KEY: "synthetic-rotated-key" }).brain_url,
      "https://workspace.example"
    );
    rmSync(path.join(home, ".aios", "credentials.json"));
    assert.throws(
      () => resolve({ AIOS_BRAIN_URL: "https://different.example" }),
      /differs from the workspace credential origin/
    );
    assert.equal(resolve().credential_source, "workspace");
  }));

test("malformed documents and credential tuples fail without echoing their values", () =>
  fixture(({ home, write }) => {
    for (const value of [
      "{synthetic-secret-not-json",
      { version: 2, default: tuple },
      { version: 1, default: tuple, surprise: true },
      { version: 1, default: { ...tuple, extra: true } },
      { version: 1, default: { ...tuple, api_key: 42 } },
    ]) {
      write(value);
      assert.throws(
        () => readGlobalCredential({ home }),
        (error) => !error.message.includes("synthetic-secret")
      );
    }
    for (const value of [
      null,
      [],
      {},
      { ...tuple, member: 9 },
      { ...tuple, api_key: "key\nheader" },
      { ...tuple, brain_url: "file:///tmp/foreign" },
    ])
      assert.throws(() => validateCredentialTuple(value));
    write("x".repeat(65537));
    assert.throws(() => readGlobalCredential({ home }), /too large/);
  }));

test(
  "POSIX credentials refuse broad permissions, foreign ownership and symlinks",
  { skip: process.platform === "win32" },
  () =>
    fixture(({ home, directory, file, write }) => {
      write();
      chmodSync(file, 0o644);
      assert.throws(() => readGlobalCredential({ home }), /owner-only/);
      chmodSync(file, 0o600);
      assert.throws(() => readGlobalCredential({ home, uid: process.getuid() + 1 }), /owner-only/);
      chmodSync(directory, 0o777);
      assert.throws(() => readGlobalCredential({ home }), /owner-only/);
      chmodSync(directory, 0o700);
      rmSync(file);
      const target = path.join(home, "secret.json");
      writeFileSync(target, JSON.stringify({ version: 1, default: tuple }), { mode: 0o600 });
      symlinkSync(target, file);
      assert.throws(() => readGlobalCredential({ home }), /regular file/);
      rmSync(file);
      rmSync(directory, { recursive: true });
      const linkedDirectory = path.join(home, "linked");
      mkdirSync(linkedDirectory, { mode: 0o700 });
      writeFileSync(
        path.join(linkedDirectory, "credentials.json"),
        JSON.stringify({ version: 1, default: tuple }),
        { mode: 0o600 }
      );
      symlinkSync(linkedDirectory, directory);
      assert.throws(() => readGlobalCredential({ home }), /real directory/);
    })
);

test("Windows ACL verification accepts owner/SYSTEM/admin only and passes paths as data", () =>
  fixture(({ home, write }) => {
    write();
    const acl = {
      owner: "S-1-5-21-100",
      current: "S-1-5-21-100",
      allow: ["S-1-5-21-100", "S-1-5-18", "S-1-5-32-544"],
    };
    assertWindowsCredentialAcl(acl);
    assert.throws(() => assertWindowsCredentialAcl({ ...acl, owner: "S-1-5-21-999" }), /ownership/);
    assert.throws(
      () => assertWindowsCredentialAcl({ ...acl, allow: [...acl.allow, "S-1-1-0"] }),
      /another principal/
    );
    assert.throws(() => assertWindowsCredentialAcl({ ...acl, allow: [] }), /owner access/);
    assert.throws(() => assertWindowsCredentialAcl(null), /ownership/);
    assert.equal(
      readGlobalCredential({ home, platform: "win32", readAcl: () => acl }).api_key,
      tuple.api_key
    );
    const suspiciousPath = "C:\\synthetic '; Write-Output surprise;\\credentials.json";
    const actual = readWindowsCredentialAcl(suspiciousPath, (command, args, options) => {
      assert.equal(command, "powershell.exe");
      assert.ok(!args.join(" ").includes(suspiciousPath));
      assert.equal(options.env.AIOS_CREDENTIAL_ACL_PATH, suspiciousPath);
      return JSON.stringify(acl);
    });
    assert.deepEqual(actual, acl);
  }));

test("new global tuples reject remote plaintext HTTP while allowing loopback fixtures", () => {
  assert.throws(
    () =>
      validateCredentialTuple({
        brain_url: "http://brain.example.com",
        api_key: "synthetic-secret",
      }),
    /https/i
  );
  assert.equal(
    validateCredentialTuple({ brain_url: "http://127.0.0.1:12345", api_key: "synthetic-secret" })
      .brain_url,
    "http://127.0.0.1:12345"
  );
});
