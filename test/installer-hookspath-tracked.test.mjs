/**
 * installer-hookspath-tracked.test.mjs — AIO-638: the hook installers must not
 * clobber TRACKED policy hooks in a `core.hooksPath` repo.
 *
 * aios-team-brain (PR #459) tracks its policy hooks under `.githooks/`
 * (core.hooksPath=.githooks); each tracked hook carries a line-anchored
 * `# aios-tracked-hook` marker and chains the machine-local hook of the same
 * name from `$(git rev-parse --git-common-dir)/hooks/`. Before this fix, every
 * `aios worktree add` resolved the destination via core.hooksPath and OVERWROTE
 * the tracked hook with an untracked copy — dirtying the checkout and breaking
 * the NDA chain the tracked hook provides.
 *
 * Contract under test:
 *   - tracked marker at the destination  → tracked file stays byte-identical,
 *     the machine-local hook is installed into `<common-dir>/hooks/` (the chain
 *     target), pre-existing local hooks are preserved via the existing chaining
 *     convention, and a one-line notice is printed;
 *   - hooksPath WITHOUT the marker       → legacy behavior (install into the
 *     hooksPath dir) is kept exactly;
 *   - no hooksPath                       → legacy behavior;
 *   - re-runs are idempotent;
 *   - the `aios worktree add` path (installWorktreeSafetyBackstops) exercises
 *     the same logic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installWorktreeSafetyBackstops } from "../scripts/worktree.mjs";

const TOOLKIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_INSTALLER = path.join(TOOLKIT, "scripts", "install-primary-commit-guard.sh");
const PUSH_INSTALLER = path.join(TOOLKIT, "scripts", "install-leak-gate-push-hook.sh");
const PRODUCT_MODE_STATE = "pre-push-leak-gate.product-mode";
const HARNESS_INSTALLER = path.join(
  TOOLKIT,
  ".harness",
  "hooks",
  "git",
  "install-primary-commit-guard.sh"
);

// Hermetic git: a user's global core.hooksPath or hook templates must not leak in.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
delete GIT_ENV.AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE;

const roots = [];
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A tracked, chain-only policy hook in team-brain's convention: line-anchored
 *  marker + chain the machine-local hook from the git COMMON dir (skipping a
 *  marker-carrying target), never blocking. */
function trackedHookSource(name) {
  return [
    "#!/usr/bin/env bash",
    `# aios-tracked-hook: ${name} — tracked policy hook (fixture)`,
    "set -uo pipefail",
    'common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"',
    'if [[ -n "$common_dir" && "$common_dir" != /* ]]; then',
    '  common_dir="$(cd "$common_dir" 2>/dev/null && pwd -P || echo "$common_dir")"',
    "fi",
    `local_hook="$common_dir/hooks/${name}"`,
    'if [[ -n "$common_dir" && -x "$local_hook" ]] && ! grep -q "^# aios-tracked-hook" "$local_hook" 2>/dev/null; then',
    '  "$local_hook" "$@" || exit $?',
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Disposable fixture repo. `hooksPath` turns on core.hooksPath; `tracked` names
 * the hooks stamped into the hooksPath dir with the tracked marker.
 */
function makeRepo({ hooksPath = null, tracked = [] } = {}) {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-hookspath-"));
  roots.push(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "config", "user.email", "t@example.com"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "config", "user.name", "t"], { env: GIT_ENV });

  const scriptsDir = path.join(repo, "scripts");
  mkdirSync(scriptsDir, { recursive: true });
  writeFileSync(path.join(scriptsDir, "leak-gate.sh"), "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(path.join(scriptsDir, "leak-gate.sh"), 0o755);
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "-A"], { env: GIT_ENV });
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"], { env: GIT_ENV });

  let hooksDir = path.join(repo, ".git", "hooks");
  if (hooksPath) {
    execFileSync("git", ["-C", repo, "config", "core.hooksPath", hooksPath], { env: GIT_ENV });
    hooksDir = path.join(repo, hooksPath);
    mkdirSync(hooksDir, { recursive: true });
    for (const name of tracked) {
      writeFileSync(path.join(hooksDir, name), trackedHookSource(name));
      chmodSync(path.join(hooksDir, name), 0o755);
    }
    if (tracked.length > 0) {
      // the policy hooks are TRACKED — that is the whole point
      execFileSync("git", ["-C", repo, "add", hooksPath], { env: GIT_ENV });
      execFileSync("git", ["-C", repo, "commit", "-q", "-m", "track policy hooks"], {
        env: GIT_ENV,
      });
    }
  }
  const commonHooksDir = path.join(repo, ".git", "hooks");
  mkdirSync(commonHooksDir, { recursive: true });
  return { repo, hooksDir, commonHooksDir };
}

