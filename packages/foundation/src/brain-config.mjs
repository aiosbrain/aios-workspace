/**
 * brain-config.mjs — single source of truth for resolving the team-brain connection
 * (brain URL + member API key + team) from process.env, the workspace/toolkit .env,
 * and aios.yaml (brain_url, team_id, api_key_env).
 *
 * Used by the `aios` CLI (mergeBrainSecrets) AND the GUI server's OAuth proxy routes,
 * so both reach the brain the same way. Zero npm deps.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlatYaml, stripQuotes } from "./internal/flat-yaml.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// The toolkit repo root. This module lives at <toolkit>/packages/foundation/src/ (Node
// resolves the workspace symlink to its real path, so import.meta.url is the packages/
// path even when imported as @aiosbrain/foundation). Outside the toolkit repo (e.g. a
// tarball install) this resolves to a directory with no .env / node_modules/.bin, and
// every consumer below already degrades gracefully (existsSync guards + PATH fallback).
const TOOLKIT_ROOT = path.join(SCRIPT_DIR, "..", "..", "..");

/** Read plaintext .env lines into a map. Skips dotenvx ciphertext + its public key —
 * those are decrypted into process.env at runtime by `dotenvx run`, which every caller
 * checks first; returning ciphertext here would be wrong. */
export function loadDotEnv(repo) {
  const envPath = path.join(repo, ".env");
  if (!existsSync(envPath)) return {};
  const out = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    const val = stripQuotes(m[2].trim());
    if (m[1] === "DOTENV_PUBLIC_KEY" || val.startsWith("encrypted:")) continue;
    out[m[1]] = val;
  }
  return out;
}

// ── F-C6: read a dotenvx-encrypted .env outside a direnv/dotenvx-hydrated shell ────────────
//
// Normally `dotenvx run --` decrypts .env into process.env before any of this code runs (the
// env cascade this repo's ../CLAUDE.md documents). A cron/launchd job invokes the CLI directly
// with no such wrapper, so loadDotEnv() above sees only ciphertext and skips it — `api_key`
// resolves to "" even though a real key exists, encrypted, right there in .env. That used to
// surface as the misleading "no API key found in $AIOS_API_KEY (env or .env)". These two
// helpers let resolveBrainConfig tell "genuinely missing" apart from "present but still
// encrypted" and decrypt it directly via .env.keys when possible (dotenvx's own recipe), so a
// scheduled run authenticates without needing direnv at all.

/** True if `repo/.env` carries dotenvx ciphertext — a DOTENV_PUBLIC_KEY header or any
 * KEY=encrypted:... line. That's the signal a "key missing" is actually "key still encrypted." */
export function isDotenvxEncrypted(repo) {
  const envPath = path.join(repo, ".env");
  if (!existsSync(envPath)) return false;
  const text = readFileSync(envPath, "utf8");
  return /^DOTENV_PUBLIC_KEY=/m.test(text) || /=encrypted:/.test(text);
}

// dotenvx reads DOTENV_PUBLIC_KEY/DOTENV_PRIVATE_KEY from the ambient environment if present,
// which take priority over the repo's own .env.keys — strip both so decryption always uses the
// target repo's own keypair (mirrors connector.mjs's vault dotenvxEnv()).
function dotenvxEnv() {
  const env = { ...process.env };
  delete env.DOTENV_PUBLIC_KEY;
  delete env.DOTENV_PRIVATE_KEY;
  return env;
}

// Prefer the @dotenvx/dotenvx the toolkit itself depends on over a bare `dotenvx` on PATH,
// which a cron/launchd job's minimal PATH — or a member's machine — may lack. Node module
// resolution (not a fixed node_modules/.bin path) is what makes this hold in every install
// layout: a dev checkout and a global `npm i -g` nest the dependency under the package, but a
// local install hoists it to the consumer's node_modules, where TOOLKIT_ROOT/node_modules has
// no .bin at all. Returns { command, args } because the resolved entry is a JS file, not an
// executable shim.
function resolveDotenvxInvocation() {
  try {
    const require_ = createRequire(import.meta.url);
    const pkgPath = require_.resolve("@dotenvx/dotenvx/package.json");
    const meta = JSON.parse(readFileSync(pkgPath, "utf8"));
    const binRel = typeof meta.bin === "string" ? meta.bin : meta.bin?.dotenvx;
    if (binRel) {
      return { command: process.execPath, args: [path.join(path.dirname(pkgPath), binRel)] };
    }
  } catch {
    // fall through — a standalone @aiosbrain/foundation consumer may not depend on dotenvx
  }
  const vendored = path.join(TOOLKIT_ROOT, "node_modules", ".bin", "dotenvx");
  if (existsSync(vendored)) return { command: vendored, args: [] };
  return { command: "dotenvx", args: [] };
}

