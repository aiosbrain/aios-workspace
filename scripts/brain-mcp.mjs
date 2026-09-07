#!/usr/bin/env node
// Toolkit MCP entrypoint. Standalone packaging uses mcp-runtime without this module.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, McpSelectorError } from "../packages/mcp-core/index.mjs";
import { resolveBrainConfig } from "./mcp-config.mjs";
import { workspaceHandler } from "./mcp-workspace.mjs";
import { createDispatcher as dispatcher } from "./mcp-stdio.mjs";
import { startMcp } from "./mcp-runtime.mjs";
import { AiosError } from "./cli/errors.mjs";

export { TOOLS, resolveBrainConfig };
export { createBrainClient } from "./brain-client.mjs";
export const SERVER_NAME = "aios-team-brain-mcp-server";
export const SERVER_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;
const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

// Backwards-compatible protocol test seam; live entrypoints always select via /me.
export function createDispatcher(options = {}) {
  return dispatcher({
    ...options,
    serverInfo: options.serverInfo || serverInfo,
    tools: options.tools || TOOLS,
    ctx: { ...options.ctx, workspaceHandler },
  });
}
export function runStdio(config, deps = {}) {
  try {
    return startMcp(config, { ...deps, serverInfo, surface: "toolkit", workspaceHandler });
  } catch (error) {
    if (!(error instanceof McpSelectorError)) throw error;
    throw new AiosError(
      "AIOS_E_USAGE",
      error.message,
      "Use --toolsets brain,board,workspace or --tools <known-tool-name>; all selects every permitted tool."
    );
  }
}
const invokedDirectly =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  try {
    await runStdio(resolveBrainConfig(), { argv: process.argv.slice(2) });
  } catch (error) {
    process.stderr.write(`MCP startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
