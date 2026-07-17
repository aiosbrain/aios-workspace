#!/usr/bin/env node
// run-gui.mjs — build the current client, then start the GUI server.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDescriptors } from "./gen-catalog.mjs";
import { assertGuiRuntimeReady } from "./gui-runtime-preflight.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Credentials used outside the connector catalog but still scoped to the selected workspace.
// Names found in the toolkit/target .env files and connector descriptors are added dynamically.
const WORKSPACE_ENV_NAMES = new Set([
  "AIOS_API_KEY",
  "AIOS_BRAIN_URL",
  "AIOS_MEMBER",
  "AIOS_TEAM",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "LINEAR_API_KEY",
]);

function flag(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

export function resolveGuiRepo(args, cwd = process.cwd()) {
  return path.resolve(flag(args, "--repo") || cwd);
}

// The packaged Tauri shell already ships a built client, but must still use this launcher's
// selected-workspace credential boundary. Keep the private launcher flag out of server argv.
export function normalizeGuiLauncherArgs(args) {
  return {
    skipBuild: args.includes("--skip-build"),
    serverArgs: args.filter((arg) => arg !== "--skip-build"),
  };
}

function envNames(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
    .filter(Boolean);
}

/**
 * Build the subprocess environment without ever reading a secret value here.
 *
 * `npm run gui` executes in the toolkit, and shells/direnv may already have hydrated that
 * toolkit's .env. Remove every known workspace-scoped name before dotenvx loads the selected
 * repo. Otherwise a missing target key silently inherits the toolkit account because dotenvx
 * intentionally lets existing process.env values win. GUI control variables remain ambient so
 * the desktop shell's token/capability binding survives this boundary.
 */
export function scrubGuiWorkspaceEnv({
  ambient = process.env,
  root = ROOT,
  repo,
  descriptors = readDescriptors(repo),
} = {}) {
  const names = new Set([
    ...WORKSPACE_ENV_NAMES,
    ...envNames(path.join(root, ".env")),
    ...envNames(path.join(repo, ".env")),
  ]);
  for (const descriptor of Object.values(descriptors || {})) {
    for (const secret of descriptor.secrets || []) names.add(secret.env);
    for (const field of descriptor.team_instance || []) names.add(field.env);
  }

  const env = { ...ambient };
  for (const name of names) {
    if (name.startsWith("AIOS_GUI_")) continue;
    delete env[name];
  }
  // An ambient dotenvx keypair from another workspace overrides the selected repo's .env.keys.
  for (const name of Object.keys(env)) {
    if (/^DOTENV_(?:PUBLIC|PRIVATE)_KEY(?:_|$)/.test(name)) delete env[name];
  }
  return env;
}

export function guiLaunchPlan({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  root = ROOT,
  ambient = process.env,
} = {}) {
  const repo = resolveGuiRepo(args, cwd);
  const env = scrubGuiWorkspaceEnv({ ambient, root, repo });
  const server = path.join(root, "gui", "server", "index.mjs");
  const envFile = path.join(repo, ".env");
  if (!existsSync(envFile)) {
    return { command: process.execPath, args: [server, ...args], options: { cwd: repo, env } };
  }
  const vendored = path.join(root, "node_modules", ".bin", "dotenvx");
  return {
    command: existsSync(vendored) ? vendored : "dotenvx",
    args: ["run", "--strict", "-f", envFile, "--", process.execPath, server, ...args],
    options: { cwd: repo, env },
  };
}

export function buildGuiClient({ root = ROOT, run = execFileSync } = {}) {
  console.log("building GUI client…");
  run("npm", ["run", "build", "--workspace", "gui/client"], {
    cwd: root,
    stdio: "inherit",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertGuiRuntimeReady();
  const launch = normalizeGuiLauncherArgs(process.argv.slice(2));
  if (!launch.skipBuild) buildGuiClient();
  const plan = guiLaunchPlan({ args: launch.serverArgs });
  const child = spawn(plan.command, plan.args, { ...plan.options, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
