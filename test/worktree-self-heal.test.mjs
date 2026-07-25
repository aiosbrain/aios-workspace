/**
 * AIO-482 — worktree auto-hydration for tools that never call `aios worktree add`
 * (Conductor et al). T1–T5 from the spec's automated acceptance section.
 *
 * Every case runs against a REAL temp git repo (no mocks): the whole point is that
 * hydration survives a vanilla `git worktree add` performed by someone else.
 */
import { test } from "node:test";
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
  readFileSync,
} from "node:fs";

import { MANAGED_PATHS, SEED_IF_ABSENT } from "../scripts/toolkit-manifest.mjs";

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF_HEAL = path.join(TOOLKIT, "hooks", "worktree-self-heal.mjs");
const MARKER = path.join(".aios", ".worktree-hydrated");

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

const tmpDirs = [];
test.after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A minimal stand-in for a primary AIOS checkout: the real hydrator + git hook, a
 * settings.json to copy down, and a node_modules dir to symlink.
 */
function makePrimary({ withHydrator = true } = {}) {
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

function installPostCheckout(repo) {
  const dest = path.join(repo, ".git", "hooks", "post-checkout");
  copyFileSync(path.join(TOOLKIT, "hooks", "git", "post-checkout"), dest);
  chmodSync(dest, 0o755);
}

/** Run the self-heal hook exactly as Claude Code would: as a subprocess in `cwd`. */
function runSelfHeal(cwd, env = {}) {
  return spawnSync(process.execPath, [SELF_HEAL], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function assertHydrated(wt) {
  assert.ok(existsSync(path.join(wt, MARKER)), "hydration marker written");
  assert.ok(lstatSync(path.join(wt, "node_modules")).isSymbolicLink(), "node_modules symlinked");
  assert.ok(existsSync(path.join(wt, ".claude", "settings.json")), ".claude/settings.json present");
}

// ── T1: a Conductor-style worktree — plain `git worktree add`, no aios wrapper ──
test("T1: a worktree created by a plain `git worktree add` is fully hydrated", () => {
  const { repo } = makePrimary();
  installPostCheckout(repo);
  const wt = path.join(path.dirname(repo), "conductor-workspace");

  git(repo, "worktree", "add", "-b", "task", wt, "main");

  assertHydrated(wt);
});

// ── T2: hooks suppressed (the Option-B-fails case) — SessionStart still heals ────
test("T2: with git hooks suppressed, the SessionStart hook hydrates the worktree", () => {
  const { repo } = makePrimary();
  installPostCheckout(repo);
  const wt = path.join(path.dirname(repo), "no-hooks-workspace");

  git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "task2", wt, "main");
  assert.ok(!existsSync(path.join(wt, MARKER)), "precondition: post-checkout did not run");

  const r = runSelfHeal(wt);
  assert.equal(r.status, 0, r.stderr);
  assertHydrated(wt);
});

// ── T3: idempotent — a second session start is a silent no-op ───────────────────
test("T3: re-running the hook on a hydrated worktree is a silent no-op", () => {
  const { repo } = makePrimary();
  const wt = path.join(path.dirname(repo), "again-workspace");
  git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "task3", wt, "main");

  assert.equal(runSelfHeal(wt).status, 0);
  const before = lstatSync(path.join(wt, MARKER)).mtimeMs;

  const second = runSelfHeal(wt);
  assert.equal(second.status, 0);
  assert.equal(second.stdout, "", "no output on the no-op path");
  assert.equal(lstatSync(path.join(wt, MARKER)).mtimeMs, before, "marker not rewritten");
});

// ── T4: never blocks a session ─────────────────────────────────────────────────
test("T4: the hook exits 0 in the primary, outside git, and with no hydrator", () => {
  const { repo } = makePrimary();
  const inPrimary = runSelfHeal(repo);
  assert.equal(inPrimary.status, 0);
  assert.ok(!existsSync(path.join(repo, MARKER)), "primary checkout is never 'hydrated'");

  const notGit = mkdtempSync(path.join(os.tmpdir(), "aios-selfheal-nogit-"));
  tmpDirs.push(notGit);
  assert.equal(runSelfHeal(notGit).status, 0);

  const bare = makePrimary({ withHydrator: false });
  const wt = path.join(path.dirname(bare.repo), "no-hydrator-workspace");
  git(bare.repo, "worktree", "add", "-b", "task4", wt, "main");
  const r = runSelfHeal(wt, { AIOS_TOOLKIT_DIR: path.join(bare.root, "does-not-exist") });
  assert.equal(r.status, 0, "unreachable hydrator is a skip, not a failure");
  assert.ok(!existsSync(path.join(wt, MARKER)));
});

// ── T6: a scaffolded workspace has no local hydrator — resolve the toolkit ─────
test("T6: post-checkout hydrates a scaffolded workspace via the sibling toolkit", () => {
  // A scaffolded workspace vendors only the `aios` shim, so `scripts/link-worktree-env.sh`
  // lives in a sibling toolkit checkout. Without that fallback the hook no-ops in exactly
  // the repos Conductor users open.
  const { root, repo: toolkit } = makePrimary();
  const workspace = path.join(root, "aios-workspace");
  // Rename the fixture into the canonical sibling name the hook looks for, then build a
  // hydrator-less "workspace" repo beside it.
  const ws = path.join(root, "my-workspace");
  mkdirSync(path.join(ws, ".claude"), { recursive: true });
  writeFileSync(path.join(ws, ".claude", "settings.json"), JSON.stringify({ hooks: {} }) + "\n");
  writeFileSync(path.join(ws, "README.md"), "workspace\n");
  git(ws, "init", "-q", "-b", "main");
  git(ws, "config", "user.email", "t@example.com");
  git(ws, "config", "user.name", "t");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "init");
  installPostCheckout(ws);
  assert.ok(!existsSync(path.join(ws, "scripts", "link-worktree-env.sh")), "no local hydrator");

  // `<primary>/../aios-workspace` is the first sibling candidate the hook tries.
  execFileSync("mv", [toolkit, workspace]);

  const wt = path.join(root, "conductor-workspace");
  git(ws, "worktree", "add", "-b", "task6", wt, "main");

  assert.ok(existsSync(path.join(wt, MARKER)), "hydrated from the sibling toolkit checkout");
});

// ── T5: the adapter is actually wired + shipped ────────────────────────────────
test("T5: the self-heal hook is wired into SessionStart and shipped by the manifest", () => {
  const scaffold = JSON.parse(
    readFileSync(path.join(TOOLKIT, "scaffold", ".claude", "settings.json"), "utf8")
  );
  const wired = (scaffold.hooks?.SessionStart ?? []).some((g) =>
    (g.hooks ?? []).some((h) => String(h.command ?? "").includes("worktree-self-heal.mjs"))
  );
  assert.ok(wired, "scaffold/.claude/settings.json wires SessionStart → worktree-self-heal.mjs");

  assert.ok(
    MANAGED_PATHS.some((e) => e.dest === "hooks/worktree-self-heal.mjs"),
    "the hook is MANAGED so `aios update` delivers it to existing workspaces"
  );
  assert.ok(
    SEED_IF_ABSENT.some((e) => e.dest === ".conductor/settings.toml"),
    "Conductor's own setup-script config is seeded, never force-overwritten"
  );
});
