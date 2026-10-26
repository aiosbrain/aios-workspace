#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { startMcp } from "../lib/scripts/mcp-runtime.mjs";
import { resolveLaunchConfig } from "../lib/scripts/mcp-config.mjs";
const { name, version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
try {
  await startMcp(resolveLaunchConfig(process.argv.slice(2)), {
    serverInfo: { name, version },
    surface: "standalone",
    argv: process.argv.slice(2),
  });
} catch (error) {
  process.stderr.write(`MCP startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
