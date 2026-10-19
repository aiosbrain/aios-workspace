import { spawn, execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { MCP_PACKAGE_VERSION, MCP_PACKAGE_MEMBERSHIPS } from "./mcp-hosts.mjs";
import { resolveBrainConfig } from "./mcp-config.mjs";
import { inspectProfileBinding } from "./mcp-profile-binding.mjs";
import { verifyProfileArtifactReceipt } from "./mcp-artifact-receipt.mjs";
import { windowsSystemExecutable } from "./mcp-credentials.mjs";
// The pinned server's Windows ACL probe can time out while PowerShell initializes
// a fresh user profile. Retry that read-only startup once; never retry protocol,
// membership, authorization, or overall verification timeouts.
export async function verifyServerCommand(entry, options = {}) {
  try {
    return await verifyServerAttempt(entry, options);
  } catch (error) {
    if (
      (options.platform || process.platform) !== "win32" ||
      error.code !== "AIOS_MCP_WINDOWS_STARTUP_TIMEOUT"
    )
      throw error;
    return verifyServerAttempt(entry, options);
  }
}

async function verifyServerAttempt(
  entry,
  {
    home,
    project,
    env = process.env,
    timeoutMs = 120000,
    spawnImpl = spawn,
    expectedVersion,
    profileId,
  } = {}
) {
  const receiptIndex = entry.args.indexOf("--artifact-receipt");
  if (receiptIndex >= 0)
    expectedVersion = verifyProfileArtifactReceipt(entry.args[receiptIndex + 1]).packageVersion;
  const configIndex = entry.args.indexOf("--config-dir");
  if (configIndex >= 0) env = { ...env, AIOS_CONFIG_DIR: entry.args[configIndex + 1] };
  const profileIndex = entry.args.indexOf("--profile");
  if (profileIndex >= 0) profileId = entry.args[profileIndex + 1];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(entry.command, entry.args, {
      cwd: project,
      env: { ...env, ...entry.env, HOME: home, USERPROFILE: home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let output = "",
      stderr = "",
      finished = false,
      timedOut = false;
    function stopTree() {
      try {
        if (!child.pid) return;
        if (process.platform === "win32")
          execFileSync(
            windowsSystemExecutable("taskkill"),
            ["/PID", String(child.pid), "/T", "/F"],
            {
              stdio: "pipe",
              windowsHide: true,
              timeout: 5000,
            }
          );
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") finish(new Error("MCP server process cleanup failed"));
      }
    }
    const timer = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, timeoutMs);
    function finish(error, result) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }
    child.on("error", () => finish(new Error("MCP server command could not start")));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1024 * 1024) stopTree();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 1024 * 1024) stopTree();
    });
    child.on("close", (code) => {
      try {
        if (timedOut) throw new Error("timeout");
        if (code !== 0) throw new Error("exit");
        const messages = output
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const init = messages.find((message) => message.id === 1)?.result;
        const tools = messages.find((message) => message.id === 2)?.result?.tools;
        if (
          init?.protocolVersion !== "2025-11-25" ||
          init?.serverInfo?.version !== (expectedVersion || MCP_PACKAGE_VERSION) ||
          !Array.isArray(tools) ||
          tools.some((tool) => tool?.annotations?.readOnlyHint !== true)
        )
          throw new Error("protocol");
        // Exact membership of the pinned artifact: missing, extra, renamed or duplicated
        // tools all fail, whatever the count.
        const names = tools.map((tool) => tool.name).sort();
        if (!MCP_PACKAGE_MEMBERSHIPS.some((expected) => isDeepStrictEqual(names, expected)))
          throw new Error("membership");
        finish(null, {
          verified: true,
          version: init.serverInfo.version,
          tools: tools.map((tool) => tool.name),
          credential_source: profileId
            ? inspectProfileBinding(profileId, { home, env }).sourceClass
            : resolveBrainConfig({
                cwd: project,
                home,
                env: { ...env, ...entry.env },
              }).credential_source,
        });
      } catch (error) {
        const reason = ["timeout", "exit", "protocol", "membership"].includes(error.message)
          ? error.message
          : "invalid response or credential source";
        const failure = new Error(
          `Recorded MCP command did not pass initialize and tools/list (${reason})`
        );
        if (
          reason === "exit" &&
          code === 1 &&
          /^MCP startup failed: spawnSync [a-z]:[^\r\n]*[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe ETIMEDOUT\r?\n?$/i.test(
            stderr
          )
        )
          failure.code = "AIOS_MCP_WINDOWS_STARTUP_TIMEOUT";
        finish(failure);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "aios-mcp-installer", version: "1" },
          },
        }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        "",
      ].join("\n")
    );
  });
}
