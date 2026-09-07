import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFlatYaml, stripQuotes } from "./flat-yaml.mjs";
import { readGlobalCredential } from "./mcp-credentials.mjs";
import { normalizeBrainOriginFromConfig } from "../packages/foundation/src/internal/brain-origin.mjs";

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

/** Resolve complete credential sources without sending a stored key to another Brain origin. */
export function resolveBrainConfig({ cwd = process.cwd(), env = process.env, home } = {}) {
  const dotenv = loadDotEnv(cwd);
  const ws = findWorkspaceConfig(cwd);
  const keyEnv = ws.api_key_env || "AIOS_API_KEY";
  const envKey = env[keyEnv] || env.AIOS_API_KEY || "";
  const localKey = dotenv[keyEnv] || dotenv.AIOS_API_KEY || "";
  const localUrl = dotenv.AIOS_BRAIN_URL || ws.brain_url || "";
  const brain_url = (env.AIOS_BRAIN_URL || localUrl).replace(/\/$/, "");
  const api_key = envKey || localKey;
  const legacy = {
    brain_url,
    api_key,
    team_id: env.AIOS_TEAM || dotenv.AIOS_TEAM || ws.team_id || "",
    member: env.AIOS_MEMBER || dotenv.AIOS_MEMBER || ws.member || "",
    credential_source: api_key ? (envKey ? "environment" : "workspace") : "none",
    missing: [...(!brain_url ? ["AIOS_BRAIN_URL"] : []), ...(!api_key ? [keyEnv] : [])],
  };
  // An environment key uses an explicitly supplied or existing workspace URL, never a
  // URL borrowed from another stored credential tuple. Partial config stays incomplete.
  if (envKey) return legacy;
  const sameOrigin = (left, right) =>
    normalizeBrainOriginFromConfig(left) === normalizeBrainOriginFromConfig(right);
  // Preserve the existing env-URL + workspace-key flow when its recorded origin agrees.
  if (env.AIOS_BRAIN_URL && localKey && localUrl && sameOrigin(env.AIOS_BRAIN_URL, localUrl))
    return legacy;
  const global = readGlobalCredential({ home });
  if (global) {
    if (env.AIOS_BRAIN_URL && !sameOrigin(env.AIOS_BRAIN_URL, global.brain_url)) {
      throw new Error(
        "AIOS_BRAIN_URL differs from the stored credential origin; supply its matching AIOS_API_KEY explicitly"
      );
    }
    return {
      ...global,
      team_id: env.AIOS_TEAM || global.team_id,
      member: env.AIOS_MEMBER || global.member,
      missing: [],
    };
  }
  if (env.AIOS_BRAIN_URL && localKey && localUrl && !sameOrigin(env.AIOS_BRAIN_URL, localUrl)) {
    throw new Error(
      "AIOS_BRAIN_URL differs from the workspace credential origin; supply its matching AIOS_API_KEY explicitly"
    );
  }
  return legacy;
}
