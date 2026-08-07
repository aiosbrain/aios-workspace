#!/usr/bin/env node
/** Global Linear entrypoint; credentials come from env, the current repo, or the toolkit vault. */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrainConfig } from "../packages/foundation/src/brain-config.mjs";

const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(toolkit, "scaffold/.claude/skills/aios-linear/linear.mjs");
if (!existsSync(cli)) {
  console.error(`linear: bundled CLI not found in ${toolkit}`);
  process.exit(1);
}

const roots = [process.cwd()];
if (process.env.AIOS_AGENT_WORKSPACE && path.resolve(process.env.AIOS_AGENT_WORKSPACE) !== path.resolve(process.cwd())) {
  roots.push(process.env.AIOS_AGENT_WORKSPACE);
}
const resolved =
  roots
    .map((root) => resolveBrainConfig(root, { apiKeyEnv: "LINEAR_API_KEY" }))
    .find((config) => config.api_key) || { api_key: "" };
const env = { ...process.env };
if (resolved.api_key && !env.LINEAR_API_KEY) env.LINEAR_API_KEY = resolved.api_key;

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});
if (result.error) {
  console.error(`linear: could not start node: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
