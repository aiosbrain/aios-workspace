import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

// The primary-commit guard is toolkit policy. A scaffolded personal workspace
// (`.aios-toolkit-version` at its root) is master-only by design, and #540 only closed
// the JS install paths: the guard kept reappearing in a workspace whenever something ran
// the bash installer from inside it or copied the hook by hand, and then blocked every
// commit its owner made. These tests pin both layers: the installer refuses, and the
// guard no-ops at run time even when it does land.

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_SRC = path.join(TOOLKIT, "hooks", "git", "pre-commit-primary-guard");
const INSTALLER = path.join(TOOLKIT, "scripts", "install-primary-commit-guard.sh");

function makeRepo({ scaffolded }) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-primary-guard-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  if (scaffolded) writeFileSync(path.join(dir, ".aios-toolkit-version"), "toolkit-version 0.0.0\n");
  writeFileSync(path.join(dir, "note.md"), "hello\n");
  git("add", "-A");
  return dir;
}

function installGuardByHand(dir) {
  const dest = path.join(dir, ".git", "hooks", "pre-commit");
  copyFileSync(GUARD_SRC, dest);
  chmodSync(dest, 0o755);
}

function commit(dir) {
  const env = { ...process.env };
  delete env.AIOS_ALLOW_PRIMARY_COMMIT;
  return spawnSync("git", ["-C", dir, "commit", "-q", "-m", "work"], { encoding: "utf8", env });
}

test("installer refuses to install the guard into a scaffolded workspace", () => {
  const dir = makeRepo({ scaffolded: true });
  try {
    const out = execFileSync("/bin/bash", [INSTALLER], { cwd: dir, encoding: "utf8" });
    assert.match(out, /scaffolded AIOS workspace/);
    assert.equal(existsSync(path.join(dir, ".git", "hooks", "pre-commit")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a guard that lands in a scaffolded workspace anyway lets the owner commit on the primary", () => {
  const dir = makeRepo({ scaffolded: true });
  try {
    installGuardByHand(dir);
    const r = commit(dir);
    assert.equal(r.status, 0, `commit was blocked:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /commit BLOCKED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in a scaffolded workspace the guard still runs the hook it chains to", () => {
  const dir = makeRepo({ scaffolded: true });
  try {
    installGuardByHand(dir);
    const marker = path.join(dir, ".git", "chained-ran");
    const chained = path.join(dir, ".git", "hooks", "pre-commit.chained");
    writeFileSync(chained, `#!/usr/bin/env bash\necho ran > "${marker}"\nexit 0\n`);
    chmodSync(chained, 0o755);
    assert.equal(commit(dir).status, 0);
    assert.equal(readFileSync(marker, "utf8").trim(), "ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the product repo primary checkout is still blocked", () => {
  const dir = makeRepo({ scaffolded: false });
  try {
    execFileSync("/bin/bash", [INSTALLER], { cwd: dir, stdio: "pipe" });
    const r = commit(dir);
    assert.notEqual(r.status, 0, "a primary-checkout commit in a product repo must be blocked");
    assert.match(r.stderr, /commit BLOCKED in the PRIMARY checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
