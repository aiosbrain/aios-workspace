import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readlinkSync,
  rmSync,
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
      },
    })
  );
  if (installed) installPrettier(primary);
  return { primary, worktree };
}

function installPrettier(primary) {
  const packageDir = path.join(primary, "node_modules", "prettier");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ version: "3.9.6" }));
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

test("forced restore failure exits non-zero and leaves no misleading link", () => {
  const { primary, worktree } = fixture();
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
  assert.equal(existsSync(path.join(worktree, "node_modules")), false);
});
