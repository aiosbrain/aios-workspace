// MCP consumers are separate from the Operator Loop runtime registry.
import path from "node:path";
import os from "node:os";
import { existsSync } from "node:fs";

export const MCP_PACKAGE_VERSION = "0.1.1";
export const MCP_SERVER_KEY = "aios-brain";
export const MCP_HOSTS = Object.freeze([
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    scope: "global",
    formatAdapter: "json",
    serverKeyPath: "mcpServers",
    commandEncoding: "stdio",
    restartText: "Quit and reopen Claude Desktop",
    processes: ["Claude", "Claude.exe"],
    processPaths: ["/Claude.app/Contents/"],
    detectPaths: ["/Applications/Claude.app", "{home}/Applications/Claude.app", "{appdata}/Claude"],
    binaries: [],
    candidatePaths: {
      darwin: ["{home}/Library/Application Support/Claude/claude_desktop_config.json"],
      win32: ["{appdata}/Claude/claude_desktop_config.json"],
    },
  },
  {
    id: "claude-code",
    label: "Claude Code",
    scope: "project",
    formatAdapter: "json",
    serverKeyPath: "mcpServers",
    commandEncoding: "typed-stdio",
    restartText: "Restart Claude Code and approve the project MCP configuration",
    processes: ["claude", "claude.exe"],
    processPaths: ["/claude/versions/", "/@anthropic-ai/claude-code/"],
    detectPaths: [],
    binaries: ["claude", "claude.exe"],
    candidatePaths: {
      darwin: ["{project}/.mcp.json"],
      linux: ["{project}/.mcp.json"],
      win32: ["{project}/.mcp.json"],
    },
  },
  {
    id: "codex",
    label: "Codex",
    scope: "global",
    formatAdapter: "toml",
    serverKeyPath: "mcp_servers",
    commandEncoding: "stdio",
    restartText: "Restart Codex",
    processes: ["codex", "codex.exe", "Codex", "ChatGPT"],
    processPaths: ["/Codex.app/Contents/", "/ChatGPT.app/Contents/", "/@openai/codex/"],
    detectPaths: [
      "/Applications/Codex.app",
      "/Applications/ChatGPT.app",
      "{home}/Applications/Codex.app",
    ],
    binaries: ["codex", "codex.exe", "codex.cmd"],
    candidatePaths: {
      darwin: ["{home}/.codex/config.toml"],
      linux: ["{home}/.codex/config.toml"],
      win32: ["{home}/.codex/config.toml"],
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    scope: "global",
    formatAdapter: "json",
    serverKeyPath: "mcpServers",
    commandEncoding: "typed-stdio",
    restartText: "Quit and reopen Cursor",
    processes: ["Cursor", "Cursor.exe"],
    processPaths: ["/Cursor.app/Contents/"],
    detectPaths: ["/Applications/Cursor.app", "{home}/Applications/Cursor.app"],
    binaries: ["cursor", "cursor.exe", "cursor.cmd"],
    candidatePaths: {
      darwin: ["{home}/.cursor/mcp.json"],
      linux: ["{home}/.cursor/mcp.json"],
      win32: ["{home}/.cursor/mcp.json"],
    },
  },
]);

export function hostTargets({
  home = os.homedir(),
  project = process.cwd(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const paths = platform === "win32" ? path.win32 : path;
  const values = { home, project, appdata: env.APPDATA || paths.join(home, "AppData", "Roaming") };
  const expand = (candidate) =>
    paths.normalize(candidate.replace(/\{(home|project|appdata)\}/g, (_, key) => values[key]));
  return MCP_HOSTS.map((host) => ({
    ...host,
    supported: !!host.candidatePaths[platform],
    detected:
      host.detectPaths.some((candidate) => existsSync(expand(candidate))) ||
      (env.PATH || "")
        .split(platform === "win32" ? ";" : ":")
        .filter(Boolean)
        .some((directory) =>
          host.binaries.some((binary) => existsSync(paths.join(directory, binary)))
        ),
    file: host.candidatePaths[platform]?.map((candidate) => expand(candidate))[0] || null,
  }));
}
