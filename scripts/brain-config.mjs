/**
 * brain-config.mjs — single source of truth for resolving the team-brain connection
 * (brain URL + member API key + team) from process.env and the workspace/toolkit .env.
 *
 * Used by the `aios` CLI (mergeBrainSecrets) AND the GUI server's OAuth proxy routes,
 * so both reach the brain the same way. Zero npm deps.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripQuotes } from "./flat-yaml.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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

/**
 * Resolve { brain_url, api_key, team_id } from process.env, the target workspace .env,
 * and the aios-workspace toolkit root .env (supports running against another workspace
 * while secrets live in the toolkit .env, dotenvx-decrypted into process.env).
 */
export function resolveBrainConfig(repo, { apiKeyEnv = "AIOS_API_KEY" } = {}) {
  const toolkit = path.join(SCRIPT_DIR, "..");
  const dotenvs = [loadDotEnv(repo)];
  if (path.resolve(toolkit) !== path.resolve(repo)) dotenvs.push(loadDotEnv(toolkit));
  return {
    brain_url: envGet("AIOS_BRAIN_URL", ...dotenvs),
    api_key: envGet(apiKeyEnv, ...dotenvs),
    team_id: envGet("AIOS_TEAM", ...dotenvs),
  };
}
