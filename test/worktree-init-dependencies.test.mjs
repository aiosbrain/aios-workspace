import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
        "node_modules/prettier": { version: "3.9.6", dev: true },
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
  writeFileSync(path.join(binDir, "prettier"), "#!/bin/sh\n");
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
  assertSharedLink(primary, worktree);
});

test("matching root manifest still restores missing binary and transitive packages", () => {
  const { primary, worktree } = fixture();
  const packageDir = path.join(primary, "node_modules", "prettier");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({ name: "prettier", version: "3.9.6", bin: "./bin/prettier.cjs" })
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

test("forced restore failure exits non-zero and leaves no misleading link", () => {
  const { primary, worktree } = fixture();
  symlinkSync(
    path.join(path.dirname(primary), "moved-primary", "node_modules"),
    path.join(worktree, "node_modules"),
    "dir"
  );
  const fakeBin = path.join(path.dirname(primary), "fake-bin");
  mkdirSync(fakeBin);
  const fakeNpm = path.join(fakeBin, "npm");
  writeFileSync(fakeNpm, "#!/bin/sh\nexit 47\n");
  chmodSync(fakeNpm, 0o755);

  const result = spawnSync(
    process.execPath,
    [WORKTREE_INIT, "--primary", primary, "--worktree", worktree],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
    }
  );

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /npm ci could not restore shared dependencies \(exit 47\).*npm ci --include=dev/s
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
  const fakeBin = path.join(path.dirname(primary), "concurrent-bin");
  mkdirSync(fakeBin);
  const calls = path.join(path.dirname(primary), "npm-calls");
  const fakeNpm = path.join(fakeBin, "npm");
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(process.env.AIOS_TEST_NPM_CALLS, "call\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
const root = process.cwd();
const pkg = path.join(root, "node_modules", "prettier");
fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "prettier", version: "3.9.6", bin: "./bin/prettier.cjs" }));
fs.writeFileSync(path.join(pkg, "bin", "prettier.cjs"), "");
fs.mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
fs.writeFileSync(path.join(root, "node_modules", ".bin", "prettier"), "");
const transitive = path.join(root, "node_modules", "prettier-plugin-test");
fs.mkdirSync(transitive, { recursive: true });
fs.writeFileSync(path.join(transitive, "package.json"), JSON.stringify({ version: "1.0.0" }));
const native = path.join(root, "node_modules", "platform-native-test");
fs.mkdirSync(native, { recursive: true });
fs.writeFileSync(path.join(native, "package.json"), JSON.stringify({ version: "1.0.0" }));
`
  );
  chmodSync(fakeNpm, 0o755);
  const env = {
    ...process.env,
    AIOS_TEST_NPM_CALLS: calls,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const args = (target) => [WORKTREE_INIT, "--primary", primary, "--worktree", target];
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
