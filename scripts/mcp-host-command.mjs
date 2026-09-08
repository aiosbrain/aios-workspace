import { hostTargets } from "./mcp-hosts.mjs";
import { installMcpHosts, inspectMcpHosts, verifyServerCommand } from "./mcp-host-install.mjs";
import { filePolicy } from "./mcp-host-files.mjs";
import { readHostDocument } from "./mcp-host-formats.mjs";
import { MCP_SERVER_KEY } from "./mcp-hosts.mjs";
import os from "node:os";

export async function chooseMcpHosts({ optional = false } = {}) {
  const ui = await import("@clack/prompts");
  if (optional) {
    const answer = await ui.confirm({
      message: "Connect your Brain to an MCP host now? (optional)",
      initialValue: false,
    });
    if (ui.isCancel(answer) || !answer) return [];
  }
  const selected = await ui.multiselect({
    message: "Choose MCP hosts",
    required: false,
    options: hostTargets()
      .filter((host) => host.supported)
      .map((host) => ({
        value: host.id,
        label: host.label,
        hint: `${host.detected ? "detected; " : "not detected; "}${host.scope === "project" ? "this project" : "global configuration"}`,
      })),
  });
  return ui.isCancel(selected) ? [] : selected;
}

export async function offerOnboardingMcp(
  credential,
  { project, choose = chooseMcpHosts, install = installMcpHosts } = {}
) {
  const hosts = await choose({ optional: true });
  if (!hosts.length) return { declined: true };
  return install({ hosts, credential, project });
}

export async function cmdMcpHost(args, options = {}) {
  const rest = [...args];
  const action = ["install", "status", "uninstall"].includes(rest[0]) ? rest.shift() : "install";
  const hosts = [];
  let dryRun = false,
    uninstall = action === "uninstall",
    json = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--uninstall") uninstall = true;
    else if (arg === "--json") json = true;
    else if (arg === "--host" || arg.startsWith("--host=")) {
      const value = arg === "--host" ? rest[++index] : arg.slice(7);
      if (!value || value.startsWith("--"))
        throw new Error("--host needs a comma-separated host list");
      hosts.push(...value.split(",").filter(Boolean));
    } else throw new Error(`Unknown MCP installer option: ${arg}`);
  }
  if (action === "status") {
    if (dryRun || uninstall) throw new Error("status does not accept mutation options");
    const targets = hostTargets(options),
      known = new Set(targets.map((host) => host.id));
    if (hosts.some((id) => !known.has(id))) throw new Error("Unknown MCP host selection");
    const report = inspectMcpHosts(options).filter(
      (host) => !hosts.length || hosts.includes(host.id)
    );
    for (const host of report) {
      if (!host.owned || host.error) continue;
      try {
        const target = targets.find((row) => row.id === host.id);
        const source = (options.policy || filePolicy(options)).snapshot(target.file);
        const entry = readHostDocument(source.bytes.toString("utf8"), target)[target.serverKeyPath][
          MCP_SERVER_KEY
        ];
        host.command_verification = await (options.verify || verifyServerCommand)(entry, {
          home: options.home || os.homedir(),
          project: options.project || process.cwd(),
          env: options.env || process.env,
        });
        host.credential_source = host.command_verification.credential_source;
      } catch {
        host.command_verification = { verified: false };
      }
    }
    console.log(
      json
        ? JSON.stringify({ mcp_hosts: report }, null, 2)
        : report
            .map(
              (host) =>
                `${host.label}: ${host.error || (host.configured ? (host.owned ? "installer-owned" : "unowned/edited") : "not configured")}; credential source: ${host.credential_source || "unavailable"}; server command: ${host.command_verification?.verified ? "verified" : "unverified"}; host loading/restart: unverified`
            )
            .join("\n")
    );
    return report.some((host) => host.error || host.command_verification?.verified === false)
      ? 1
      : 0;
  }
  if (!hosts.length) {
    if (!process.stdin.isTTY)
      throw new Error("Use --host claude-desktop,claude-code,codex,cursor to select targets");
    hosts.push(...(await chooseMcpHosts()));
    if (!hosts.length) {
      console.log("MCP setup skipped.");
      return 0;
    }
  }
  const result = await installMcpHosts({ ...options, hosts, dryRun, uninstall });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
