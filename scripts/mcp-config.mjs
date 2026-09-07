import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlatYaml, stripQuotes } from "./flat-yaml.mjs";

/** Minimal .env reader — mirrors aios.mjs loadDotEnv (skips dotenvx ciphertext). */
function loadDotEnv(dir) {
  const envPath = path.join(dir, ".env");
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

/** Walk up from `dir` looking for an aios.yaml; return its parsed config or {}. */
function findWorkspaceConfig(dir) {
  let cur = path.resolve(dir);
  for (let i = 0; i < 40; i++) {
    const p = path.join(cur, "aios.yaml");
    if (existsSync(p)) {
      try {
        return parseFlatYaml(readFileSync(p, "utf8"));
      } catch {
        return {};
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return {};
}

/**
 * Resolve brain connection config. Precedence: process env → cwd/.env → aios.yaml.
 * env-first is deliberate: a Claude Desktop / Cowork user configures the server purely
 * through the extension's env block and has no workspace. Returns a config object plus
 * `missing[]` listing any required field that could not be resolved. Team is
 * optional: the API key is the authoritative team identity.
 */
export function resolveBrainConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const dotenv = loadDotEnv(cwd);
  const ws = findWorkspaceConfig(cwd);
  const keyEnv = ws.api_key_env || "AIOS_API_KEY";

  const brain_url = (env.AIOS_BRAIN_URL || dotenv.AIOS_BRAIN_URL || ws.brain_url || "").replace(
    /\/$/,
    ""
  );
  const api_key = env[keyEnv] || dotenv[keyEnv] || env.AIOS_API_KEY || dotenv.AIOS_API_KEY || "";
  const team_id = env.AIOS_TEAM || dotenv.AIOS_TEAM || ws.team_id || "";
  const member = env.AIOS_MEMBER || dotenv.AIOS_MEMBER || ws.member || "";

  const missing = [];
  if (!brain_url) missing.push("AIOS_BRAIN_URL");
  if (!api_key) missing.push(keyEnv);

  return { brain_url, api_key, team_id, member, missing };
}
