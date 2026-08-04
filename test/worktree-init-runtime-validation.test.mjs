import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  initializeWorktreeDependencies,
  missingLockedDependencies,
} from "../scripts/worktree-init.mjs";

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function runtimeFixture(lockKey, lockEntry) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aios-worktree-runtime-"));
  tmpDirs.push(root);
  const primary = path.join(root, "primary");
  const worktree = path.join(root, "worktree");
  mkdirSync(primary);
  mkdirSync(worktree);
  writeFileSync(
    path.join(primary, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": {}, [lockKey]: lockEntry } })
  );
  return { primary, worktree };
}

function installFakeBetterSqlite(primary) {
  const packageDir = path.join(primary, "node_modules", "better-sqlite3");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "13.0.1", main: "index.cjs" })
  );
  writeFileSync(path.join(packageDir, "index.cjs"), "module.exports = class { close() {} };\n");
}

function assertSharedLink(primary, worktree) {
  const link = path.join(worktree, "node_modules");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(path.resolve(worktree, readlinkSync(link)), path.join(primary, "node_modules"));
}

test("matching native manifest without a loadable payload is restored before linking", () => {
  const { primary, worktree } = runtimeFixture("node_modules/better-sqlite3", {
    version: "13.0.1",
    hasInstallScript: true,
  });
  const packageDir = path.join(primary, "node_modules", "better-sqlite3");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "13.0.1", main: "index.cjs" })
  );
  let installs = 0;

  initializeWorktreeDependencies({
    primary,
    worktree,
    install: () => {
      installs += 1;
      installFakeBetterSqlite(primary);
      return { status: 0 };
    },
  });

  assert.equal(installs, 1);
  assertSharedLink(primary, worktree);
});

test("successful installer status cannot publish an unusable native payload", () => {
  const { primary, worktree } = runtimeFixture("node_modules/better-sqlite3", {
    version: "13.0.1",
    hasInstallScript: true,
  });
  const packageDir = path.join(primary, "node_modules", "better-sqlite3");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "better-sqlite3", version: "13.0.1", main: "index.cjs" })
  );

  assert.throws(
    () => initializeWorktreeDependencies({ primary, worktree, install: () => ({ status: 0 }) }),
    /still incomplete.*unusable native payload/s
  );
  assert.throws(() => lstatSync(path.join(worktree, "node_modules")), { code: "ENOENT" });
});

test("a PowerShell-only Windows shim does not certify a command binary", () => {
  const { primary } = runtimeFixture("node_modules/prettier", {
    version: "3.9.6",
    bin: { prettier: "bin/prettier.cjs" },
  });
  const packageDir = path.join(primary, "node_modules", "prettier");
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "prettier", version: "3.9.6" })
  );
  writeFileSync(path.join(packageDir, "bin", "prettier.cjs"), "");
  const binDir = path.join(primary, "node_modules", ".bin");
  mkdirSync(binDir);
  const psShim = path.join(binDir, "prettier.ps1");
  writeFileSync(psShim, "");
  chmodSync(psShim, 0o755);

  assert.deepEqual(missingLockedDependencies(primary, { platform: "win32" }), [
    "node_modules/prettier (missing .bin/prettier)",
  ]);
});
