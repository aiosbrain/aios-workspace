import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { initializeWorktreeDependencies } from "../scripts/worktree-init.mjs";

const WORKTREE_INIT = fileURLToPath(new URL("../scripts/worktree-init.mjs", import.meta.url));

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture({ installed = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aios-worktree-deps-"));
  tmpDirs.push(root);
  const primary = path.join(root, "primary");
  const worktree = path.join(root, "worktree");
  mkdirSync(primary, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  writeFileSync(
    path.join(primary, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { prettier: "^3.9.6" } },
        "node_modules/prettier": {
          version: "3.9.6",
          dev: true,
          bin: { prettier: "bin/prettier.cjs" },
        },
        "node_modules/prettier-plugin-test": { version: "1.0.0", dev: true },
        "node_modules/platform-native-test": {
          version: "1.0.0",
          optional: true,
          os: [process.platform],
          cpu: [process.arch],
        },
        "node_modules/other-platform-test": {
          version: "1.0.0",
          optional: true,
          os: [`!${process.platform}`],
        },
      },
    })
  );
  if (installed) installPrettier(primary);
  return { primary, worktree };
}

function installPrettier(primary) {
  const packageDir = path.join(primary, "node_modules", "prettier");
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "prettier", version: "3.9.6", bin: "./bin/prettier.cjs" })
  );
  writeFileSync(path.join(packageDir, "bin", "prettier.cjs"), "#!/usr/bin/env node\n");
  const binDir = path.join(primary, "node_modules", ".bin");
  mkdirSync(binDir, { recursive: true });
  const shim = process.platform === "win32" ? "prettier.cmd" : "prettier";
  const shimPath = path.join(binDir, shim);
  writeFileSync(shimPath, "#!/bin/sh\n");
  if (process.platform !== "win32") chmodSync(shimPath, 0o755);
  const transitive = path.join(primary, "node_modules", "prettier-plugin-test");
  mkdirSync(transitive, { recursive: true });
  writeFileSync(path.join(transitive, "package.json"), JSON.stringify({ version: "1.0.0" }));
  const native = path.join(primary, "node_modules", "platform-native-test");
  mkdirSync(native, { recursive: true });
  writeFileSync(path.join(native, "package.json"), JSON.stringify({ version: "1.0.0" }));
}

function assertSharedLink(primary, worktree) {
  const link = path.join(worktree, "node_modules");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(path.resolve(worktree, readlinkSync(link)), path.join(primary, "node_modules"));
}

function registerWorktree(primary, worktree, name) {
  const metadata = path.join(primary, ".git", "worktrees", name);
  mkdirSync(metadata, { recursive: true });
  writeFileSync(path.join(metadata, "gitdir"), `${path.join(worktree, ".git")}\n`);
}

function hydrationWorker(root) {
  const worker = path.join(root, "hydrate-with-test-installer.mjs");
  writeFileSync(
    worker,
    `import { spawnSync } from "node:child_process";
import { initializeWorktreeDependencies } from ${JSON.stringify(pathToFileURL(WORKTREE_INIT).href)};
const [, , primary, worktree] = process.argv;
try {
  initializeWorktreeDependencies({
    primary,
    worktree,
    install: (cwd) => spawnSync(process.execPath, [process.env.AIOS_TEST_INSTALL_SCRIPT], {
      cwd,
      env: process.env,
      stdio: "inherit",
    }),
  });
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
`
  );
  return worker;
}

test("complete shared install links node_modules without reinstalling", () => {
  const { primary, worktree } = fixture({ installed: true });
  let installCalls = 0;
  const result = initializeWorktreeDependencies({
    primary,
    worktree,
    install: () => {
      installCalls += 1;
      return { status: 0 };
    },
  });

  assert.equal(result.status, "linked");
  assert.equal(installCalls, 0);
  assertSharedLink(primary, worktree);
});

