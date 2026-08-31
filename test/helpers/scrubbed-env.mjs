// test/helpers/scrubbed-env.mjs — AIO-1028: one place that makes connector-surface tests
// independent of ambient credentials.
//
// The failure class this ends: direnv loads the Tessera env cascade on `cd`, so every
// developer shell carries real LINEAR_API_KEY / AIOS_API_KEY / GRANOLA_API_KEY /
// OPENAI_API_KEY / DOTENV_* values. dotenvx (`get`, `run`) and resolveBrainConfig both
// prefer the ambient environment over the on-disk fixture, so a test that writes a temp
// .env + .env.keys and asserts on the fixture value instead receives the developer's real
// key — deterministically failing wherever credentials exist and passing in CI, where the
// bug is invisible. Worse, the assertion diff printed the real key.
//
// Three tools, one file:
//   1. scrubEnv(base)             — a child environment with every credential-shaped or
//                                   AIOS/provider/dotenvx/workspace-root variable removed.
//   2. scrubAmbientProcessEnv()   — same removal applied to process.env itself (for tests
//                                   that call resolver code in-process); returns a restore fn.
//   3. assertSecretEqual(...)     — strict equality whose failure output is REDACTED: only
//                                   sha256 fingerprints ever reach a log or reporter.
//
// Negative-control seam: scrubEnv(base, { disableScrub: true }) returns the environment
// UNSCRUBBED. It exists only so tests can prove their decoy assertions actually depend on
// the scrubber (see test/scrubbed-env-helper.test.mjs and the decoy control in
// test/brain-config-dotenvx.test.mjs). Never use it outside a negative control.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Prefixes: every AIOS_* (includes workspace-root vars like AIOS_TOOLKIT_DIR /
// AIOS_AGENT_WORKSPACE / AIOS_WS), the provider families the connector surface touches,
// dotenvx keypair material (DOTENV_PRIVATE_KEY, DOTENV_PUBLIC_KEY and any per-environment
// DOTENV_PRIVATE_KEY_<ENV> variant), and direnv bookkeeping.
export const SCRUB_PREFIXES = [
  "AIOS_",
  "LINEAR_",
  "SLACK_",
  "BRAIN_",
  "GRANOLA_",
  "DOTENV_",
  "DIRENV_",
];

// Suffixes: any other provider credential the cascade exports (OPENAI_API_KEY was the one
// that made the AIO-790 mixed-key test nondeterministic: with it ambient, `dotenvx run`
// never needs to decrypt the sibling ciphertext, so the WRONG_PRIVATE_KEY warning the test
// asserts on simply doesn't fire).
export const SCRUB_SUFFIXES = [
  "_API_KEY",
  "_API_TOKEN",
  "_TOKEN",
  "_SECRET",
  "_SECRET_KEY",
  "_PRIVATE_KEY",
  "_PUBLIC_KEY",
  "_ACCESS_KEY",
  "_PASSWORD",
];

export const SCRUB_EXACT = new Set(["DATABASE_URL", "DOTENV_KEY"]);

/** True when a variable must not leak from the ambient shell into a fixture assertion. */
export function isScrubbedName(name) {
  if (SCRUB_EXACT.has(name)) return true;
  if (SCRUB_PREFIXES.some((p) => name.startsWith(p))) return true;
  return SCRUB_SUFFIXES.some((s) => name.endsWith(s));
}

/**
 * Build an explicit child environment from `base` (default process.env) with every
 * scrubbed variable removed. A test that needs a named synthetic value passes it in `add`
 * — nothing ambient survives implicitly.
 *
 * `disableScrub` is the negative-control seam documented above.
 */
export function scrubEnv(base = process.env, { disableScrub = false, add = {} } = {}) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!disableScrub && isScrubbedName(name)) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(add)) {
    if (typeof value === "string") registerSecretSentinel(value);
    env[name] = value;
  }
  return env;
}

/**
 * Apply the same scrub to process.env itself, for tests that exercise resolver code
 * in-process (resolveBrainConfig / vaultGet / granolaAuthPath all read process.env or
 * spawn children that inherit it). Call once at module load — node's test runner gives
 * each test file its own process, so this cannot bleed into other files.
 * Returns a restore() that puts the removed variables back exactly.
 */
export function scrubAmbientProcessEnv() {
  const removed = {};
  for (const name of Object.keys(process.env)) {
    if (!isScrubbedName(name)) continue;
    removed[name] = process.env[name];
    if (typeof removed[name] === "string") registerSecretSentinel(removed[name]);
    delete process.env[name];
  }
  return function restore() {
    for (const [name, value] of Object.entries(removed)) process.env[name] = value;
  };
}

// ── redaction ──────────────────────────────────────────────────────────────────────────
//
// Failure output for credential-shaped values must never print the value — neither a real
// ambient key that leaked past the scrubber, nor a synthetic sentinel (a sentinel in a log
// teaches people to ignore secret-shaped strings in logs). Values are reduced to a sha256
// fingerprint: still distinguishes "got the decoy" from "got the fixture" without printing
// either.

const SENTINELS = new Set();

/** Register a synthetic secret so redact() always strips it from any message. */
export function registerSecretSentinel(value) {
  if (typeof value === "string" && value.length >= 6) SENTINELS.add(value);
}

// Credential-shaped values recognizable without registration (the shapes this repo's
// fixtures and the real cascade both use).
const SECRET_SHAPES = /\b(?:lin_api|aios_k|xox[a-z]|sk-[A-Za-z0-9]|ghp_|grn_)[A-Za-z0-9_-]{4,}/g;

/** A stable, non-reversible stand-in for a secret value. */
export function fingerprint(value) {
  if (value === undefined) return "«undefined»";
  if (value === null) return "«null»";
  const s = String(value);
  if (s === "") return "«empty»";
  const hash = createHash("sha256").update(s).digest("hex").slice(0, 8);
  return `[redacted sha256:${hash} len:${s.length}]`;
}

/** Strip every registered sentinel and credential-shaped substring out of `text`. */
export function redact(text) {
  let out = String(text);
  for (const sentinel of SENTINELS) out = out.split(sentinel).join(fingerprint(sentinel));
  return out.replace(SECRET_SHAPES, (m) => fingerprint(m));
}

/**
 * assert.equal for secret values: on mismatch the thrown AssertionError carries only
 * fingerprints — in message, actual and expected — so no reporter, diff, or pasted log can
 * contain the live value.
 */
export function assertSecretEqual(actual, expected, label = "secret value") {
  if (actual === expected) return;
  registerSecretSentinel(actual);
  registerSecretSentinel(expected);
  throw new assert.AssertionError({
    message: `${label}: expected ${fingerprint(expected)}, got ${fingerprint(actual)} (values redacted — AIO-1028)`,
    actual: fingerprint(actual),
    expected: fingerprint(expected),
    operator: "assertSecretEqual",
  });
}
