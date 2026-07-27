#!/usr/bin/env node
// run-gui.mjs — build the current client, then start the GUI server.
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
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
  // OpenRouter billing probe for the Cost panel (provider-costs.mjs). Fixed-listed like the other
  // provider keys so an ambient key from a PREVIOUS workspace can't be used for this workspace's
  // billing probe and mislabelled as its spend, even when the selected repo's .env omits it.
  "OPENROUTER_API_KEY",
  "LINEAR_API_KEY",
  // Telegram alert lane (AIO-386). The GUI notifier starts automatically and addresses ONE chat, so
  // an ambient value from a different workspace would send THIS workspace's ask ids, count and repo
  // label to the PREVIOUS workspace's chat. The unscoped names ride along because the CLI still
  // honours them, and the GUI server shells out to it.
  "AIOS_TELEGRAM_BOT_TOKEN",
  "AIOS_TELEGRAM_CHAT_ID",
  "AIOS_TELEGRAM_DISABLED",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_CHAT_ID",
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
 * The compressed secp256k1 public keys the selected workspace encrypted its .env
 * against (DOTENV_PUBLIC_KEY[_SUFFIX] lines — public, plaintext, safe to read).
 * A private key whose derived public key is in this set belongs to THIS workspace.
 */
function workspacePublicKeys(repo) {
  const file = path.join(repo, ".env");
  const keys = new Set();
  if (!existsSync(file)) return keys;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^DOTENV_PUBLIC_KEY(?:_[A-Z0-9_]+)?\s*=\s*["']?([0-9a-fA-F]{66})["']?/);
    if (m) keys.add(m[1].toLowerCase());
  }
  return keys;
}

/** Derive the compressed secp256k1 public key for a dotenvx private key, or null. */
function publicKeyForPrivate(privHex) {
  const hex = typeof privHex === "string" ? privHex.trim() : "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  try {
    const ecdh = crypto.createECDH("secp256k1");
    ecdh.setPrivateKey(Buffer.from(hex, "hex"));
    return ecdh.getPublicKey("hex", "compressed").toLowerCase();
  } catch {
    return null;
  }
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
  // An ambient dotenvx keypair (shell/direnv-hydrated) can shadow the selected
  // repo's own .env.keys and silently mis-decrypt with a FOREIGN workspace's key.
  // But when the selected workspace is encrypted and its private key is available
  // ONLY from that ambient source (no local .env.keys), a blanket delete removes
  // the one usable key and breaks `dotenvx --strict`. So drop only MISMATCHED
  // keys: keep an ambient private key whose derived public key matches one the
  // selected repo encrypted against, and the matching public key alongside it.
  const repoPubs = workspacePublicKeys(repo);
  for (const name of Object.keys(env)) {
    if (/^DOTENV_PRIVATE_KEY(?:_[A-Z0-9_]+)?$/.test(name)) {
      const derived = publicKeyForPrivate(env[name]);
      if (!derived || !repoPubs.has(derived)) delete env[name];
    } else if (/^DOTENV_PUBLIC_KEY(?:_[A-Z0-9_]+)?$/.test(name)) {
      if (
        !repoPubs.has(
          String(env[name] ?? "")
            .trim()
            .toLowerCase()
        )
      )
        delete env[name];
    }
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
