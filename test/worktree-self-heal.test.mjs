/**
 * AIO-482 — worktree auto-hydration for tools that never call `aios worktree add`
 * (Conductor et al). T1–T6 cover the spec's automated acceptance section end-to-end
 * (subprocess + real git hooks); T7–T11 pin the same units' return contracts in-process.
 *
 * Every case runs against a REAL temp git repo (no mocks): the whole point is that
 * hydration survives a vanilla `git worktree add` performed by someone else.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  lstatSync,
  realpathSync,
  rmSync,
  readFileSync,
} from "node:fs";

import { MANAGED_PATHS, SEED_IF_ABSENT } from "../scripts/toolkit-manifest.mjs";
import {
  cmdWorktree,
  installPostCheckoutHook,
  installWorktreeSafetyBackstops,
  postCheckoutHookPath,
} from "../scripts/worktree.mjs";
import {
  findHydrator,
  selfHeal,
  MARKER as SELF_HEAL_MARKER,
} from "../hooks/worktree-self-heal.mjs";
import {
  TOOLKIT,
  POSTINSTALL,
  MARKER,
  git,
  cleanupTmpDirs,
  trackTmpDir,
  makePrimary,
  installPostCheckout,
  runSelfHeal,
  assertHydrated,
  captureLog,
} from "./helpers/worktree-self-heal-harness.mjs";

test.after(cleanupTmpDirs);

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
  trackTmpDir(notGit);
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

// ── T7: installPostCheckoutHook — the three outcomes, in-process ───────────────
test("T7: installPostCheckoutHook reports installed → present, and skips with no hooks dir", () => {
  const { root, repo } = makePrimary();

  const first = captureLog(() => installPostCheckoutHook(repo, { quiet: true }));
  assert.equal(first.result, "installed");
  assert.match(first.out, /installed post-checkout hook/, "a new install is announced even quiet");
  assert.ok(existsSync(postCheckoutHookPath(repo)), "hook landed in the common dir");

  // Second call is byte-identical → idempotent no-op, and silent under `quiet`.
  const second = captureLog(() => installPostCheckoutHook(repo, { quiet: true }));
  assert.equal(second.result, "present");
  assert.equal(second.out, "", "an already-present hook stays silent when quiet");

  // Non-quiet reports the same state on stdout.
  const loud = captureLog(() => installPostCheckoutHook(repo, {}));
  assert.equal(loud.result, "present");
  assert.match(loud.out, /already installed/);

  // A directory with no .git/hooks is a skip, never a throw.
  const bare = path.join(root, "not-a-repo");
  mkdirSync(bare, { recursive: true });
  assert.equal(installPostCheckoutHook(bare, { quiet: true }), "skipped");
});

test("T7b: worktree install-hook installs the primary and pre-push safety backstops", async () => {
  const { repo } = makePrimary();

  await cmdWorktree(repo, {}, ["install-hook"]);

  assert.match(
    readFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "utf8"),
    /pre-commit-primary-guard/
  );
  assert.match(
    readFileSync(path.join(repo, ".git", "hooks", "pre-push"), "utf8"),
    /pre-push-leak-gate/
  );
});

test("T7c: worktree install-hook reports backstop installer failures without throwing", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "aios-selfheal-not-git-"));
  trackTmpDir(repo);
  mkdirSync(path.join(repo, "scripts"), { recursive: true });
  copyFileSync(
    path.join(TOOLKIT, "scripts", "leak-gate.sh"),
    path.join(repo, "scripts", "leak-gate.sh")
  );

  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await cmdWorktree(repo, {}, ["install-hook"]);
  } finally {
    console.log = original;
  }

  assert.match(lines.join("\n"), /primary-commit-guard install failed \(non-fatal\)/);
  assert.match(lines.join("\n"), /leak-gate push hook install failed \(non-fatal\)/);
});

test("T7d: worktree init hydrates the shared safety backstops", async () => {
  const { root, repo } = makePrimary();
  const wt = path.join(root, "linked-init");
  git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "task-init", wt, "main");

  await cmdWorktree(repo, {}, ["init", "--dir", wt]);

  assert.match(
    readFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "utf8"),
    /pre-commit-primary-guard/
  );
  assert.match(
    readFileSync(path.join(repo, ".git", "hooks", "pre-push"), "utf8"),
    /pre-push-leak-gate/
  );
});

test("postinstall hydrates backstops for a fresh product-repository clone", () => {
  const { repo } = makePrimary();

  execFileSync(process.execPath, [POSTINSTALL], {
    cwd: repo,
    env: { ...process.env, CI: "1" },
    stdio: "pipe",
  });

  assert.match(
    readFileSync(path.join(repo, ".git", "hooks", "pre-commit"), "utf8"),
    /pre-commit-primary-guard/
  );
  assert.match(
    readFileSync(path.join(repo, ".git", "hooks", "pre-push"), "utf8"),
    /pre-push-leak-gate/
  );
});

test("onboard and update invoke product-only safety hydration", () => {
  // The apply steps moved with the AIO-635 split: checkout applies live in
  // update/vendor-apply.mjs, registry applies in update/registry-root.mjs.
  for (const rel of [
    "scripts/onboard-command.mjs",
    "scripts/update/vendor-apply.mjs",
    "scripts/update/registry-root.mjs",
  ]) {
    const source = readFileSync(path.join(TOOLKIT, rel), "utf8");
    assert.match(
      source,
      /installWorktreeSafetyBackstops\(repo,\s*\{\s*quiet:\s*true,\s*productOnly:\s*true\s*\}\)/,
      rel
    );
  }
});

test("product-only lifecycle hydration leaves personal-workspace commit and push policy unchanged", () => {
  const { repo } = makePrimary({ withLeakGate: false });

  installWorktreeSafetyBackstops(repo, { quiet: true, productOnly: true });

  assert.ok(existsSync(path.join(repo, ".git", "hooks", "post-checkout")));
  assert.ok(!existsSync(path.join(repo, ".git", "hooks", "pre-commit")));
  assert.ok(!existsSync(path.join(repo, ".git", "hooks", "pre-push")));
});

// This previously asserted an explicit `aios worktree install-hook` DID install the
// pre-commit guard here, on the theory that invoking worktree tooling opts you into
// worktree policy. It does not: a harness runs worktree commands against whatever repo it
// is pointed at, and the workspace OWNER is left unable to commit on master — that repo's
// documented workflow. Toolkit policy is now never injected into a scaffolded workspace by
// any path. The product-repo counterpart lives in test/worktree.test.mjs.
test("a personal workspace receives no toolkit commit or push policy, even from an explicit worktree command", async () => {
  const { repo } = makePrimary({ withLeakGate: false });

  await cmdWorktree(repo, {}, ["install-hook"]);

  assert.ok(existsSync(path.join(repo, ".git", "hooks", "post-checkout")));
  assert.ok(!existsSync(path.join(repo, ".git", "hooks", "pre-commit")));
  assert.ok(!existsSync(path.join(repo, ".git", "hooks", "pre-push")));
});

// ── T8: postCheckoutHookPath resolves the SHARED common dir from a worktree ────
test("T8: postCheckoutHookPath resolves hooks from the common dir, not <worktree>/.git", () => {
  const { root, repo } = makePrimary();
  const wt = path.join(root, "linked");
  git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "task8", wt, "main");

  // Inside a linked worktree `.git` is a FILE, so a naive join would name a path that
  // can never exist and silently report "no hook installed" for a repo that has one.
  // Compare through realpath: on macOS the tmpdir is a /var → /private/var symlink, and
  // git hands back an already-resolved absolute common dir for a linked worktree.
  installPostCheckoutHook(repo, { quiet: true });
  assert.equal(
    realpathSync(postCheckoutHookPath(wt)),
    realpathSync(postCheckoutHookPath(repo)),
    "worktree and primary agree on one shared hook path"
  );
  assert.ok(existsSync(postCheckoutHookPath(wt)), "the worktree sees the primary's hook");

  // Not a git repo at all → conventional <dir>/.git/hooks/post-checkout, no throw.
  const bare = path.join(root, "plain-dir");
  mkdirSync(bare, { recursive: true });
  assert.equal(postCheckoutHookPath(bare), path.join(bare, ".git", "hooks", "post-checkout"));
});

// ── T9: `aios worktree doctor` reports the three layers ───────────────────────
test("T9: worktree doctor reports 'not wired' then 'ready' as layers land", async () => {
  const { repo } = makePrimary();

  // Nothing installed: no post-checkout hook, no SessionStart entry, no .conductor.
  let captured = [];
  const original = console.log;
  console.log = (...args) => captured.push(args.join(" "));
  try {
    await cmdWorktree(repo, {}, ["doctor"]);
  } finally {
    console.log = original;
  }
  let out = captured.join("\n");
  assert.match(out, /Conductor support: not wired/);
  assert.match(out, /post-checkout hook installed/);

  // Land all three layers, then re-report.
  installPostCheckoutHook(repo, { quiet: true });
  writeFileSync(
    path.join(repo, ".claude", "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "${CLAUDE_PROJECT_DIR}/hooks/worktree-self-heal.mjs" },
            ],
          },
        ],
      },
    }) + "\n"
  );
  mkdirSync(path.join(repo, ".conductor"), { recursive: true });
  writeFileSync(path.join(repo, ".conductor", "settings.toml"), '[scripts]\nsetup = "true"\n');

  captured = [];
  console.log = (...args) => captured.push(args.join(" "));
  try {
    await cmdWorktree(repo, {}, ["doctor"]);
  } finally {
    console.log = original;
  }
  out = captured.join("\n");
  assert.match(out, /Conductor support: ready/);
  assert.doesNotMatch(out, /not wired/);
});

// ── T10: selfHeal's return contract, in-process (each skip reason + failure) ───
test("T10: selfHeal returns a typed status for every branch, and never throws", () => {
  const { root, repo } = makePrimary();

  assert.deepEqual(selfHeal(path.join(root, "nowhere-at-all")), {
    status: "skipped",
    reason: "not a git repo",
  });
  assert.equal(selfHeal(repo).status, "skipped", "the primary checkout is never hydrated");
  assert.equal(selfHeal(repo).reason, "primary checkout");

  const wt = path.join(root, "wt10");
  git(repo, "-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", "task10", wt, "main");
  assert.equal(selfHeal(wt).status, "hydrated");
  assert.deepEqual(selfHeal(wt), { status: "skipped", reason: "already hydrated" });

  // A hydrator that exits non-zero is reported as `failed`, never thrown. The worktree
  // checks out its own copy of scripts/, which findHydrator prefers over the primary's,
  // so the failing stub has to replace THAT one.
  rmSync(path.join(wt, SELF_HEAL_MARKER));
  writeFileSync(
    path.join(wt, "scripts", "link-worktree-env.sh"),
    "#!/usr/bin/env bash\necho 'boom' >&2\nexit 3\n"
  );
  const failed = selfHeal(wt);
  assert.equal(failed.status, "failed");
  assert.match(failed.reason, /boom/);
});

// ── T11: findHydrator's candidate order ───────────────────────────────────────
test("T11: findHydrator prefers the worktree, then primary, then AIOS_TOOLKIT_DIR", () => {
  const { root, repo } = makePrimary();
  const elsewhere = path.join(root, "toolkit-elsewhere");
  mkdirSync(path.join(elsewhere, "scripts"), { recursive: true });
  writeFileSync(path.join(elsewhere, "scripts", "link-worktree-env.sh"), "#!/bin/sh\n");

  // The primary carries a hydrator (makePrimary copies the real one).
  assert.equal(
    findHydrator(path.join(root, "no-such-worktree"), repo),
    path.join(repo, "scripts", "link-worktree-env.sh")
  );

  // With no local and no primary hydrator, AIOS_TOOLKIT_DIR is the next candidate.
  const previous = process.env.AIOS_TOOLKIT_DIR;
  process.env.AIOS_TOOLKIT_DIR = elsewhere;
  try {
    rmSync(path.join(repo, "scripts", "link-worktree-env.sh"));
    assert.equal(
      findHydrator(path.join(root, "no-such-worktree"), repo),
      path.join(elsewhere, "scripts", "link-worktree-env.sh")
    );
    delete process.env.AIOS_TOOLKIT_DIR;
    assert.equal(findHydrator(path.join(root, "no-such-worktree"), repo), null, "no candidate");
  } finally {
    if (previous === undefined) delete process.env.AIOS_TOOLKIT_DIR;
    else process.env.AIOS_TOOLKIT_DIR = previous;
  }
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
