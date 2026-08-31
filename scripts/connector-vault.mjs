/**
 * connector-vault.mjs — the connector engine's secret vault (dotenvx).
 *
 * Extracted from connector.mjs (AIO-1004 pushed that file past its size cap).
 * Secrets are stored ENCRYPTED via dotenvx (.env ciphertext + .env.keys private
 * key); plaintext secret values are never logged and never appear in errors.
 *
 * Zero npm deps: dotenvx is resolved via Node module resolution against the
 * toolkit's own @dotenvx/dotenvx, PATH only as a last resort (see below).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

export function envPath(repo) {
  return path.join(repo, ".env");
}

// dotenvx reads DOTENV_PUBLIC_KEY/DOTENV_PRIVATE_KEY from the environment if present,
// which take priority over the repo's own .env.keys. An ambient shell that already has
// one set (e.g. from a different project's dotenvx setup, or an env cascade like
// Tessera's) silently breaks per-workspace key generation — `set` then encrypts against
// the WRONG key and `get` can never decrypt it back, with no visible error. Strip both
// so every vaultSet/vaultGet always uses this repo's own .env.keys, regardless of what's
// ambient in the caller's shell.
function dotenvxEnv() {
  const env = { ...process.env };
  delete env.DOTENV_PUBLIC_KEY;
  delete env.DOTENV_PRIVATE_KEY;
  return env;
}

// AIO-1004: never resolve `dotenvx` from PATH when the toolkit's own copy is reachable.
// A bare `execFileSync("dotenvx", ...)` picks whichever dotenvx PATH serves up, and npm
// prepends node_modules/.bin — so the SAME vaultSet took a Homebrew 1.52.0 (replaces the
// .env.keys block) in a plain shell and the vendored 2.21.0 (appends a second block) under
// `npm run`. That split is why a real .env.keys corruption could not be reproduced from a
// plain shell. Mirror of resolveDotenvxInvocation() in packages/foundation/src/brain-config.mjs
// (kept private there; the connector engine stays zero-npm-deps, so it carries its own copy):
// Node module resolution finds @dotenvx/dotenvx in every install layout — a dev checkout and a
// global `npm i -g` nest it under the package, a local install hoists it to the consumer's
// node_modules — and the resolved entry is a JS file, so it runs under process.execPath.
// Fallbacks: the toolkit's vendored .bin shim, then bare PATH as the final actionable resort.
// `from`/`toolkitRoot` are test seams (default = this module); production callers pass nothing.
export function resolveDotenvxInvocation({
  from = import.meta.url,
  toolkitRoot = path.join(SCRIPT_DIR, ".."),
} = {}) {
  try {
    const require_ = createRequire(from);
    const pkgPath = require_.resolve("@dotenvx/dotenvx/package.json");
    const meta = JSON.parse(readFileSync(pkgPath, "utf8"));
    const binRel = typeof meta.bin === "string" ? meta.bin : meta.bin?.dotenvx;
    if (binRel) {
      return { command: process.execPath, args: [path.join(path.dirname(pkgPath), binRel)] };
    }
  } catch {
    // fall through — an install without @dotenvx/dotenvx degrades to the vendored
    // shim, then PATH.
  }
  const vendored = path.join(toolkitRoot, "node_modules", ".bin", "dotenvx");
  if (existsSync(vendored)) return { command: vendored, args: [] };
  return { command: "dotenvx", args: [] };
}

// Encrypt+store a secret. dotenvx generates .env.keys + DOTENV_PUBLIC_KEY on first use.
export function vaultSet(repo, env, value) {
  const ep = envPath(repo);
  // dotenvx set no-ops (exit 0!) if the .env file is missing — create it first so the
  // first set bootstraps the keypair and encrypts.
  if (!existsSync(ep)) writeFileSync(ep, "");
  // Note: value passes as an execFile arg (no shell); on a shared host this is briefly
  // visible via `ps`. Acceptable for a single-user local app; hardening tracked for M5.
  const dotenvx = resolveDotenvxInvocation();
  try {
    execFileSync(dotenvx.command, [...dotenvx.args, "set", env, value, "-f", ep], {
      cwd: repo,
      env: dotenvxEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        `vault: dotenvx isn't on PATH — install it (npm i -g @dotenvx/dotenvx), or run this from the toolkit repo where it's already a dependency`
      );
    }
    const stderr = (e.stderr || "").toString().trim();
    throw new Error(`vault: dotenvx failed to set ${env}${stderr ? ` — ${stderr}` : ""}`);
  }
  // dotenvx returns 0 even on some no-ops; assert the value actually landed encrypted.
  const back = vaultGet(repo, env);
  if (back !== value) {
    throw new Error(`vault: ${env} didn't take — check that .env is writable, then retry`);
  }
}

export function vaultGet(repo, env) {
  // Same resolved {command,args} tuple as vaultSet — read and write MUST run the same
  // dotenvx, or the roundtrip check in vaultSet compares across two implementations.
  const dotenvx = resolveDotenvxInvocation();
  // dotenvx 2.x exits non-zero when any SIBLING key in the file fails to decrypt (AIO-790)
  // even though `get KEY` printed the requested value on stdout — and pinning the toolkit's
  // own 2.x makes that the one behaviour everywhere. Mirror decryptDotenvKey in
  // packages/foundation/src/brain-config.mjs: read stdout regardless of exit status and
  // treat a clean value as success. Genuine failures — spawn error, empty stdout, a
  // still-encrypted value, or a decryption-error message — keep failing closed with "",
  // which is what makes vaultSet's roundtrip check raise its actionable error. Never
  // print the value; stderr is dropped so nothing secret-adjacent leaks.
  try {
    const result = spawnSync(dotenvx.command, [...dotenvx.args, "get", env, "-f", envPath(repo)], {
      cwd: repo,
      env: dotenvxEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const value = (result.stdout || "").trim();
    if (!value || value.startsWith("encrypted:")) return "";
    if (/DECRYPTION_FAILED|WRONG_PRIVATE_KEY|could not decrypt/i.test(value)) return "";
    return value;
  } catch {
    return "";
  }
}
