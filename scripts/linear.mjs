#!/usr/bin/env node
/** Global Linear entrypoint; credentials come from env, the current repo, or the toolkit vault. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConnectorEnv, runGlobalConnector } from "./global-connector-runtime.mjs";

const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(toolkit, "scaffold/.claude/skills/aios-linear/linear.mjs");
process.exit(
  runGlobalConnector({
    name: "linear",
    cli,
    env: resolveConnectorEnv({ apiKeyEnv: "LINEAR_API_KEY" }),
    command: process.execPath,
    spawn: spawnSync,
  })
);
