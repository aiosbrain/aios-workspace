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
  symlinkSync,
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

test("guard: exempt wins over protect", () => {
  const sb = sandbox({ config: (repo) => ({ protect: [repo], exempt: [repo] }) });
  installGuardByHand(sb.repo);
  assert.equal(commit(sb).status, 0);
});

test("guard: there is no protect-everything mode — opt-out with no protect list blocks nothing", () => {
  const sb = sandbox({ config: () => ({ mode: "opt-out" }) });
  installGuardByHand(sb.repo);
  assert.equal(commit(sb).status, 0);
});

test("guard: a protect entry does not match a sibling that merely shares its prefix", () => {
  // `<home>/rep` must not cover `<home>/repo` (cf. aios-workspace vs aios-workspace-gui).
  const sb = sandbox({ config: (repo) => ({ protect: [repo.slice(0, -1)] }) });
  installGuardByHand(sb.repo);
  assert.equal(commit(sb).status, 0);
});

test("guard blocks a primary commit made through a symlinked path", () => {
  const sb = sandbox({ config: (repo) => ({ protect: [repo] }) });
  installGuardByHand(sb.repo);
  const link = path.join(sb.home, "link");
  symlinkSync(sb.home, link);
  const viaLink = path.join(link, "repo");
  const r = spawnSync("git", ["commit", "-q", "-m", "work"], {
    cwd: viaLink,
    encoding: "utf8",
    env: { ...sb.env, PWD: viaLink },
  });
  assert.notEqual(r.status, 0, "a symlinked cwd must not look like a linked worktree");
  assert.match(r.stderr, /commit BLOCKED in the PRIMARY checkout/);
});

test("guard honours a protect entry written through a symlink", () => {
  const sb = sandbox({
    config: (repo) => ({ protect: [path.join(path.dirname(repo), "link", "repo")] }),
  });
  symlinkSync(sb.home, path.join(sb.home, "link"));
  installGuardByHand(sb.repo);
  assert.notEqual(commit(sb).status, 0);
});

test("guard with HOME unset blocks nothing and does not crash", () => {
  const sb = sandbox({ config: (repo) => ({ protect: [repo] }) });
  installGuardByHand(sb.repo);
  const env = { ...sb.env };
  delete env.HOME;
  const r = spawnSync("git", ["-C", sb.repo, "commit", "-q", "-m", "work"], {
    encoding: "utf8",
    env,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /unbound variable/);
});

test("installer run from a linked worktree of a protected repo installs; worktree commits pass", () => {
  const sb = sandbox({ config: (repo) => ({ protect: [repo] }) });
  const git = (...args) =>
    execFileSync("git", ["-C", sb.repo, ...args], { stdio: "pipe", env: sb.env });
  git("commit", "-q", "-m", "init");
  const wt = path.join(sb.home, "repo-worktrees", "task");
  git("worktree", "add", "-q", "-b", "task", wt);
  install({ repo: wt, env: sb.env });
  assert.ok(hooked(sb.repo), "guard lands in the shared hooks dir");

  writeFileSync(path.join(wt, "wt.md"), "x\n");
  execFileSync("git", ["-C", wt, "add", "-A"], { env: sb.env });
  assert.equal(commit({ repo: wt, env: sb.env }).status, 0, "worktree commits are the point");

  writeFileSync(path.join(sb.repo, "primary.md"), "x\n");
  git("add", "-A");
  assert.notEqual(commit(sb).status, 0, "the primary stays blocked");
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

test("aios onboard in a scaffolded workspace hydrates post-checkout but never the commit guard", async () => {
  const { cmdOnboard } = await import("../scripts/onboard-command.mjs");
  const sb = sandbox({ config: (repo) => ({ protect: [repo] }) });
  writeFileSync(path.join(sb.repo, "aios.yaml"), "owner: test\n");
  const log = console.log;
  console.log = () => {};
  try {
    await cmdOnboard(sb.repo, {}, [], { connectFlow: () => {}, nextAction: () => "" });
  } finally {
    console.log = log;
  }
  assert.ok(existsSync(path.join(sb.repo, ".git", "hooks", "post-checkout")));
  assert.ok(!hooked(sb.repo));
});
