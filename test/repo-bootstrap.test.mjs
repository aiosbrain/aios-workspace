// AIO-602 — `aios repo-bootstrap`: the one authoritative governance-stamp path for the
// multi-repo split (aios-workspace-gui, aios-devtools).
//
// The acceptance test from the epic runs in a throwaway repo under os.tmpdir() — far from
// this checkout, with NO adjacent core checkout — and proves the stamped repo guards
// itself: a primary-checkout commit is BLOCKED while `git worktree add -b feat/x
// <sibling> origin/main` + a commit inside the worktree both work.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyTransform, renderTemplate, runBootstrap } from "../scripts/repo-bootstrap/engine.mjs";
import { isSameGitRepo } from "../scripts/repo-bootstrap.mjs";
import {
  BOOTSTRAP_MANAGED,
  BOOTSTRAP_SEED_IF_ABSENT,
  BOOTSTRAP_VERSION,
  BOOTSTRAP_VERSION_FILE,
} from "../scripts/repo-bootstrap/manifest.mjs";

const TOOLKIT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(TOOLKIT, "scripts", "aios.mjs");
const PARAMS = { REPO_NAME: "t", LINT_SCRIPT: "lint", TEST_SCRIPT: "test", BOOTSTRAP_VERSION };
const PRODUCT_MODE_STATE = "pre-push-leak-gate.product-mode";

// Hermetic git: no global/system config (a user's core.hooksPath or hooks templateDir
// would poison the guard-install assertions), and none of the guard override vars.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  AIOS_ALLOW_PRIMARY_COMMIT: "",
  HARNESS_ALLOW_PRIMARY_COMMIT: "",
  AIOS_ALLOW_PRIMARY_CHECKOUT: "",
  HARNESS_ALLOW_PRIMARY_CHECKOUT: "",
  AIOS_TOOLKIT_DIR: "",
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.AIOS_LEAK_GATE_INSTALL_PRODUCT_MODE;

function git(dir, args, opts = {}) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV, ...opts });
}

function gitOk(dir, args) {
  const r = git(dir, args);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

const gitOkRaw = (dir, args) => gitOk(dir, args).trim();

/** A throwaway target repo with one pushed commit on main (origin = local bare repo). */
function makeTarget() {
  const base = mkdtempSync(path.join(tmpdir(), "repo-bootstrap-"));
  const target = path.join(base, "target");
  execFileSync("git", ["init", "-q", "-b", "main", target], { env: GIT_ENV });
  gitOk(target, ["config", "user.email", "t@example.com"]);
  gitOk(target, ["config", "user.name", "bootstrap test"]);
  gitOk(target, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(target, "README.md"), "# target\n");
  gitOk(target, ["add", "-A"]);
  gitOk(target, ["commit", "-qm", "init"]);
  const remote = path.join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote], { env: GIT_ENV });
  gitOk(target, ["remote", "add", "origin", remote]);
  gitOk(target, ["push", "-qu", "origin", "main"]);
  return { base, target };
}

function stamp(target, extra = {}) {
  return runBootstrap({ toolkitDir: TOOLKIT, targetDir: target, params: PARAMS, ...extra });
}

function readStamp(target) {
  return JSON.parse(readFileSync(path.join(target, BOOTSTRAP_VERSION_FILE), "utf8"));
}

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [AIOS, "repo-bootstrap", ...args], {
    encoding: "utf8",
    env: GIT_ENV,
    cwd: tmpdir(),
    ...opts,
  });
}

// ── unit: fail-closed primitives ─────────────────────────────────────────────

test("applyTransform flips the commit-policy default to strict, and fails closed on drift", () => {
  const src = readFileSync(
    path.join(TOOLKIT, ".harness/hooks/git/pre-commit-primary-guard"),
    "utf8"
  );
  const out = applyTransform("strict-commit-policy", src);
  assert.match(out, /HARNESS_PRIMARY_COMMIT_POLICY:-strict/);
  assert.doesNotMatch(out, /HARNESS_PRIMARY_COMMIT_POLICY:-default-ok/);
  // Anchor missing (upstream drifted) => abort, never ship weaker semantics silently.
  assert.throws(() => applyTransform("strict-commit-policy", "no anchor here"), /anchor not found/);
  assert.throws(() => applyTransform("nope", "x"), /unknown transform/);
});

test("renderTemplate substitutes params and refuses unresolved placeholders", () => {
  assert.equal(renderTemplate("run {{LINT_SCRIPT}}", { LINT_SCRIPT: "lint" }), "run lint");
  assert.throws(() => renderTemplate("{{MISSING}}", {}), /unresolved template placeholder/);
});