test("missing dev dependency is restored in the primary before linking", () => {
  const { primary, worktree } = fixture();
  const result = initializeWorktreeDependencies({
    primary,
    worktree,
    install: () => {
      assert.ok(existsSync(path.join(primary, ".aios", "worktree-dependencies.lock.reclaim")));
      assert.equal(
        existsSync(path.join(worktree, "node_modules")),
        false,
        "the incomplete shared tree must not be linked during restore"
      );
      installPrettier(primary);
      return { status: 0 };
    },
  });

  assert.equal(result.status, "linked");
  assert.ok(!existsSync(path.join(primary, ".aios", "worktree-dependencies.lock.reclaim")));
  assertSharedLink(primary, worktree);
});

test("matching root manifest still restores missing binary and transitive packages", () => {
  const { primary, worktree } = fixture();
  const packageDir = path.join(primary, "node_modules", "prettier");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "prettier", version: "3.9.6" })
  );
  let installCalls = 0;

  initializeWorktreeDependencies({
    primary,
    worktree,
    install: () => {
      installCalls += 1;
      installPrettier(primary);
      return { status: 0 };
    },
  });
  assert.equal(installCalls, 1);
  assertSharedLink(primary, worktree);
});

test("a shim for the wrong host platform does not certify the install", () => {
  const { primary, worktree } = fixture({ installed: true });
  const binDir = path.join(primary, "node_modules", ".bin");
  const usableShim = process.platform === "win32" ? "prettier.cmd" : "prettier";
  const wrongShim = process.platform === "win32" ? "prettier" : "prettier.cmd";
  rmSync(path.join(binDir, usableShim));
  writeFileSync(path.join(binDir, wrongShim), "wrong platform\n");
  let installCalls = 0;

  initializeWorktreeDependencies({
    primary,
    worktree,
    install: () => {
      installCalls += 1;
      installPrettier(primary);
      return { status: 0 };
    },
  });
  assert.equal(installCalls, 1);
  assertSharedLink(primary, worktree);
});

test(
  "a non-executable POSIX shim does not certify the install",
  { skip: process.platform === "win32" },
  () => {
    const { primary, worktree } = fixture({ installed: true });
    chmodSync(path.join(primary, "node_modules", ".bin", "prettier"), 0o644);
    let installCalls = 0;

    initializeWorktreeDependencies({
      primary,
      worktree,
      install: () => {
        installCalls += 1;
        installPrettier(primary);
        return { status: 0 };
      },
    });

    assert.equal(installCalls, 1);
    assertSharedLink(primary, worktree);
  }
);

test("missing host-applicable optional native package triggers restoration", () => {
  const { primary, worktree } = fixture({ installed: true });
  rmSync(path.join(primary, "node_modules", "platform-native-test"), {
    recursive: true,
    force: true,
  });
  let installCalls = 0;

  initializeWorktreeDependencies({
    primary,
    worktree,
    install: () => {
      installCalls += 1;
      installPrettier(primary);
      return { status: 0 };
    },
  });

  assert.equal(installCalls, 1);
  assertSharedLink(primary, worktree);
});

test("restoration detaches and relinks registered shared worktrees after validation", () => {
  const { primary, worktree } = fixture({ installed: true });
  const secondWorktree = path.join(path.dirname(primary), "worktree-two");
  mkdirSync(secondWorktree);
  registerWorktree(primary, worktree, "first");
  initializeWorktreeDependencies({ primary, worktree, install: () => assert.fail() });
  rmSync(path.join(primary, "node_modules", "prettier-plugin-test"), {
    recursive: true,
    force: true,
  });
  initializeWorktreeDependencies({
    primary,
    worktree: secondWorktree,
    install: () => {
      assert.throws(() => lstatSync(path.join(worktree, "node_modules")), { code: "ENOENT" });
      installPrettier(primary);
      return { status: 0 };
    },
  });
  assertSharedLink(primary, worktree);
  assertSharedLink(primary, secondWorktree);
});

