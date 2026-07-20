/**
 * toolkit-test-fixtures.mjs — shared git-repo builders for the toolkit-pull/update test
 * family. Previously each test file (toolkit-pull.test.mjs, update-review-repros.test.mjs,
 * update-safety.test.mjs) reimplemented its own slightly-different `git()`/`initRepo()`/
 * origin+clone helper; this collapses the generic ones into one place. Kept deliberately
 * narrow — bespoke, single-file fixtures (a conflicted toolkit, a behind toolkit with a
 * marker-writing stub CLI) stay local to the test file that needs that exact shape, since
 * forcing them in here would couple unrelated tests for no benefit.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The REAL update.mjs under test — used by originAndToolkitClone's `realEntrypoint` option
// so a spawned --vendor-apply-only child actually runs the code being tested, instead of a
// no-op stub. Resolved from this file's own location so it works regardless of cwd.
const REAL_UPDATE_MODULE = fileURLToPath(new URL("../scripts/update.mjs", import.meta.url));

/** Run git in `dir`; returns trimmed stdout. Throws on non-zero. */
export function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** `git init` + minimal identity config, ready to commit immediately. */
export function initRepo(dir, branch = "main") {
  git(dir, "init", "-q", "-b", branch);
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "t");
}

/** A source repo with one commit, and a clone of it that tracks origin. Generic (not
 *  toolkit-shaped) — for tests exercising plain git-pull mechanics. */
export function originAndClone(root) {
  const origin = path.join(root, "origin");
  const clone = path.join(root, "clone");
  mkdirSync(origin, { recursive: true });
  initRepo(origin);
  writeFileSync(path.join(origin, "f.txt"), "v1\n");
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t.t");
  git(clone, "config", "user.name", "t");
  return { origin, clone };
}

/** A bare-bones TOOLKIT-shaped origin + a tracking clone of it (scaffold/ + scripts/aios.mjs
 *  present, so `looksLikeToolkit` accepts it). `extraOriginFiles` seeds additional
 *  toolkit-repo-relative files (e.g. a MANAGED_PATHS entry) before the initial commit.
 *
 *  `realEntrypoint: true` writes a `scripts/aios.mjs` that actually forwards to the REAL
 *  `cmdUpdate` under test, instead of the default no-op stub — required for any test that
 *  needs a spawned `--vendor-apply-only` child (or any other re-exec) to genuinely run
 *  update.mjs's logic (vendorSafety, the merge, the stamp write, ...) rather than trivially
 *  "succeeding" having done nothing. Tests that only exercise the PARENT process's behavior
 *  before a hand-off (flag validation, --check/--preview, which never spawn) don't need it. */
export function originAndToolkitClone(root, { extraOriginFiles, realEntrypoint = false } = {}) {
  const origin = path.join(root, "origin");
  const clone = path.join(root, "toolkit");
  mkdirSync(path.join(origin, "scaffold"), { recursive: true });
  mkdirSync(path.join(origin, "scripts"), { recursive: true });
  initRepo(origin);
  writeFileSync(path.join(origin, "scaffold", ".keep"), "");
  // Real toolkit checkouts gitignore node_modules; without this, a test that symlinks/creates
  // node_modules for npm-reconcile coverage would make git status report it as an untracked
  // (dirty) path, tripping the source-cleanliness gate for a reason unrelated to what such a
  // test is actually exercising.
  // No trailing slash: a trailing-slash pattern ("node_modules/") only matches a real
  // directory, not a SYMLINK named node_modules (exactly what the npm-reconcile tests need
  // ignored) — git's directory-only pathspec matching doesn't follow symlinks to classify them.
  writeFileSync(path.join(origin, ".gitignore"), "node_modules\n");
  writeFileSync(
    path.join(origin, "scripts", "aios.mjs"),
    realEntrypoint
      ? `import { cmdUpdate } from ${JSON.stringify(REAL_UPDATE_MODULE)};\n` +
          `const args = process.argv.slice(2);\n` +
          `const repoIdx = args.indexOf("--repo");\n` +
          `const repo = repoIdx >= 0 ? args[repoIdx + 1] : process.cwd();\n` +
          `const result = await cmdUpdate(repo, {}, args.slice(1));\n` + // args[0] is "update"
          `process.exitCode = result.exitStatus;\n`
      : "// stub entry\n"
  );
  for (const [rel, body] of Object.entries(extraOriginFiles || {})) {
    mkdirSync(path.dirname(path.join(origin, rel)), { recursive: true });
    writeFileSync(path.join(origin, rel), body);
  }
  git(origin, "add", "-A");
  git(origin, "commit", "-qm", "init");
  execFileSync("git", ["clone", "-q", origin, clone]);
  git(clone, "config", "user.email", "t@t.t");
  git(clone, "config", "user.name", "t");
  return { origin, clone };
}

/** Add a commit to `dir`'s checked-out branch, writing `body` to `file` (default f.txt). */
export function advance(dir, body, file = "f.txt") {
  writeFileSync(path.join(dir, file), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "advance");
}

/** A fresh temp dir under the OS tmpdir, prefixed for easy identification/cleanup. */
export function tmpRoot(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