// ── stamp + re-run + drift ───────────────────────────────────────────────────

test("bootstrap stamps every manifest file, records the version stamp, and re-runs idempotently", () => {
  const { base, target } = makeTarget();
  try {
    const first = stamp(target);
    for (const e of [...BOOTSTRAP_MANAGED, ...BOOTSTRAP_SEED_IF_ABSENT]) {
      assert.ok(existsSync(path.join(target, e.dest)), `missing ${e.dest}`);
      if (e.exec) {
        const mode = statSync(path.join(target, e.dest)).mode & 0o111;
        assert.ok(mode !== 0, `${e.dest} should be executable`);
      }
    }
    assert.equal(first.created.length, BOOTSTRAP_MANAGED.length);
    assert.equal(first.seeded.length, BOOTSTRAP_SEED_IF_ABSENT.length);

    const meta = readStamp(target);
    assert.equal(meta.bootstrapVersion, BOOTSTRAP_VERSION);
    assert.match(meta.toolkitSha, /^[0-9a-f]{40}$/);
    assert.ok(meta.stampedAt);
    for (const e of BOOTSTRAP_MANAGED)
      assert.match(meta.files[e.dest] ?? "", /^sha256:[0-9a-f]{64}$/, `no hash for ${e.dest}`);

    // Parameterized seeds actually substituted.
    const ci = readFileSync(path.join(target, ".github/workflows/ci.yml"), "utf8");
    assert.match(ci, /npm run lint --if-present/);
    assert.match(ci, /npm run test --if-present/);
    assert.doesNotMatch(ci, /\{\{[A-Z_]+\}\}/);

    // leak-gate-remediation-plan.md §5.1 item 4: a newly generated repo must never carry a
    // secret-bearing PR scanner. Not "no leak-gate secret" — NO secret expression at all.
    assert.doesNotMatch(
      ci,
      /\$\{\{[^}]*\bsecrets\s*[.[]/,
      "the seeded CI must reference no Actions secret"
    );
    assert.doesNotMatch(
      ci,
      /AIOS_LEAK_TERMS_B64/,
      "the seeded CI must not reinstate the term-corpus secret"
    );
    // ...and it must satisfy the workflow policy it ships, judged by the real gate.
    const gate = spawnSync(
      "node",
      [
        path.join(TOOLKIT, "scripts/check-workflow-policy.mjs"),
        "--dir",
        path.join(target, ".github/workflows"),
        "--allowlist",
        path.join(target, "scripts/workflow-policy-allowlist.json"),
      ],
      { encoding: "utf8" }
    );
    assert.equal(gate.status, 0, `${gate.stdout}${gate.stderr}`);

    // Strict transform landed in the stamped guard.
    const guard = readFileSync(
      path.join(target, ".harness/hooks/git/pre-commit-primary-guard"),
      "utf8"
    );
    assert.match(guard, /HARNESS_PRIMARY_COMMIT_POLICY:-strict/);

    // Re-run: everything unchanged, no writes beyond the refreshed stamp, no .aios-incoming.
    const second = stamp(target);
    assert.equal(second.created.length + second.updated.length + second.conflicts.length, 0);
    assert.equal(second.unchanged.length, BOOTSTRAP_MANAGED.length);
    assert.equal(second.seedKept.length, BOOTSTRAP_SEED_IF_ABSENT.length);
    const leftovers = BOOTSTRAP_MANAGED.filter((e) =>
      existsSync(path.join(target, e.dest + ".aios-incoming"))
    );
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("drift: a local edit is kept (+ reported), --check exits 1, --force restores canon", () => {
  const { base, target } = makeTarget();
  try {
    stamp(target);
    const edited = path.join(target, ".harness/hooks/guard-worktree.sh");
    const local = readFileSync(edited, "utf8") + "\n# local tweak\n";
    writeFileSync(edited, local);

    // Plain re-run: keep-mine — file preserved, drift surfaced, base hash retained.
    const rerun = stamp(target);
    assert.deepEqual(rerun.keptLocal, [".harness/hooks/guard-worktree.sh"]);
    assert.equal(readFileSync(edited, "utf8"), local);

    // --check via the CLI: exit 1, and still no writes.
    const check = runCli([target, "--check"]);
    assert.equal(check.status, 1, check.stdout + check.stderr);
    assert.match(check.stdout, /kept local edit/);
    assert.equal(readFileSync(edited, "utf8"), local);

    // --force: canonical copy restored, hash re-recorded, next --check is clean.
    const forced = stamp(target, { force: true });
    assert.deepEqual(forced.forced, [".harness/hooks/guard-worktree.sh"]);
    assert.doesNotMatch(readFileSync(edited, "utf8"), /# local tweak/);
    assert.equal(runCli([target, "--check"]).status, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("conflict (both sides changed) surfaces <file>.aios-incoming and never clobbers", () => {
  const { base, target } = makeTarget();
  try {
    stamp(target);
    // Simulate "source changed since the recorded base" by rewriting the recorded hash,
    // and "local edit" by editing the file: base ≠ mine ≠ theirs → merge → surfaced.
    const dest = "scripts/check-file-size.mjs";
    const abs = path.join(target, dest);
    const local = readFileSync(abs, "utf8") + "// local\n";
    writeFileSync(abs, local);
    const meta = readStamp(target);
    meta.files[dest] = "sha256:" + "0".repeat(64);
    writeFileSync(path.join(target, BOOTSTRAP_VERSION_FILE), JSON.stringify(meta));

    const rerun = stamp(target);
    assert.deepEqual(rerun.conflicts, [dest]);
    assert.equal(readFileSync(abs, "utf8"), local, "local file must be untouched");
    const incoming = abs + ".aios-incoming";
    assert.ok(existsSync(incoming));
    assert.equal(
      readFileSync(incoming, "utf8"),
      readFileSync(path.join(TOOLKIT, dest), "utf8"),
      "incoming carries the canonical source"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("SEED_IF_ABSENT never overwrites an existing file (even --force), but refills a missing one", () => {
  const { base, target } = makeTarget();
  try {
    stamp(target);
    const constitution = path.join(target, "ENGINEERING-CONSTITUTION.md");
    const caps = path.join(target, "scripts/size-caps.json");
    writeFileSync(constitution, "# mine now\n");
    writeFileSync(caps, '{ "defaultCap": 123, "include": [], "exclude": [], "grandfathered": {} }');

    const rerun = stamp(target, { force: true });
    assert.equal(readFileSync(constitution, "utf8"), "# mine now\n");
    assert.match(readFileSync(caps, "utf8"), /123/);
    assert.ok(rerun.seedKept.includes("ENGINEERING-CONSTITUTION.md"));
    assert.equal(rerun.seeded.length, 0);

    unlinkSync(path.join(target, ".github/workflows/ci.yml"));
    const refill = stamp(target);
    assert.deepEqual(refill.seeded, [".github/workflows/ci.yml"]);
    assert.ok(existsSync(path.join(target, ".github/workflows/ci.yml")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── CLI validation ───────────────────────────────────────────────────────────

test("CLI refuses to stamp any checkout of the toolkit repo — direct, symlinked, or sibling", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-bootstrap-self-"));
  try {
    // A symlinked route to the same checkout (~/Tessera-style) is still a self-stamp:
    // both sides are realpath'd before comparing, so the alias cannot dodge the refusal.
    const link = path.join(dir, "toolkit-alias");
    symlinkSync(TOOLKIT, link);
    const candidates = [TOOLKIT, link];
    // The PRIMARY checkout of this same repo (a different directory, same common git
    // dir) — the case found live via ~/Tessera: realpath equality alone missed it.
    const commonDir = gitOkRaw(TOOLKIT, ["rev-parse", "--git-common-dir"]);
    const primary = path.dirname(path.resolve(TOOLKIT, commonDir));
    if (existsSync(path.join(primary, "scripts", "repo-bootstrap.mjs"))) candidates.push(primary);
    for (const target of candidates) {
      // --check: belt-and-suspenders — if the refusal ever regressed, this test must
      // not stamp a real toolkit checkout as a side effect.
      const r = runCli([target, "--check"]);
      assert.equal(r.status, 1, `${target}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /refusing to stamp a checkout of the toolkit repository/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isSameGitRepo: true for a primary + its linked worktree, false for unrelated repos", () => {
  const { base, target } = makeTarget();
  try {
    const wt = path.join(base, "wt");
    gitOk(target, ["worktree", "add", "-q", "--detach", wt]);
    assert.equal(isSameGitRepo(target, wt), true);
    assert.equal(isSameGitRepo(wt, target), true);
    assert.equal(isSameGitRepo(target, TOOLKIT), false);
    assert.equal(isSameGitRepo(path.join(base, "does-not-exist"), target), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("CLI rejects a non-git dir and a non-root path", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "repo-bootstrap-nogit-"));
  try {
    const r = runCli([dir]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ROOT of a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const { base, target } = makeTarget();
  try {
    const sub = path.join(target, "sub");
    mkdirSync(sub);
    const r = runCli([sub]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /repo root is/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── the epic's acceptance: self-guarding with NO adjacent core checkout ──────

test("acceptance: primary commit BLOCKED; worktree add -b feat/x origin/main + commit inside works", () => {
  const { base, target } = makeTarget();
  try {
    // Stamp via the real CLI (descriptor + offline resolution path included).
    const stampRun = runCli([target]);
    assert.equal(stampRun.status, 0, stampRun.stdout + stampRun.stderr);

    // 1. A primary-checkout commit is BLOCKED — on main, fail-closed.
    gitOk(target, ["add", "-A"]);
    const blocked = git(target, ["commit", "-qm", "should be blocked"]);
    assert.notEqual(blocked.status, 0, "primary commit must be blocked");
    assert.match(blocked.stderr, /PRIMARY checkout/);

    // 2. Branch creation in the primary is blocked too (strand guard, parse-free).
    const branch = git(target, ["checkout", "-q", "-b", "feat/should-fail"]);
    assert.notEqual(branch.status, 0, "primary checkout -b must be blocked");

    // 3. The sanctioned override commits the stamp so origin/main can carry it.
    const override = git(target, ["commit", "-qm", "chore: governance stamp"], {
      env: { ...GIT_ENV, AIOS_ALLOW_PRIMARY_COMMIT: "1" },
    });
    assert.equal(override.status, 0, override.stderr);
    gitOk(target, ["push", "-q", "origin", "main"]);

    // 4. `git worktree add -b feat/x <sibling> origin/main` works…
    const wt = path.join(base, "target-worktrees", "x");
    const add = git(target, ["worktree", "add", "-b", "feat/x", wt, "origin/main"]);
    assert.equal(add.status, 0, add.stderr);
    // …and the stamped post-checkout hook self-hydrated it (no core checkout involved).
    assert.ok(existsSync(path.join(wt, ".aios", ".worktree-hydrated")), "hydration marker");

    // 5. A commit INSIDE the worktree is allowed.
    writeFileSync(path.join(wt, "feature.txt"), "hello\n");
    gitOk(wt, ["add", "feature.txt"]);
    const wtCommit = git(wt, ["commit", "-qm", "feat: inside worktree"]);
    assert.equal(wtCommit.status, 0, wtCommit.stderr);

    // 6. The stamped gates run clean inside the target, standalone.
    for (const gate of ["scripts/check-file-size.mjs", "scripts/check-boundaries.mjs"]) {
      const r = spawnSync(process.execPath, [path.join(target, gate)], {
        cwd: target,
        encoding: "utf8",
        env: GIT_ENV,
      });
      assert.equal(r.status, 0, `${gate}: ${r.stdout}${r.stderr}`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("repo-bootstrap installs product mode in a split repo with no scaffold and blocks product paths", () => {
  const { base, target } = makeTarget();
  try {
    const originalRemoteHead = gitOkRaw(target, ["rev-parse", "origin/main"]);
    const stampRun = runCli([target]);
    assert.equal(stampRun.status, 0, stampRun.stdout + stampRun.stderr);
    assert.equal(
      existsSync(path.join(target, "scaffold")),
      false,
      "split repo fixture has no scaffold"
    );

    const commonDir = gitOkRaw(target, ["rev-parse", "--git-common-dir"]);
    const modeState = path.join(path.resolve(target, commonDir), "hooks", PRODUCT_MODE_STATE);
    assert.equal(readFileSync(modeState, "utf8"), "1\n");

    mkdirSync(path.join(target, "docs", "bd"), { recursive: true });
    writeFileSync(path.join(target, "docs", "bd", "prospect.md"), "synthetic prospect\n");
    gitOk(target, ["add", "-A"]);
    const commit = git(target, ["commit", "-qm", "test: split product forbidden path"], {
      env: { ...GIT_ENV, AIOS_ALLOW_PRIMARY_COMMIT: "1" },
    });
    assert.equal(commit.status, 0, commit.stderr);

    const push = git(target, ["push", "origin", "main"], {
      env: { ...GIT_ENV, AIOS_LEAK_TERMS_FILE: "/nonexistent-terms-file" },
    });
    assert.notEqual(push.status, 0, "product-only forbidden paths must be blocked");
    assert.match(push.stderr, /confidential material/i);
    assert.equal(
      gitOkRaw(target, ["ls-remote", "origin", "refs/heads/main"]).split("\t")[0],
      originalRemoteHead
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
