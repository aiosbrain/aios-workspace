import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostTargets, MCP_PACKAGE_VERSION, MCP_SERVER_KEY } from "./mcp-hosts.mjs";
import { readHostDocument, editHostDocument } from "./mcp-host-formats.mjs";
import { filePolicy, commitHostFiles } from "./mcp-host-files.mjs";
import { resolveBrainConfig } from "./mcp-config.mjs";
import { validateCredentialTuple, readGlobalCredential } from "./mcp-credentials.mjs";
import { TOOLSETS } from "../packages/mcp-core/capabilities.mjs";

export function runningHostNames(platform = process.platform, exec = execFileSync) {
  if (platform === "win32") {
    const script =
      "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; $items=@(Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { $_.Name } }); ConvertTo-Json -InputObject $items -Compress";
    const parsed = JSON.parse(
      exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      })
    );
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string"))
      throw new Error("Cannot verify running hosts");
    return parsed;
  }
  return exec("ps", ["-axo", "command="], { encoding: "utf8", timeout: 5000 })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isRunning(host, names) {
  const normalize = (value) => value.toLowerCase().replace(/\.exe$/, "");
  return names.some((raw) => {
    const name = raw.replace(/\\/g, "/");
    const first = name.match(/^"([^"]+)"|^(\S+)/);
    const executable = first?.[1] || first?.[2] || name;
    return (
      host.processes.some(
        (candidate) => normalize(candidate) === normalize(path.basename(executable))
      ) ||
      (host.processPaths || []).some((fragment) =>
        name.toLowerCase().includes(fragment.toLowerCase())
      )
    );
  });
}