/** Decrypt one key out of a dotenvx-encrypted .env using the repo's .env.keys. Returns "" (never
 * throws) when .env.keys is missing, the dotenvx binary can't run, or the key isn't set — callers
 * fall through to the "encrypted, can't decrypt" actionable error rather than a stack trace.
 * dotenvx 2.x exits 1 when any *sibling* key in the file fails (AIO-790) even if `get KEY`
 * printed that key on stdout — treat a clean stdout value as success and never print it. */
export function decryptDotenvKey(repo, key) {
  const envPath = path.join(repo, ".env");
  if (!existsSync(envPath) || !existsSync(path.join(repo, ".env.keys"))) return "";
  try {
    const dotenvx = resolveDotenvxInvocation();
    const result = spawnSync(dotenvx.command, [...dotenvx.args, "get", key, "-f", envPath], {
      cwd: repo,
      env: dotenvxEnv(),
      encoding: "utf8",
    });
    const value = (result.stdout || "").trim();
    if (!value || value.startsWith("encrypted:")) return "";
    if (/DECRYPTION_FAILED|WRONG_PRIVATE_KEY|could not decrypt/i.test(value)) return "";
    return value;
  } catch {
    return "";
  }
}

/** The shared "your .env is still encrypted" actionable error, used by every requireOnline-style
 * online gate (scripts/aios.mjs + scripts/member-cli.mjs) so a cron/launchd run that can't
 * decrypt gets one clear message instead of the generic "no API key found" one. Centralized here
 * (rather than duplicated in both call sites) so it counts against neither file's line cap. */
export function dotenvxEncryptedHint(cfg) {
  const keyEnv = cfg.api_key_env || "AIOS_API_KEY";
  return (
    `your .env is dotenvx-encrypted for $${keyEnv} and no usable .env.keys was found to decrypt it — ` +
    `run under direnv/dotenvx (e.g. \`dotenvx run -- aios push\`), or set $${keyEnv} directly.`
  );
}

/** First non-empty env value (process.env wins, then .env files). Empty string ≠ set. */
export function envGet(name, ...dotenvs) {
  const fromProcess = process.env[name];
  if (fromProcess != null && String(fromProcess).trim()) return String(fromProcess).trim();
  for (const dotenv of dotenvs) {
    const v = dotenv?.[name];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function loadAiosYaml(repo) {
  const cfgPath = path.join(repo, "aios.yaml");
  if (!existsSync(cfgPath)) return {};
  try {
    return parseFlatYaml(readFileSync(cfgPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolve { brain_url, api_key, team_id, api_key_env } from process.env, workspace/toolkit
 * .env, and aios.yaml. Env wins for brain_url/team when set; yaml fills the gap (stamped
 * workspaces put brain_url + team_id there, API key name in api_key_env, secret in .env).
 */
export function resolveBrainConfig(repo, { apiKeyEnv } = {}) {
  const toolkit = TOOLKIT_ROOT;
  const dirs = [repo];
  if (path.resolve(toolkit) !== path.resolve(repo)) dirs.push(toolkit);
  const dotenvs = dirs.map(loadDotEnv);
  const yaml = loadAiosYaml(repo);
  const keyEnv = apiKeyEnv || yaml.api_key_env || "AIOS_API_KEY";
  const brainFromEnv = envGet("AIOS_BRAIN_URL", ...dotenvs);
  const brainFromYaml = String(yaml.brain_url || "").trim();
  const teamFromEnv = envGet("AIOS_TEAM", ...dotenvs);
  const teamFromYaml = String(yaml.team_id || "").trim();

  let api_key = envGet(keyEnv, ...dotenvs);
  let dotenvx_encrypted = false;
  if (!api_key) {
    // Plaintext lookup came up empty — before concluding the key is genuinely missing, check
    // whether .env is dotenvx ciphertext (F-C6) and try to decrypt it via .env.keys.
    for (const dir of dirs) {
      if (!isDotenvxEncrypted(dir)) continue;
      const decrypted = decryptDotenvKey(dir, keyEnv);
      if (decrypted) {
        api_key = decrypted;
        break;
      }
      dotenvx_encrypted = true; // encrypted, but couldn't decrypt (no/invalid .env.keys)
    }
  }

  return {
    brain_url: brainFromEnv || brainFromYaml,
    api_key,
    team_id: teamFromEnv || teamFromYaml,
    api_key_env: keyEnv,
    // Only relevant when api_key is still empty: tells callers to print the dotenvx-specific
    // actionable error instead of the generic "no API key found" one.
    dotenvx_encrypted: dotenvx_encrypted && !api_key,
  };
}
