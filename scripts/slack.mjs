#!/usr/bin/env node
/** Global Slack entrypoint; credentials come from env, the toolkit vault, or the Team Brain. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConnectorEnv, runGlobalConnector } from "./global-connector-runtime.mjs";

const toolkit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(toolkit, "scaffold/.claude/descriptors/skills/slack-personal/slack.py");
process.exit(
  runGlobalConnector({
    name: "slack",
    cli,
    env: resolveConnectorEnv(),
    command: "python3",
    spawn: spawnSync,
  })
);
