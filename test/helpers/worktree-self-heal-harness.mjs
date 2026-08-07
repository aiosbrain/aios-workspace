/**
 * Shared fixtures for test/worktree-self-heal.test.mjs (AIO-482).
 *
 * Extracted verbatim from that file so it stays under the 500-line size cap; the
 * behaviour is unchanged. Temp directories are owned here and torn down by the
 * importing suite via `cleanupTmpDirs()` in a `test.after` hook.
 */
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  rmSync,
} from "node:fs";

export const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const SELF_HEAL = path.join(TOOLKIT, "hooks", "worktree-self-heal.mjs");
export const POSTINSTALL = path.join(TOOLKIT, "scripts", "postinstall-banner.mjs");
export const MARKER = path.join(".aios", ".worktree-hydrated");

export const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

const tmpDirs = [];

/** Register a temp dir the suite made itself, so `cleanupTmpDirs` tears it down too. */
export function trackTmpDir(dir) {
  tmpDirs.push(dir);
  return dir;
}

/** Remove every temp dir created by `makePrimary` or `trackTmpDir`. Call from `test.after`. */
export function cleanupTmpDirs() {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
}

/**
 * A minimal stand-in for a primary AIOS checkout: the real hydrator + git hook, a
 * settings.json to copy down, and a node_modules dir to symlink.
 */
export function makePrimary({ withHydrator = true, withLeakGate = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aios-selfheal-"));
  tmpDirs.push(root);
  const repo = path.join(root, "primary");
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  mkdirSync(path.join(repo, "hooks", "git"), { recursive: true });
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  mkdirSync(path.join(repo, "node_modules"), { recursive: true });

  if (withHydrator) {
    const dest = path.join(repo, "scripts", "link-worktree-env.sh");
    copyFileSync(path.join(TOOLKIT, "scripts", "link-worktree-env.sh"), dest);
    chmodSync(dest, 0o755);
    copyFileSync(
      path.join(TOOLKIT, "scripts", "worktree-init.mjs"),
      path.join(repo, "scripts", "worktree-init.mjs")
    );
  }
  if (withLeakGate) {
    copyFileSync(
      path.join(TOOLKIT, "scripts", "leak-gate.sh"),
      path.join(repo, "scripts", "leak-gate.sh")
    );
  }
  writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({ hooks: {} }) + "\n");
  writeFileSync(path.join(repo, "README.md"), "temp\n");

  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { root, repo };
}

export function installPostCheckout(repo) {
  const dest = path.join(repo, ".git", "hooks", "post-checkout");
  copyFileSync(path.join(TOOLKIT, "hooks", "git", "post-checkout"), dest);
  chmodSync(dest, 0o755);
}

/** Run the self-heal hook exactly as Claude Code would: as a subprocess in `cwd`. */
export function runSelfHeal(cwd, env = {}) {
  return spawnSync(process.execPath, [SELF_HEAL], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

export function assertHydrated(wt) {
  assert.ok(existsSync(path.join(wt, MARKER)), "hydration marker written");
  assert.ok(lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), "node_modules symlinked");
  assert.ok(existsSync(path.join(wt, ".claude", "settings.json")), ".claude/settings.json present");
}

/** Capture console.log for the duration of `fn`. */
export function captureLog(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return { result: fn(), out: lines.join("\n") };
  } finally {
    console.log = original;
  }
}
