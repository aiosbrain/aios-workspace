import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import {
  installStatePath,
  loadInstallState,
  loadUserConfig,
  removeInstallState,
  userConfigPath,
  writeInstallState,
  writeUserConfig,
} from "./cli/user-config.mjs";

const TOOLKIT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = JSON.parse(readFileSync(path.join(TOOLKIT_ROOT, "package.json"), "utf8"));

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return args[index + 1];
}

function repeatedFlag(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) continue;
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} needs a value`);
    values.push(args[++index]);
  }
  return values;
}

function findWorkspace(start) {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "aios.yaml"))) return realpathSync(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function selectWorkspace(args) {
  const explicit = flagValue(args, "--workspace");
  if (explicit) return explicit;
  const found = findWorkspace(process.cwd());
  if (found) return found;
  if (args.includes("--yes")) {
    throw new Error("--yes requires --workspace <path> when cwd is not a stamped workspace");
  }
  if (!process.stdin.isTTY) throw new Error("non-interactive install requires --workspace <path>");
  return String(await ask("Default AIOS workspace path: ")).trim();
}

function npmGlobalRoot() {
  return execFileSync("npm", ["root", "--global"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function globalPackageStatus() {
  try {
    const root = npmGlobalRoot();
    const manifest = path.join(root, "@aiosbrain", "aios", "package.json");
    if (!existsSync(manifest)) return { installed: false, root, version: null };
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (pkg.name !== "@aiosbrain/aios") return { installed: false, root, version: null };
    return { installed: true, root, version: pkg.version };
  } catch (error) {
    return { installed: false, root: null, version: null, error: error.message };
  }
}

function ensureGlobalPackage({ skip = false } = {}) {
  const before = globalPackageStatus();
  if (skip) return { ...before, managed: false, skipped: true };
  if (before.installed && before.version === PACKAGE.version) return { ...before, managed: false };
  execFileSync("npm", ["install", "--global", `${PACKAGE.name}@${PACKAGE.version}`], {
    stdio: "inherit",
  });
  const after = globalPackageStatus();
  if (!after.installed || after.version !== PACKAGE.version) {
    throw new Error(`npm completed but ${PACKAGE.name}@${PACKAGE.version} is not installed globally`);
  }
  return { ...after, managed: true };
}

const sha256File = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function uninstallOwnedArtifacts(state) {
  const results = [];
  for (const artifact of state?.artifacts || []) {
    if (!artifact?.path || !path.isAbsolute(artifact.path)) continue;
    if (!existsSync(artifact.path)) {
      results.push({ path: artifact.path, status: "absent" });
      continue;
    }
    if (artifact.sha256 && sha256File(artifact.path) !== artifact.sha256) {
      results.push({ path: artifact.path, status: "preserved-modified" });
      continue;
    }
    if (artifact.backupPath && existsSync(artifact.backupPath)) {
      renameSync(artifact.backupPath, artifact.path);
      results.push({ path: artifact.path, status: "restored" });
    } else {
      rmSync(artifact.path, { force: true });
      results.push({ path: artifact.path, status: "removed" });
    }
  }
  return results;
}

export function checkInstall({ env = process.env } = {}) {
  let config = null;
  let configError = null;
  try {
    config = loadUserConfig({ env });
  } catch (error) {
    configError = error.message;
  }
  let state = null;
  let stateError = null;
  try {
    state = loadInstallState({ env });
  } catch (error) {
    stateError = error.message;
  }
  const global = env.AIOS_INSTALL_SKIP_GLOBAL === "1"
    ? { installed: false, skipped: true, version: null }
    : globalPackageStatus();
  const artifacts = (state?.artifacts || []).map((artifact) => ({
    path: artifact.path,
    present: existsSync(artifact.path),
    intact: existsSync(artifact.path) && (!artifact.sha256 || sha256File(artifact.path) === artifact.sha256),
    runtime: artifact.runtime,
  }));
  const healthy = Boolean(config) && !configError && !stateError &&
    (global.skipped || (global.installed && global.version === PACKAGE.version)) &&
    artifacts.every((artifact) => artifact.present && artifact.intact);
  return {
    healthy,
    package: { expected: PACKAGE.version, ...global },
    configPath: userConfigPath(env),
    statePath: installStatePath(env),
    config,
    configError,
    stateError,
    artifacts,
    enforcement: artifacts.length ? "installed" : "not-installed",
  };
}

export async function cmdInstall(args, { env = process.env } = {}) {
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    throw new Error("aios install currently supports macOS and Linux; Windows is a separate compatibility slice");
  }
  if (args.includes("--check")) {
    const result = checkInstall({ env });
    console.log(JSON.stringify(result, null, 2));
    return result.healthy ? 0 : 1;
  }
  if (args.includes("--uninstall")) {
    const state = loadInstallState({ env });
    const artifacts = uninstallOwnedArtifacts(state);
    removeInstallState({ env });
    if (args.includes("--purge")) rmSync(userConfigPath(env), { force: true });
    if (state?.globalPackageManaged && env.AIOS_INSTALL_SKIP_GLOBAL !== "1") {
      execFileSync("npm", ["uninstall", "--global", PACKAGE.name], { stdio: "inherit" });
    }
    console.log(JSON.stringify({ uninstalled: true, artifacts, configPreserved: !args.includes("--purge") }, null, 2));
    return 0;
  }

  const workspace = await selectWorkspace(args);
  const guardScopes = repeatedFlag(args, "--guard-scope");
  if (!args.includes("--yes")) {
    if (!process.stdin.isTTY) throw new Error("non-interactive install requires --yes");
    const answer = String(
      await ask(
        `Install ${PACKAGE.name}@${PACKAGE.version}, set ${path.resolve(workspace)} as the default workspace, and configure detected agent runtimes? [y/N] `
      )
    ).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") throw new Error("installation cancelled");
  }
  const global = ensureGlobalPackage({ skip: env.AIOS_INSTALL_SKIP_GLOBAL === "1" });
  const config = writeUserConfig(
    { defaultWorkspace: workspace, guardScopes: guardScopes.length ? guardScopes : [workspace] },
    { env }
  );
  const previous = loadInstallState({ env });
  const state = writeInstallState(
    {
      packageName: PACKAGE.name,
      packageVersion: PACKAGE.version,
      globalPackageManaged: Boolean(previous?.globalPackageManaged || global.managed),
      installedAt: new Date().toISOString(),
      artifacts: previous?.artifacts || [],
      runtimes: previous?.runtimes || {},
    },
    { env }
  );
  const result = { installed: true, global, config, state, shellStartupFilesModified: [] };
  console.log(JSON.stringify(result, null, 2));
  return 0;
}
