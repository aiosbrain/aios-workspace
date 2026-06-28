/**
 * brain-config.mjs — single source of truth for resolving the team-brain connection
 * (brain URL + member API key + team) from process.env, the workspace/toolkit .env,
 * and aios.yaml (brain_url, team_id, api_key_env).
 *
 * Used by the `aios` CLI (mergeBrainSecrets) AND the GUI server's OAuth proxy routes,
 * so both reach the brain the same way. Zero npm deps.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlatYaml, stripQuotes } from "./flat-yaml.mjs";

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
  const toolkit = path.join(SCRIPT_DIR, "..");
  const dotenvs = [loadDotEnv(repo)];
  if (path.resolve(toolkit) !== path.resolve(repo)) dotenvs.push(loadDotEnv(toolkit));
  const yaml = loadAiosYaml(repo);
  const keyEnv = apiKeyEnv || yaml.api_key_env || "AIOS_API_KEY";
  const brainFromEnv = envGet("AIOS_BRAIN_URL", ...dotenvs);
  const brainFromYaml = String(yaml.brain_url || "").trim();
  const teamFromEnv = envGet("AIOS_TEAM", ...dotenvs);
  const teamFromYaml = String(yaml.team_id || "").trim();
  return {
    brain_url: brainFromEnv || brainFromYaml,
    api_key: envGet(keyEnv, ...dotenvs),
    team_id: teamFromEnv || teamFromYaml,
    api_key_env: keyEnv,
  };
}
