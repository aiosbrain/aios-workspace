import { spawnSync as defaultSpawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveBrainConfig } from "../packages/foundation/src/brain-config.mjs";

export function resolveConnectorEnv({
  apiKeyEnv = "AIOS_API_KEY",
  cwd = process.cwd(),
  env = process.env,
} = {}) {
  const roots = [cwd];
  if (env.AIOS_AGENT_WORKSPACE && path.resolve(env.AIOS_AGENT_WORKSPACE) !== path.resolve(cwd)) {
    roots.push(env.AIOS_AGENT_WORKSPACE);
  }
  const configs = roots.map((root) => resolveBrainConfig(root, { apiKeyEnv }));
  const resolvedEnv = { ...env };
  const brainUrl = configs.find((config) => config.brain_url)?.brain_url;
  const apiKey = configs.find((config) => config.api_key)?.api_key;
  const teamId = configs.find((config) => config.team_id)?.team_id;
  if (brainUrl && !resolvedEnv.AIOS_BRAIN_URL) resolvedEnv.AIOS_BRAIN_URL = brainUrl;
  if (apiKey && !resolvedEnv[apiKeyEnv]) resolvedEnv[apiKeyEnv] = apiKey;
  if (teamId && !resolvedEnv.AIOS_TEAM) resolvedEnv.AIOS_TEAM = teamId;
  return resolvedEnv;
}

export function runGlobalConnector({
  name,
  cli,
  argv = process.argv.slice(2),
  env,
  command,
  spawn = defaultSpawnSync,
} = {}) {
  if (!existsSync(cli)) {
    console.error(`${name}: bundled CLI not found in ${path.dirname(cli)}`);
    return 1;
  }
  const result = spawn(command, [cli, ...argv], {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`${name}: could not start connector: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}