test("failed restoration leaves registered shared worktrees safely detached", () => {
  const { primary, worktree } = fixture({ installed: true });
  const secondWorktree = path.join(path.dirname(primary), "worktree-two");
  mkdirSync(secondWorktree);
  registerWorktree(primary, worktree, "first");
  initializeWorktreeDependencies({ primary, worktree, install: () => assert.fail() });
  rmSync(path.join(primary, "node_modules", "prettier-plugin-test"), {
    recursive: true,
    force: true,
  });
  assert.throws(
    () =>
      initializeWorktreeDependencies({
        primary,
        worktree: secondWorktree,
        install: () => ({ status: 47 }),
      }),
    /npm ci could not restore shared dependencies \(exit 47\)/
  );
  assert.throws(() => lstatSync(path.join(worktree, "node_modules")), { code: "ENOENT" });
  assert.throws(() => lstatSync(path.join(secondWorktree, "node_modules")), { code: "ENOENT" });
});

test("forced restore failure exits non-zero and leaves no misleading link", () => {
  const { primary, worktree } = fixture();
  symlinkSync(
    path.join(path.dirname(primary), "moved-primary", "node_modules"),
    path.join(worktree, "node_modules"),
    "dir"
  );
  const result = spawnSync(
    process.execPath,
    [WORKTREE_INIT, "--primary", primary, "--worktree", worktree],
    {
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /npm ci could not restore shared dependencies \(exit \d+\).*npm ci --include=dev/s
  );
  assert.throws(() => lstatSync(path.join(worktree, "node_modules")), { code: "ENOENT" });
});

function finished(child) {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (existsSync(file)) return resolve();
      if (Date.now() >= deadline) return reject(new Error(`timed out waiting for ${file}`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test("a waiter repairs rather than linking files left by a failed active install", async () => {
  const { primary, worktree } = fixture();
  const secondWorktree = path.join(path.dirname(primary), "worktree-two");
  mkdirSync(secondWorktree);
  const worker = hydrationWorker(path.dirname(primary));
  const calls = path.join(path.dirname(primary), "interleaved-npm-calls");
  const ready = path.join(path.dirname(primary), "first-install-looks-complete");
  const fakeNpm = path.join(path.dirname(primary), "interleaved-install.mjs");
  writeFileSync(
    fakeNpm,
    `import fs from "node:fs";
import path from "node:path";
const callFile = process.env.AIOS_TEST_NPM_CALLS;
const callNumber = fs.existsSync(callFile) ? fs.readFileSync(callFile, "utf8").trim().split("\\n").length + 1 : 1;
fs.appendFileSync(callFile, "call\\n");
const root = process.cwd();
const pkg = path.join(root, "node_modules", "prettier");
fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "prettier", version: "3.9.6" }));
fs.writeFileSync(path.join(pkg, "bin", "prettier.cjs"), "");
fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
const shim = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "prettier.cmd" : "prettier");
fs.writeFileSync(shim, "");
if (process.platform !== "win32") fs.chmodSync(shim, 0o755);
const transitive = path.join(root, "node_modules", "prettier-plugin-test");
fs.mkdirSync(transitive, { recursive: true });
fs.writeFileSync(path.join(transitive, "package.json"), JSON.stringify({ version: "1.0.0" }));
const native = path.join(root, "node_modules", "platform-native-test");
fs.mkdirSync(native, { recursive: true });
fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ version: "1.0.0" }));
if (callNumber === 1) {
  fs.writeFileSync(process.env.AIOS_TEST_INSTALL_READY, "ready\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  process.exit(47);
}
`
  );
  const env = {
    ...process.env,
    AIOS_TEST_INSTALL_READY: ready,
    AIOS_TEST_INSTALL_SCRIPT: fakeNpm,
    AIOS_TEST_NPM_CALLS: calls,
  };
  const args = (target) => [worker, primary, target];
  const first = spawn(process.execPath, args(worktree), {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  await waitForFile(ready);
  const second = spawn(process.execPath, args(secondWorktree), {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [firstResult, secondResult] = await Promise.all([finished(first), finished(second)]);

  assert.equal(firstResult.status, 1);
  assert.match(firstResult.stderr, /npm ci could not restore shared dependencies \(exit 47\)/);
  assert.equal(secondResult.status, 0, secondResult.stderr);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 2);
  assert.throws(() => lstatSync(path.join(worktree, "node_modules")), { code: "ENOENT" });
  assertSharedLink(primary, secondWorktree);
});

test("a stale reclaim guard fails closed without deleting lock ownership", () => {
  const { primary, worktree } = fixture();
  const lockDir = path.join(primary, ".aios");
  mkdirSync(lockDir);
  const lock = path.join(lockDir, "worktree-dependencies.lock");
  const guard = `${lock}.reclaim`;
  const deadLockOwner = `${JSON.stringify({ pid: 999_999_999, token: "dead-owner" })}\n`;
  const deadGuardOwner = `${JSON.stringify({ pid: 999_999_998, token: "dead-reclaimer" })}\n`;
  writeFileSync(lock, deadLockOwner);
  writeFileSync(guard, deadGuardOwner);

  assert.throws(
    () =>
      initializeWorktreeDependencies({
        primary,
        worktree,
        install: () => assert.fail("must not install without exclusive lock ownership"),
      }),
    /stale reclaim guard.*confirming no dependency install is running/s
  );
  assert.equal(readFileSync(lock, "utf8"), deadLockOwner);
  assert.equal(readFileSync(guard, "utf8"), deadGuardOwner);
  assert.throws(() => lstatSync(path.join(worktree, "node_modules")), { code: "ENOENT" });
});

test("concurrent hydrations safely reclaim a stale lock and install only once", async () => {
  const { primary, worktree } = fixture();
  const secondWorktree = path.join(path.dirname(primary), "worktree-two");
  const thirdWorktree = path.join(path.dirname(primary), "worktree-three");
  mkdirSync(secondWorktree);
  mkdirSync(thirdWorktree);
  const lockDir = path.join(primary, ".aios");
  mkdirSync(lockDir);
  writeFileSync(
    path.join(lockDir, "worktree-dependencies.lock"),
    `${JSON.stringify({ pid: 999_999_999, token: "dead-owner" })}\n`
  );
  const worker = hydrationWorker(path.dirname(primary));
  const calls = path.join(path.dirname(primary), "npm-calls");
  const fakeNpm = path.join(path.dirname(primary), "concurrent-install.mjs");
  writeFileSync(
    fakeNpm,
    `import fs from "node:fs";
import path from "node:path";
fs.appendFileSync(process.env.AIOS_TEST_NPM_CALLS, "call\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
const root = process.cwd();
const pkg = path.join(root, "node_modules", "prettier");
fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "prettier", version: "3.9.6", bin: "./bin/prettier.cjs" }));
fs.writeFileSync(path.join(pkg, "bin", "prettier.cjs"), "");
fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
const shim = process.platform === "win32" ? "prettier.cmd" : "prettier";
const shimPath = path.join(root, "node_modules", ".bin", shim);
fs.writeFileSync(shimPath, "");
if (process.platform !== "win32") fs.chmodSync(shimPath, 0o755);
const transitive = path.join(root, "node_modules", "prettier-plugin-test");
fs.mkdirSync(transitive, { recursive: true });
fs.writeFileSync(path.join(transitive, "package.json"), JSON.stringify({ version: "1.0.0" }));
const native = path.join(root, "node_modules", "platform-native-test");
fs.mkdirSync(native, { recursive: true });
fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ version: "1.0.0" }));
`
  );
  const env = {
    ...process.env,
    AIOS_TEST_INSTALL_SCRIPT: fakeNpm,
    AIOS_TEST_NPM_CALLS: calls,
  };
  const args = (target) => [worker, primary, target];
  const first = spawn(process.execPath, args(worktree), {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const second = spawn(process.execPath, args(secondWorktree), {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const third = spawn(process.execPath, args(thirdWorktree), {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const [firstResult, secondResult, thirdResult] = await Promise.all([
    finished(first),
    finished(second),
    finished(third),
  ]);

  assert.deepEqual([firstResult.status, secondResult.status, thirdResult.status], [0, 0, 0]);
  assert.equal(firstResult.stderr + secondResult.stderr + thirdResult.stderr, "");
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 1);
  assertSharedLink(primary, worktree);
  assertSharedLink(primary, secondWorktree);
  assertSharedLink(primary, thirdWorktree);
});