function run(installer, repo, env = {}) {
  const res = spawnSync("bash", [installer], {
    cwd: repo,
    encoding: "utf8",
    env: { ...GIT_ENV, ...env },
  });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  return res;
}

// ── (a) tracked marker → byte-identical tracked hook, install into common dir ──

test("tracked pre-commit hook stays byte-identical; guard lands in the common dir", () => {
  const { repo, hooksDir, commonHooksDir } = makeRepo({
    hooksPath: ".githooks",
    tracked: ["pre-commit"],
  });
  const trackedBefore = readFileSync(path.join(hooksDir, "pre-commit"));

  const res = run(GUARD_INSTALLER, repo);

  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-commit")), trackedBefore);
  const guard = readFileSync(path.join(commonHooksDir, "pre-commit"), "utf8");
  assert.match(guard, /pre-commit-primary-guard/);
  assert.match(res.stdout, /tracked pre-commit hook .* installing machine-local guard/);
  // the tracked checkout must stay CLEAN — the observed failure was a dirtied .githooks/
  const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(status.trim(), "");
});

test("tracked pre-push hook stays byte-identical; gate lands in the common dir", () => {
  const { repo, hooksDir, commonHooksDir } = makeRepo({
    hooksPath: ".githooks",
    tracked: ["pre-push"],
  });
  const trackedBefore = readFileSync(path.join(hooksDir, "pre-push"));

  const res = run(PUSH_INSTALLER, repo);

  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-push")), trackedBefore);
  const gate = readFileSync(path.join(commonHooksDir, "pre-push"), "utf8");
  assert.match(gate, /pre-push-leak-gate/);
  assert.equal(readFileSync(path.join(commonHooksDir, PRODUCT_MODE_STATE), "utf8"), "0\n");
  assert.ok(!existsSync(path.join(hooksDir, PRODUCT_MODE_STATE)));
  assert.match(res.stdout, /tracked pre-push hook .* installing machine-local gate/);
});

test("tracked case preserves a pre-existing machine-local hook via the chaining convention", () => {
  const { repo, hooksDir, commonHooksDir } = makeRepo({
    hooksPath: ".githooks",
    tracked: ["pre-commit"],
  });
  const localHook = path.join(commonHooksDir, "pre-commit");
  writeFileSync(localHook, "#!/usr/bin/env bash\nprintf 'chained\\n' >> \"$CHAIN_MARKER\"\n");
  chmodSync(localHook, 0o755);

  run(GUARD_INSTALLER, repo);

  assert.match(readFileSync(localHook, "utf8"), /pre-commit-primary-guard/);
  assert.ok(existsSync(path.join(commonHooksDir, "pre-commit.chained")));

  // End-to-end: the TRACKED hook chains the machine-local guard, which (in a
  // linked worktree, where it no-ops) execs the preserved local hook.
  const wt = path.join(repo, "..", `${path.basename(repo)}-wt`);
  roots.push(wt);
  execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "core.hooksPath=/dev/null",
      "worktree",
      "add",
      "-q",
      "-b",
      "task",
      wt,
      "main",
    ],
    { env: GIT_ENV }
  );
  const marker = path.join(repo, "chain-ran");
  const res = spawnSync(path.join(hooksDir, "pre-commit"), [], {
    cwd: wt,
    encoding: "utf8",
    env: { ...GIT_ENV, CHAIN_MARKER: marker },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(marker, "utf8"), "chained\n");
});

// ── (b) hooksPath WITHOUT the marker → legacy behavior, exactly ──────────────

test("hooksPath without the marker keeps the legacy install into the hooksPath dir", () => {
  const { repo, hooksDir, commonHooksDir } = makeRepo({ hooksPath: ".githooks" });
  // includes the marker text, but NOT line-anchored — must not trigger the redirect
  writeFileSync(
    path.join(hooksDir, "pre-commit"),
    "#!/usr/bin/env bash\n  # aios-tracked-hook (indented: not a tracked policy hook)\nexit 0\n"
  );
  chmodSync(path.join(hooksDir, "pre-commit"), 0o755);

  run(GUARD_INSTALLER, repo);
  run(PUSH_INSTALLER, repo);

  assert.match(readFileSync(path.join(hooksDir, "pre-commit"), "utf8"), /pre-commit-primary-guard/);
  assert.ok(existsSync(path.join(hooksDir, "pre-commit.chained")));
  assert.match(readFileSync(path.join(hooksDir, "pre-push"), "utf8"), /pre-push-leak-gate/);
  assert.equal(readFileSync(path.join(commonHooksDir, PRODUCT_MODE_STATE), "utf8"), "0\n");
  assert.ok(!existsSync(path.join(hooksDir, PRODUCT_MODE_STATE)));
  assert.ok(!existsSync(path.join(commonHooksDir, "pre-commit")));
  assert.ok(!existsSync(path.join(commonHooksDir, "pre-push")));
});

