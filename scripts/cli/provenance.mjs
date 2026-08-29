import * as fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createOutput } from "./output.mjs";
import { resolveUserConfigPath } from "./config-broker.mjs";

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function executableInfo(executable) {
  const absolute = path.resolve(executable);
  let realpath = absolute;
  let link = false;
  try {
    link = fs.lstatSync(absolute).isSymbolicLink();
    realpath = fs.realpathSync(absolute);
  } catch {
    realpath = absolute;
  }
  return { path: absolute, realpath, link };
}

function comparablePath(value, platform = process.platform) {
  let comparable = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (platform === "win32") comparable = comparable.toLowerCase();
  return comparable;
}

function canonicalPath(value) {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function isInstalledPackageRoot(root, packageName, platform) {
  if (!packageName) return false;
  const normalizedRoot = comparablePath(canonicalPath(root), platform);
  const packageSuffix = comparablePath(path.posix.join("node_modules", packageName), platform);
  return normalizedRoot.endsWith(`/${packageSuffix}`);
}

function isNodeModulesBin(executablePath, platform) {
  return comparablePath(executablePath, platform).includes("/node_modules/.bin/");
}

function isCheckoutRoot(root) {
  return fs.existsSync(path.join(root, ".git"));
}

export function classifyInstallType(options = {}) {
  const root = options.packageRoot ?? packageRoot;
  const platform = options.platform ?? process.platform;
  const info =
    typeof options.executable === "object"
      ? options.executable
      : executableInfo(options.executable ?? process.argv[1]);

  if (isCheckoutRoot(root)) return "checkout";
  // npm, pnpm, and Yarn node_modules installs expose bins through symlinks on POSIX and
  // generated shims on Windows. The package root, not the bin entrypoint, distinguishes
  // those ordinary installs from an actual `npm link` target outside node_modules.
  if (isInstalledPackageRoot(root, options.packageName, platform)) return "registry";
  if (
    info.link ||
    isNodeModulesBin(info.path, platform) ||
    comparablePath(canonicalPath(info.path), platform) !==
      comparablePath(canonicalPath(info.realpath), platform)
  ) {
    return "link";
  }
  return "registry";
}

function gitHead(root) {
  if (!isCheckoutRoot(root)) return null;
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitDirty(root) {
  if (!isCheckoutRoot(root)) return null;
  try {
    return Boolean(
      execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim()
    );
  } catch {
    return null;
  }
}

function pathCandidates(env) {
  const candidates = [];
  for (const directory of String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)) {
    const candidate = path.join(directory, process.platform === "win32" ? "aios.cmd" : "aios");
    if (fs.existsSync(candidate)) candidates.push(candidate);
  }
  return candidates;
}

export function collectProvenance(options = {}) {
  const root = options.packageRoot ?? packageRoot;
  const env = options.env ?? process.env;
  const executable = executableInfo(options.executable ?? process.argv[1]);
  const pkg = readJson(path.join(root, "package.json")) ?? {};
  const configPaths = {};
  try {
    configPaths.user = resolveUserConfigPath({
      env,
      platform: options.platform,
      home: options.home,
    });
  } catch (error) {
    configPaths.userError = error.code ?? "AIOS_E_CONFIG_INVALID";
  }
  configPaths.workspace = path.join(options.cwd ?? process.cwd(), "aios.yaml");
  const binModes = {};
  for (const [name, relative] of Object.entries(pkg.bin ?? {})) {
    try {
      binModes[name] = fs.statSync(path.join(root, relative)).mode & 0o777;
    } catch {
      binModes[name] = null;
    }
  }
  const candidates = pathCandidates(env);
  const head = gitHead(root);
  const expectedHead = pkg.aiosBuild?.gitHead ?? null;
  return {
    schemaVersion: 1,
    command: "provenance",
    executable,
    package: { name: pkg.name ?? null, version: pkg.version ?? null, root },
    build: { gitHead: head, expectedGitHead: expectedHead },
    installType: classifyInstallType({
      packageRoot: root,
      packageName: pkg.name,
      executable,
      platform: options.platform,
    }),
    node: process.version,
    configPaths,
    adapters: {
      devtools: pkg.dependencies?.["@aiosbrain/aios-devtools"] ?? null,
      linear: pkg.dependencies?.["@aiosbrain/aios-linear"] ?? null,
      slack: pkg.dependencies?.["@aiosbrain/aios-slack"] ?? null,
    },
    binModes,
    path: { candidates, shadowed: candidates.length > 1 },
    drift: {
      workingTreeDirty: gitDirty(root),
      packageHeadMismatch: expectedHead && head ? expectedHead !== head : null,
    },
  };
}

export function cmdProvenance(args) {
  const report = collectProvenance();
  const human = [
    `${report.package.name}@${report.package.version}`,
    `install: ${report.installType}`,
    `executable: ${report.executable.realpath}`,
    `node: ${report.node}`,
  ].join("\n");
  return createOutput({ json: args.includes("--json") }).success(report, human);
}
