#!/usr/bin/env node
/** Global Slack entrypoint; credentials come from env, the toolkit vault, or the Team Brain. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrainConfig } from "../packages/foundation/src/brain-config.mjs";

const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(toolkit, "scaffold/.claude/descriptors/skills/slack-personal/slack.py");
if (!existsSync(cli)) {
  console.error(`slack: bundled CLI not found in ${toolkit}`);
  process.exit(1);
}

const roots = [process.cwd()];
if (process.env.AIOS_AGENT_WORKSPACE && path.resolve(process.env.AIOS_AGENT_WORKSPACE) !== path.resolve(process.cwd())) {
  roots.push(process.env.AIOS_AGENT_WORKSPACE);
}
const configs = roots.map((root) => resolveBrainConfig(root));
const brain = {
  brain_url: configs.find((config) => config.brain_url)?.brain_url || "",
  api_key: configs.find((config) => config.api_key)?.api_key || "",
  team_id: configs.find((config) => config.team_id)?.team_id || "",
};
const env = { ...process.env };
if (brain.brain_url && !env.AIOS_BRAIN_URL) env.AIOS_BRAIN_URL = brain.brain_url;
if (brain.api_key && !env.AIOS_API_KEY) env.AIOS_API_KEY = brain.api_key;
if (brain.team_id && !env.AIOS_TEAM) env.AIOS_TEAM = brain.team_id;

const result = spawnSync("python3", [cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});
if (result.error) {
  console.error(`slack: could not start python3: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