// ── (c) no hooksPath → legacy behavior ───────────────────────────────────────

test("no hooksPath keeps the legacy install into .git/hooks", () => {
  const { repo, commonHooksDir } = makeRepo();

  run(GUARD_INSTALLER, repo);
  run(PUSH_INSTALLER, repo);

  assert.match(
    readFileSync(path.join(commonHooksDir, "pre-commit"), "utf8"),
    /pre-commit-primary-guard/
  );
  assert.match(readFileSync(path.join(commonHooksDir, "pre-push"), "utf8"), /pre-push-leak-gate/);
  assert.equal(readFileSync(path.join(commonHooksDir, PRODUCT_MODE_STATE), "utf8"), "0\n");
});

test("installer accepts exact explicit mode 0 and rejects every invalid explicit mode", () => {
  const { repo, commonHooksDir } = makeRepo();
  run(PUSH_INSTALLER, repo, { AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE: "0" });
  assert.equal(readFileSync(path.join(commonHooksDir, PRODUCT_MODE_STATE), "utf8"), "0\n");

  for (const invalid of ["", "2", " 1", "1 ", "true"]) {
    const fixture = makeRepo();
    const result = spawnSync("bash", [PUSH_INSTALLER], {
      cwd: fixture.repo,
      encoding: "utf8",
      env: { ...GIT_ENV, AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE: invalid },
    });
    assert.notEqual(result.status, 0, `invalid override ${JSON.stringify(invalid)} must abort`);
    assert.match(result.stderr, /must be exactly 0 or 1/i);
    assert.equal(
      existsSync(path.join(fixture.commonHooksDir, PRODUCT_MODE_STATE)),
      false,
      "invalid override must not persist state"
    );
    assert.equal(
      existsSync(path.join(fixture.commonHooksDir, "pre-push")),
      false,
      "invalid override must not install a hook"
    );
  }
});

// ── (d) idempotent re-run ────────────────────────────────────────────────────

test("re-running both installers in the tracked case is idempotent", () => {
  const { repo, hooksDir, commonHooksDir } = makeRepo({
    hooksPath: ".githooks",
    tracked: ["pre-commit", "pre-push"],
  });
  const trackedCommit = readFileSync(path.join(hooksDir, "pre-commit"));
  const trackedPush = readFileSync(path.join(hooksDir, "pre-push"));

  run(GUARD_INSTALLER, repo);
  run(PUSH_INSTALLER, repo);
  const guardAfterFirst = readFileSync(path.join(commonHooksDir, "pre-commit"));
  const gateAfterFirst = readFileSync(path.join(commonHooksDir, "pre-push"));

  run(GUARD_INSTALLER, repo);
  run(PUSH_INSTALLER, repo);

  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-commit")), trackedCommit);
  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-push")), trackedPush);
  assert.deepEqual(readFileSync(path.join(commonHooksDir, "pre-commit")), guardAfterFirst);
  assert.deepEqual(readFileSync(path.join(commonHooksDir, "pre-push")), gateAfterFirst);
  // the guard must not have been preserved as its own chain target
  assert.ok(!existsSync(path.join(commonHooksDir, "pre-commit.chained")));
  assert.ok(!existsSync(path.join(hooksDir, "pre-commit.chained")));
  assert.equal(readFileSync(path.join(commonHooksDir, PRODUCT_MODE_STATE), "utf8"), "0\n");
  assert.deepEqual(
    readdirSync(commonHooksDir).filter((name) =>
      name.startsWith(".pre-push-leak-gate.product-mode.")
    ),
    [],
    "atomic installs must not leave partial state siblings"
  );
});

test("reinstall promotes detected product mode and never downgrades a validated mode 1", () => {
  const { repo, commonHooksDir } = makeRepo();
  run(PUSH_INSTALLER, repo);
  const state = path.join(commonHooksDir, PRODUCT_MODE_STATE);
  assert.equal(readFileSync(state, "utf8"), "0\n");

  mkdirSync(path.join(repo, "scaffold"));
  run(PUSH_INSTALLER, repo);
  assert.equal(readFileSync(state, "utf8"), "1\n");
  assert.equal(
    execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf8",
      env: GIT_ENV,
    }).trim(),
    "",
    "the machine-local mode state must not dirty the worktree"
  );

  rmSync(path.join(repo, "scaffold"), { recursive: true, force: true });
  run(PUSH_INSTALLER, repo);
  assert.equal(readFileSync(state, "utf8"), "1\n");
  run(PUSH_INSTALLER, repo, { AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE: "0" });
  assert.equal(readFileSync(state, "utf8"), "1\n");
});

