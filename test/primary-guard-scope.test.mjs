import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { installWorktreeSafetyBackstops } from "../scripts/worktree.mjs";

// The primary-commit guard is a machine-local developer preference, scoped by the
// `protect` / `exempt` lists in ~/.claude/branch-protection.json. It kept landing in a
// scaffolded personal workspace (master-only by design) through the toolkit's automatic
// install paths and blocked every commit its owner made. Contract under test:
//   - the toolkit never installs it automatically;
//   - the installer only installs into a repo listed under `protect`;
//   - the guard only enforces in a listed repo, wherever it happens to be installed.

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_SRC = path.join(TOOLKIT, "hooks", "git", "pre-commit-primary-guard");
const INSTALLER = path.join(TOOLKIT, "scripts", "install-primary-commit-guard.sh");

const roots = [];
test.after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A sandbox with its own HOME, a repo inside it, and an optional scope config. */
function sandbox({ config } = {}) {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "aios-guard-scope-")));
  roots.push(home);
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(path.join(repo, "note.md"), "hello\n");
  git("add", "-A");

  const configPath = path.join(home, ".claude", "branch-protection.json");
  if (config) {
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config(repo)));
  }
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" };
  delete env.AIOS_ALLOW_PRIMARY_COMMIT;
  delete env.AIOS_BRANCH_PROTECTION_CONFIG;
  return { home, repo, env };
}

function installGuardByHand(repo) {
  const dest = path.join(repo, ".git", "hooks", "pre-commit");
  copyFileSync(GUARD_SRC, dest);
  chmodSync(dest, 0o755);
}

function commit({ repo, env }) {
  return spawnSync("git", ["-C", repo, "commit", "-q", "-m", "work"], { encoding: "utf8", env });
}

function install({ repo, env }) {
  return execFileSync("/bin/bash", [INSTALLER], { cwd: repo, encoding: "utf8", env });
}

const hooked = (repo) => existsSync(path.join(repo, ".git", "hooks", "pre-commit"));

// ── installer ────────────────────────────────────────────────────────────────

test("installer installs into a repo listed under protect", () => {
  const sb = sandbox({ config: (repo) => ({ mode: "opt-in", protect: [repo] }) });
  install(sb);
  assert.ok(hooked(sb.repo));
});

test("installer refuses a repo that is not listed", () => {
  const sb = sandbox({ config: () => ({ mode: "opt-in", protect: ["/somewhere/else"] }) });
  assert.match(install(sb), /not listed under "protect"/);
  assert.ok(!hooked(sb.repo));
});

test("installer refuses when there is no scope config at all", () => {
  const sb = sandbox();
  assert.match(install(sb), /not listed under "protect"/);
  assert.ok(!hooked(sb.repo));
});

test("installer: exempt wins over protect", () => {
  const sb = sandbox({ config: (repo) => ({ protect: [repo], exempt: [repo] }) });
  install(sb);
  assert.ok(!hooked(sb.repo));
});

test("installer honours ~ in protect entries", () => {
  const sb = sandbox({ config: () => ({ protect: ["~/repo"] }) });
  install(sb);
  assert.ok(hooked(sb.repo));
});

// ── guard at run time (however it got installed) ─────────────────────────────

test("guard blocks a primary-checkout commit in a protected repo", () => {
  const sb = sandbox({ config: (repo) => ({ protect: [repo] }) });
  installGuardByHand(sb.repo);
  const r = commit(sb);
  assert.notEqual(r.status, 0, "a protected primary checkout must be blocked");
  assert.match(r.stderr, /commit BLOCKED in the PRIMARY checkout/);
});

test("guard lets an unlisted repo commit, e.g. a personal workspace", () => {
  const sb = sandbox({ config: () => ({ protect: ["/somewhere/else"] }) });
  installGuardByHand(sb.repo);
  const r = commit(sb);
  assert.equal(r.status, 0, `commit was blocked:\n${r.stderr}`);
});

test("guard lets an exempt repo commit, even in opt-out mode", () => {
  const sb = sandbox({ config: (repo) => ({ mode: "opt-out", exempt: [repo] }) });
  installGuardByHand(sb.repo);
  assert.equal(commit(sb).status, 0);
});

test("guard with no scope config blocks nothing", () => {
  const sb = sandbox();
  installGuardByHand(sb.repo);
  assert.equal(commit(sb).status, 0);
});

test("guard with a malformed scope config blocks nothing", () => {
  const sb = sandbox({ config: () => ({}) });
  writeFileSync(path.join(sb.home, ".claude", "branch-protection.json"), "{not json");
  installGuardByHand(sb.repo);
  assert.equal(commit(sb).status, 0);
});

test("guard out of scope still runs the hook it chains to", () => {
  const sb = sandbox();
  installGuardByHand(sb.repo);
  const marker = path.join(sb.repo, ".git", "chained-ran");
  const chained = path.join(sb.repo, ".git", "hooks", "pre-commit.chained");
  writeFileSync(chained, `#!/usr/bin/env bash\necho ran > "${marker}"\nexit 0\n`);
  chmodSync(chained, 0o755);
  assert.equal(commit(sb).status, 0);
  assert.equal(readFileSync(marker, "utf8").trim(), "ran");
});

// ── the toolkit never installs it automatically ──────────────────────────────

test("installWorktreeSafetyBackstops never writes the commit guard, even in the product repo", () => {
  const sb = sandbox({ config: (repo) => ({ protect: [repo] }) });
  mkdirSync(path.join(sb.repo, "scripts"));
  writeFileSync(path.join(sb.repo, "scripts", "leak-gate.sh"), "#!/bin/sh\nexit 0\n");
  const res = installWorktreeSafetyBackstops(sb.repo, { quiet: true });
  assert.ok(!("primaryCommit" in res));
  assert.ok(!hooked(sb.repo));
});
