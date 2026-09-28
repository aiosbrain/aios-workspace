import {
  loadProfileBinding,
  inspectProfileBinding,
  validateProfileDestination,
} from "./mcp-profile-binding.mjs";
import { verifyServerCommand } from "./mcp-host-server-check.mjs";
export { verifyServerCommand } from "./mcp-host-server-check.mjs";
import { prepareProfileArtifact } from "./mcp-profile-artifact.mjs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { hostTargets, MCP_SERVER_KEY } from "./mcp-hosts.mjs";
import { readHostDocument, editHostDocument } from "./mcp-host-formats.mjs";
import { filePolicy, commitHostFiles } from "./mcp-host-files.mjs";
import { resolveBrainConfig } from "./mcp-config.mjs";
import {
  validateCredentialTuple,
  readGlobalCredential,
  windowsSystemExecutable,
} from "./mcp-credentials.mjs";
import { installedServerCommand, prepareServerArtifact } from "./mcp-host-artifact.mjs";
export { installedServerCommand } from "./mcp-host-artifact.mjs";

export function runningHostNames(platform = process.platform, exec = execFileSync) {
  if (platform === "win32") {
    const script =
      "$ErrorActionPreference='Stop'; $env:PSModulePath=$PSHOME+'\\Modules'; $items=@(Get-CimInstance Win32_Process | ForEach-Object { if ($_.CommandLine) { $_.CommandLine } else { $_.Name } }); ConvertTo-Json -InputObject $items -Compress";
    const parsed = JSON.parse(
      exec(
        windowsSystemExecutable("powershell"),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 5000,
        }
      )
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

function isRunning(host, names, platform = process.platform) {
  // POSIX executable names distinguish Claude Desktop (Claude) from Claude Code (claude).
  const normalize = (value) =>
    platform === "win32" ? value.toLowerCase().replace(/\.exe$/, "") : value;
  return names.some((raw) => {
    const name = raw.replaceAll("\\", "/");
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
      if (record?.profileId) {
        const binding = inspectProfileBinding(record.profileId, { ...options, home });
        result.profileId = record.profileId;
        result.profile = binding.profile;
        result.credential_source = binding.sourceClass;
      } else
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

export async function installMcpHosts(options = {}) {
  const { dryRun = false, uninstall = false } = options;
  const home = options.home || os.homedir(),
    project = options.project || process.cwd();
  const profileBinding =
    options.profileId && !uninstall ? loadProfileBinding(options.profileId, options) : null;
  if (
    options.profileId &&
    (options.hosts || []).includes("claude-code") &&
    (!options.project || !path.isAbsolute(options.project))
  )
    throw new Error("Explicit host project required");
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
  let profileArtifact;
  if (profileBinding) {
    await validateProfileDestination(
      profileBinding.profile,
      profileBinding.config.api_key,
      options.fetchImpl
    );
    profileArtifact = await prepareProfileArtifact({
      mode: profileBinding.profile.mode,
      profileId: options.profileId,
      home,
      policy,
      dryRun: true,
      artifactInput: options.artifactInput,
      configDir: path.dirname(profileBinding.state.paths.config),
      fetchImpl: options.artifactFetch,
    });
  }
  const command = uninstall
    ? null
    : profileArtifact?.command || options.command || installedServerCommand({ home });
  for (const host of hosts) {
    if (isRunning(host, names, options.platform))
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
      records.installations.push({
        host: host.id,
        file: host.file,
        entry,
        block: edited.block,
        ...(profileBinding
          ? { profileId: options.profileId, artifactReceipt: profileArtifact.artifactReceipt }
          : {}),
      });
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
  if (!uninstall && !profileBinding) {
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
  if (!uninstall && !options.command && !profileBinding) {
    const artifact = await prepareServerArtifact({ home, policy });
    changes.unshift(...artifact);
  }
  if (profileBinding && !dryRun)
    await prepareProfileArtifact({
      mode: profileBinding.profile.mode,
      profileId: options.profileId,
      home,
      policy,
      artifactInput: options.artifactInput,
      configDir: path.dirname(profileBinding.state.paths.config),
      fetchImpl: options.artifactFetch,
    });
  if (dryRun)
    return {
      dry_run: true,
      changes: proposals,
      credentials: uninstall
        ? "preserved"
        : profileBinding
          ? "selected profile reference (redacted)"
          : "validated; proposed owner-only global default (redacted)",
      host_loading: "unverified",
      restart_state: "unverified",
    };
  const verify = options.verify || verifyServerCommand;
  const checks = [];
  async function checkCommand() {
    if (!uninstall && !checks.length)
      checks.push(
        await verify(
          { ...command, env: {} },
          {
            home,
            project,
            env: options.env || process.env,
            expectedVersion: profileArtifact?.expectedServer.version,
            profileId: options.profileId,
          }
        )
      );
  }
  const transaction = await commitHostFiles(changes, {
    policy,
    beforeCommit: checkCommand,
    beforeReplace: async (file) => {
      if (hosts.some((host) => host.file === file)) await checkCommand();
      const currentNames = (options.runningHosts || (() => runningHostNames(options.platform)))();
      if (hosts.some((host) => isRunning(host, currentNames, options.platform)))
        throw new Error("A selected host started during installation; quit it before retrying");
      await options.beforeReplace?.(file);
    },
    afterReplace: async (file) => {
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