test("reinstall refuses malformed prior mode state instead of guessing or overwriting", () => {
  const { repo, commonHooksDir } = makeRepo();
  run(PUSH_INSTALLER, repo);
  const state = path.join(commonHooksDir, PRODUCT_MODE_STATE);
  writeFileSync(state, "invalid\n");

  const result = spawnSync("bash", [PUSH_INSTALLER], {
    cwd: repo,
    encoding: "utf8",
    env: GIT_ENV,
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /product-mode state.*malformed/i);
  assert.match(result.stderr, /refusing to overwrite/i);
  assert.equal(readFileSync(state, "utf8"), "invalid\n");
});

// ── (e) the `aios worktree add` path exercises the same logic ────────────────

test("installWorktreeSafetyBackstops (aios worktree add path) leaves tracked hooks untouched", () => {
  const { repo, hooksDir, commonHooksDir } = makeRepo({
    hooksPath: ".githooks",
    tracked: ["pre-commit", "pre-push"],
  });
  const trackedCommit = readFileSync(path.join(hooksDir, "pre-commit"));
  const trackedPush = readFileSync(path.join(hooksDir, "pre-push"));

  const result = installWorktreeSafetyBackstops(repo, { quiet: true });

  assert.equal(result.primaryCommit, "installed");
  assert.equal(result.prePush, "installed");
  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-commit")), trackedCommit);
  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-push")), trackedPush);
  assert.match(
    readFileSync(path.join(commonHooksDir, "pre-commit"), "utf8"),
    /pre-commit-primary-guard/
  );
  assert.match(readFileSync(path.join(commonHooksDir, "pre-push"), "utf8"), /pre-push-leak-gate/);
  const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(status.trim(), "");
});

// ── the stamped .harness installer (repo-bootstrap targets) ──────────────────

test("harness installer: tracked pre-commit redirects per hook; unmarked names keep legacy dir", () => {
  const { repo, hooksDir, commonHooksDir } = makeRepo({
    hooksPath: ".githooks",
    tracked: ["pre-commit"],
  });
  const trackedBefore = readFileSync(path.join(hooksDir, "pre-commit"));

  const res = run(HARNESS_INSTALLER, repo);

  // marker-carrying pre-commit: untouched; guard machine-local in the common dir
  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-commit")), trackedBefore);
  assert.match(
    readFileSync(path.join(commonHooksDir, "pre-commit"), "utf8"),
    /pre-commit-primary-guard/
  );
  assert.match(res.stdout, /tracked pre-commit hook .* installing machine-local guard/);
  // hook names WITHOUT a tracked counterpart keep the legacy hooksPath install
  assert.match(
    readFileSync(path.join(hooksDir, "pre-merge-commit"), "utf8"),
    /pre-commit-primary-guard/
  );
  assert.match(
    readFileSync(path.join(hooksDir, "reference-transaction"), "utf8"),
    /reference-transaction-strand-guard/
  );
  // Machine-local hooks that must live in a tracked hooksPath directory are
  // excluded through the repository-local info/exclude file. They remain
  // executable without leaving the policy checkout dirty.
  const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], {
    encoding: "utf8",
    env: GIT_ENV,
  });
  assert.equal(status.trim(), "");
  const ignored = execFileSync(
    "git",
    ["-C", repo, "check-ignore", ".githooks/pre-merge-commit", ".githooks/reference-transaction"],
    { encoding: "utf8", env: GIT_ENV }
  );
  assert.deepEqual(ignored.trim().split("\n").sort(), [
    ".githooks/pre-merge-commit",
    ".githooks/reference-transaction",
  ]);

  // idempotent re-run: everything byte-identical, no chain files sprouting
  const guardAfterFirst = readFileSync(path.join(commonHooksDir, "pre-commit"));
  run(HARNESS_INSTALLER, repo);
  assert.deepEqual(readFileSync(path.join(hooksDir, "pre-commit")), trackedBefore);
  assert.deepEqual(readFileSync(path.join(commonHooksDir, "pre-commit")), guardAfterFirst);
  assert.ok(!existsSync(path.join(commonHooksDir, "pre-commit.chained")));
});
