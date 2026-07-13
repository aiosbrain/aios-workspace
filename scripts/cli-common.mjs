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
import { existsSync, readFileSync } from "node:fs";
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

/** Read a single git config value for a repo, or "" if unset/unavailable. */
export function gitConfig(repo, key) {
  try {
    return execFileSync("git", ["-C", repo, "config", "--get", key], {
      encoding: "utf8",
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
