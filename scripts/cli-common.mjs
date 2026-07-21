/**
 * cli-common.mjs — the single source of truth for the tiny, dependency-free CLI
 * primitives shared across the aios scripts: ANSI colours, `die`, `sha256`,
 * `slugify`, and `gitConfig`.
 *
 * Before AIO-315 these lived (and diverged) in three places: `scripts/aios.mjs`
 * defined its own `c`/`die`/`sha256`/`slugify`/`gitConfig`; `scripts/relay-core.mjs`
 * defined a near-identical `c`/`die`; and `slugify` had three subtly different
 * copies (aios.mjs, build.mjs, loop-config.mjs). This module collapses them so
 * there is exactly one definition of each. `relay-core.mjs` now re-exports `c`/`die`
 * from here, so its existing importers are unaffected.
 *
 * Zero npm dependencies (Node built-ins only) so every `aios` command stays fast
 * and offline at import time.
 */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** ANSI colour helpers. The 6-key superset (includes `bold`, which the old
 *  relay-core copy lacked); the 5 shared keys are byte-identical to both prior copies. */
export const c = {
  red: (s) => `\x1b[0;31m${s}\x1b[0m`,
  green: (s) => `\x1b[0;32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[1;33m${s}\x1b[0m`,
  blue: (s) => `\x1b[0;34m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** Print a red `error: <msg>` to stderr and exit non-zero. */
export function die(msg) {
  console.error(c.red(`error: ${msg}`));
  process.exit(1);
}

/**
 * Thrown (never exits) by the update/pull module family (toolkit-pull.mjs, update.mjs)
 * for every expected failure that used to call `die()` — a dirty toolkit tree, a
 * non-fast-forward branch, an unresolved conflict, a bad `--from`, an unknown flag, etc.
 * Lives here (a shared leaf module) rather than in update.mjs so toolkit-pull.mjs can
 * throw it without importing back through update.mjs (which already imports
 * toolkit-pull.mjs) and creating a cycle.
 *
 * Exactly one place — `cmdUpdate`'s outer try/catch — catches this and converts it into
 * a printed message + a non-zero structured result instead of exiting, so
 * `pullToolkitCheckout`/`cmdUpdate` are safely callable in-process by programmatic
 * callers (onboarding) and in tests. Any OTHER thrown error is a genuinely unexpected
 * bug and is deliberately left to propagate to the CLI dispatcher's own catch-all.
 */
export class UpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpdateError";
  }
}

/** Hex SHA-256 of a string/Buffer. */
export function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Turn an arbitrary string into a URL/branch/id-safe slug.
 *
 * Null-safe, lower-cased, non-alphanumerics collapsed to single hyphens, and
 * leading/trailing hyphen *runs* stripped. Options preserve the historical
 * per-caller behaviour that used to be baked into separate copies:
 *   - `maxLen`   — clamp the result to this many chars (branch/worktree names).
 *   - `fallback` — value to return when the slug is empty after stripping.
 * With no options this matches the old loop-config slugify (run-strip, null-safe);
 * `build.mjs` binds `{ maxLen: 40, fallback: "task" }` for branch/worktree names.
 */
export function slugify(s, { maxLen, fallback } = {}) {
  let out = String(s ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (maxLen != null) out = out.slice(0, maxLen);
  if (fallback != null && out === "") out = fallback;
  return out;
}

/**
 * Environment for a git subprocess that must resolve the repository **from its `-C`
 * argument alone** — every repo-redirecting variable removed.
 *
 * `git -C <dir>` does NOT override an inherited `GIT_DIR`/`GIT_WORK_TREE`: with `GIT_DIR`
 * set, `git -C <non-git-dir> rev-parse --show-toplevel` cheerfully answers `<non-git-dir>`
 * (verified), so a containment probe reads as "this dir is its own git toplevel" when it
 * is not a repository at all — a FAIL-OPEN on exactly the gate that exists to stop git
 * operations landing on an unrelated repo. Git exports these itself when it runs a hook,
 * so anything invoking the toolkit from a hook (or `rebase --exec`, `bisect run`, a husky
 * wrapper, some CI harnesses) inherits them without the user ever setting one by hand.
 *
 * Use for EVERY git invocation whose answer is about a specific directory. Deliberately
 * not applied to `git clone` (no repo to resolve) — but harmless there too.
 */
export function gitEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CEILING_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
  ])
    delete env[key];
  return env;
}

/**
 * Canonicalize a path for COMPARISON — resolving symlinks when the path exists, falling
 * back to a plain absolute resolve when it doesn't (a not-yet-created destination is still
 * comparable). Returns `null` for a falsy input so an unset path can never collide with a
 * real one: `path.resolve("")` is the CWD, which would silently compare equal to whatever
 * the process happens to be running in.
 *
 * The one implementation. Containment and identity checks (is this dir its own git
 * toplevel? is this cwd inside the repo?) must agree across macOS `/var` → `/private/var`,
 * worktree symlinks, and `~` expansion, so they cannot each carry their own copy.
 */
export function safeReal(p) {
  if (!p) return null;
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** Read a single git config value for a repo, or "" if unset/unavailable. */
export function gitConfig(repo, key) {
  try {
    return execFileSync("git", ["-C", repo, "config", "--get", key], {
      encoding: "utf8",
      env: gitEnv(),
    }).trim();
  } catch {
    return "";
  }
}

// ── secret scanning (shared patterns) ───────────────────────────────────────
// Single source for scripts/aios.mjs (push/review) AND scripts/promote.mjs (AIO-353) so
// the two never diverge on what counts as a leaked secret. Embedded fallback covers the
// case validation/secret-patterns.txt is unavailable (e.g. run from outside the toolkit).
export const FALLBACK_SECRET_PATTERNS = [
  "AKIA[0-9A-Z]{16}",
  "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----",
  "gh[ps]_[A-Za-z0-9_]{36,}",
  "xox[bporas]-[A-Za-z0-9-]+",
  "sk-[A-Za-z0-9_-]{40,}",
];

/** Load the shared secret-pattern list (validation/secret-patterns.txt), compiled to RegExps. */
export function loadSecretPatterns() {
  const shared = path.join(SCRIPT_DIR, "..", "validation", "secret-patterns.txt");
  let lines = FALLBACK_SECRET_PATTERNS;
  if (existsSync(shared)) {
    lines = readFileSync(shared, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }
  return lines.map((l) => new RegExp(l));
}

/** First matching pattern source in `content`, or null if clean. */
export function findSecret(content, patterns) {
  for (const re of patterns) if (re.test(content)) return re.source;
  return null;
}