export function installedServerCommand({ node = process.execPath, exists = fs.existsSync } = {}) {
  const candidates = [
    path.join(path.dirname(node), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const npm = candidates.find(exists);
  if (!npm) throw new Error("Cannot locate npm beside Node.js; install Node.js with npm first");
  return {
    command: node,
    args: [
      npm,
      "exec",
      "--yes",
      `--package=@aiosbrain/mcp@${MCP_PACKAGE_VERSION}`,
      "--",
      "aios-brain-mcp",
    ],
  };
}

export async function validateInstallerCredential(value, fetchImpl = fetch) {
  const tuple = validateCredentialTuple(value);
  let response, me;
  try {
    response = await fetchImpl(`${tuple.brain_url}/api/v1/me`, {
      headers: { Authorization: `Bearer ${tuple.api_key}` },
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("denied");
    me = await response.json();
  } catch {
    throw new Error("Brain /me validation failed; host configuration was not changed");
  }
  if (
    tuple.api_key.startsWith("aiosd_") ||
    !["team", "external"].includes(me?.tier) ||
    !["actor", "role", "team"].every((key) => typeof me[key] === "string" && me[key].trim())
  )
    throw new Error("Brain /me returned an unsupported identity");
  return { tuple, tier: me.tier };
}

function readRecords(source) {
  if (source.bytes === null) return { version: 1, installations: [] };
  let value;
  try {
    value = JSON.parse(source.bytes.toString("utf8"));
  } catch {
    throw new Error("Malformed MCP installation records");
  }
  if (
    value?.version !== 1 ||
    !Array.isArray(value.installations) ||
    value.installations.some(
      (row) =>
        !row ||
        typeof row.file !== "string" ||
        typeof row.host !== "string" ||
        typeof row.entry !== "object" ||
        !row.entry ||
        !["string", "object"].includes(typeof row.block)
    )
  )
    throw new Error("Invalid MCP installation records");
  const files = value.installations.map((row) => row.file);
  if (new Set(files).size !== files.length) throw new Error("Duplicate MCP installation records");
  return value;
}

export function inspectMcpHosts(options = {}) {
  const home = options.home || os.homedir();
  const policy = options.policy || filePolicy(options);
  let records;
  try {
    records = readRecords(
      policy.snapshot(path.join(home, ".aios", "mcp-installations.json"), { privateFile: true })
    );
  } catch {
    return hostTargets(options).map((host) => ({
      id: host.id,
      label: host.label,
      supported: host.supported,
      configured: false,
      error: "Installation records are unreadable",
      host_loading: "unverified",
      restart_state: "unverified",
    }));
  }
  return hostTargets(options).map((host) => {
    const result = {
      id: host.id,
      label: host.label,
      supported: host.supported,
      file: host.file,
      configured: false,
      owned: false,
      host_loading: "unverified",
      restart_state: "unverified",
    };
    if (!host.supported) return result;
    try {
      const source = policy.snapshot(host.file);
      const document = readHostDocument(source.bytes?.toString("utf8") ?? null, host);
      const entry = document[host.serverKeyPath]?.[MCP_SERVER_KEY];
      const record = records.installations.find(
        (row) => row.file === host.file && row.host === host.id
      );
      result.configured = !!entry;
      result.owned = !!record && isDeepStrictEqual(record.entry, entry);
      result.credential_source = resolveBrainConfig({
        cwd: options.project || process.cwd(),
        home,
        env: options.env || process.env,
      }).credential_source;
    } catch {
      result.error = "Configuration or credentials are unreadable";
    }
    return result;
  });
}

export async function verifyServerCommand(
  entry,
  { home, project, env = process.env, timeoutMs = 120000 } = {}
) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, {
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
          execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "pipe",
            windowsHide: true,
            timeout: 5000,
          });
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
          init?.serverInfo?.version !== MCP_PACKAGE_VERSION ||
          !Array.isArray(tools) ||
          ![4, 8].includes(tools.length) ||
          tools.some((tool) => tool.annotations?.readOnlyHint !== true)
        )
          throw new Error("protocol");
        const expected = [...TOOLSETS.brain, ...(tools.length === 8 ? TOOLSETS.board : [])].sort();
        if (!isDeepStrictEqual(tools.map((tool) => tool.name).sort(), expected))
          throw new Error("membership");
        finish(null, {
          verified: true,
          version: init.serverInfo.version,
          tools: tools.map((tool) => tool.name),
          credential_source: resolveBrainConfig({
            cwd: project,
            home,
            env: { ...env, ...entry.env },
          }).credential_source,
        });
      } catch {
        finish(new Error("Recorded MCP command did not pass initialize and tools/list"));
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

export async function installMcpHosts(options = {}) {
  const { dryRun = false, uninstall = false } = options;
  const home = options.home || os.homedir(),
    project = options.project || process.cwd();
  const policy = options.policy || filePolicy(options);
  const targets = hostTargets({ ...options, home, project });
  const selected = [...new Set(options.hosts || [])];
  if (!selected.length) throw new Error("Select at least one MCP host");
  const hosts = selected.map((id) => {
    const host = targets.find((row) => row.id === id);
    if (!host?.supported) throw new Error(`Unsupported MCP host: ${id}`);
    return host;
  });
  const recordsSource = policy.snapshot(path.join(home, ".aios", "mcp-installations.json"), {
    privateFile: true,
  });
  const records = readRecords(recordsSource);
  policy.writable(recordsSource);
  const names = (options.runningHosts || (() => runningHostNames(options.platform)))();
  const changes = [],
    proposals = [];
  const command = uninstall ? null : options.command || installedServerCommand();
  for (const host of hosts) {
    if (isRunning(host, names))
      throw new Error(
        `${host.label} is running. ${host.restartText} after installation; quit it now before retrying.`
      );
    const source = policy.snapshot(host.file);
    policy.writable(source);
    const text = source.bytes?.toString("utf8") ?? null;
    const document = readHostDocument(text, host),
      previous = document[host.serverKeyPath]?.[MCP_SERVER_KEY];
    const record = records.installations.find(
      (row) => row.host === host.id && row.file === host.file
    );
    if (previous && (!record || !isDeepStrictEqual(previous, record.entry))) {
      if (uninstall) {
        proposals.push({ host: host.id, file: host.file, action: "preserved-edited-or-unowned" });
        continue;
      }
      throw new Error(
        `${host.label}: refusing to overwrite an edited or unowned ${MCP_SERVER_KEY} entry`
      );
    }
    if (uninstall && !previous) {
      proposals.push({ host: host.id, file: host.file, action: "absent" });
      continue;
    }
    const marker = record?.entry?.env?.AIOS_MCP_INSTALLER || `aios-mcp-v1:${randomUUID()}`;
    const entry = uninstall
      ? null
      : {
          ...(host.commandEncoding === "typed-stdio" ? { type: "stdio" } : {}),
          ...command,
          env: { AIOS_MCP_INSTALLER: marker },
        };
    let edited;
    try {
      edited = editHostDocument(text, host, entry, record?.block ?? null);
    } catch (error) {
      if (!uninstall) throw error;
      proposals.push({ host: host.id, file: host.file, action: "preserved-edited-block" });
      continue;
    }
    records.installations = records.installations.filter((row) => row.file !== host.file);
    if (entry)
      records.installations.push({ host: host.id, file: host.file, entry, block: edited.block });
    changes.push({ source, bytes: Buffer.from(edited.text) });
    proposals.push({
      host: host.id,
      file: host.file,
      action: uninstall
        ? "remove"
        : source.bytes?.equals(Buffer.from(edited.text))
          ? "unchanged"
          : "install",
      entry,
      host_loading: "unverified",
      restart_state: "unverified",
    });
  }
  if (uninstall && !changes.length)
    return {
      dry_run: dryRun,
      changes: proposals,
      credentials: "preserved",
      host_loading: "unverified",
      restart_state: "unverified",
    };
  let tier;
  if (!uninstall) {
    const supplied =
      options.credential ||
      resolveBrainConfig({ cwd: project, home, env: options.env || process.env });
    const credential = Object.fromEntries(
      ["brain_url", "api_key", "team_id", "member"]
        .filter((key) => supplied[key] !== undefined)
        .map((key) => [key, supplied[key]])
    );
    const validated = await validateInstallerCredential(credential, options.fetchImpl);
    tier = validated.tier;
    const source = policy.snapshot(path.join(home, ".aios", "credentials.json"), {
      privateFile: true,
    });
    policy.writable(source);
    if (source.bytes) readGlobalCredential({ ...options, home });
    changes.unshift({
      source,
      bytes: Buffer.from(JSON.stringify({ version: 1, default: validated.tuple }, null, 2) + "\n"),
    });
  }
  changes.push({
    source: recordsSource,
    bytes: Buffer.from(JSON.stringify(records, null, 2) + "\n"),
  });
  if (dryRun)
    return {
      dry_run: true,
      changes: proposals,
      credentials: uninstall
        ? "preserved"
        : "validated; proposed owner-only global default (redacted)",
      host_loading: "unverified",
      restart_state: "unverified",
    };
  const verify = options.verify || verifyServerCommand;
  const checks = [];
  if (!uninstall && changes[0].source.bytes?.equals(changes[0].bytes))
    checks.push(
      await verify({ ...command, env: {} }, { home, project, env: options.env || process.env })
    );
  const transaction = await commitHostFiles(changes, {
    policy,
    beforeReplace: async (file) => {
      const currentNames = (options.runningHosts || (() => runningHostNames(options.platform)))();
      if (hosts.some((host) => isRunning(host, currentNames)))
        throw new Error("A selected host started during installation; quit it before retrying");
      await options.beforeReplace?.(file);
    },
    afterReplace: async (file) => {
      if (!uninstall && file === path.join(home, ".aios", "credentials.json")) {
        checks.push(
          await verify({ ...command, env: {} }, { home, project, env: options.env || process.env })
        );
      }
      await options.afterReplace?.(file);
    },
  });
  return {
    dry_run: false,
    changes: proposals,
    ...transaction,
    tier,
    command_verification: checks,
    host_loading: "unverified",
    restart_state: "unverified",
  };
}
