import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const USER_CONFIG_SCHEMA = 1;
export const INSTALL_STATE_SCHEMA = 1;

function absoluteBase(value, fallback, label) {
  const selected = String(value || fallback);
  if (!path.isAbsolute(selected)) throw new Error(`${label} must be an absolute path; got ${selected}`);
  return selected;
}

export function userConfigPath(env = process.env) {
  const base = absoluteBase(env.XDG_CONFIG_HOME, path.join(os.homedir(), ".config"), "XDG_CONFIG_HOME");
  return path.join(base, "aios", "config.json");
}

export function installStatePath(env = process.env) {
  const base = absoluteBase(
    env.XDG_STATE_HOME,
    path.join(os.homedir(), ".local", "state"),
    "XDG_STATE_HOME"
  );
  return path.join(base, "aios", "install.json");
}

function readJson(file, label) {
  if (!existsSync(file)) return null;
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON (${file}): ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object (${file})`);
  }
  return value;
}

function canonicalExistingDirectory(value, label) {
  if (!value) throw new Error(`${label} is required`);
  const absolute = path.resolve(String(value));
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`);
  const canonical = realpathSync(absolute);
  if (!existsSync(path.join(canonical, "aios.yaml"))) {
    throw new Error(`${label} must be a stamped AIOS workspace with aios.yaml: ${canonical}`);
  }
  return canonical;
}

function canonicalScope(value) {
  const absolute = path.resolve(String(value));
  if (!existsSync(absolute)) throw new Error(`guard scope does not exist: ${absolute}`);
  return realpathSync(absolute);
}

export function normalizeUserConfig(input) {
  if (input?.schemaVersion !== USER_CONFIG_SCHEMA) {
    throw new Error(`unsupported AIOS user config schema: ${input?.schemaVersion ?? "missing"}`);
  }
  const defaultWorkspace = canonicalExistingDirectory(input.defaultWorkspace, "defaultWorkspace");
  const scopes = Array.isArray(input.guardScopes) ? input.guardScopes : [defaultWorkspace];
  const guardScopes = [...new Set(scopes.map(canonicalScope))];
  if (!guardScopes.includes(defaultWorkspace)) guardScopes.unshift(defaultWorkspace);
  return { schemaVersion: USER_CONFIG_SCHEMA, defaultWorkspace, guardScopes };
}

export function loadUserConfig({ env = process.env, required = false } = {}) {
  const file = userConfigPath(env);
  const value = readJson(file, "AIOS user config");
  if (!value) {
    if (required) throw new Error(`AIOS is not installed for this user; run \`aios install\` (${file})`);
    return null;
  }
  return normalizeUserConfig(value);
}

export function loadInstallState({ env = process.env } = {}) {
  const file = installStatePath(env);
  const value = readJson(file, "AIOS install state");
  if (!value) return null;
  if (value.schemaVersion !== INSTALL_STATE_SCHEMA) {
    throw new Error(`unsupported AIOS install state schema: ${value.schemaVersion ?? "missing"}`);
  }
  return value;
}

function atomicJsonWrite(file, value) {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Filesystems such as some CI mounts may not expose POSIX modes.
  }
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // See directory chmod note above.
    }
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
}

export function writeUserConfig({ defaultWorkspace, guardScopes = [] }, { env = process.env } = {}) {
  const normalized = normalizeUserConfig({
    schemaVersion: USER_CONFIG_SCHEMA,
    defaultWorkspace,
    guardScopes: guardScopes.length ? guardScopes : [defaultWorkspace],
  });
  atomicJsonWrite(userConfigPath(env), normalized);
  return normalized;
}

export function writeInstallState(value, { env = process.env } = {}) {
  const normalized = { schemaVersion: INSTALL_STATE_SCHEMA, ...value };
  atomicJsonWrite(installStatePath(env), normalized);
  return normalized;
}

export function removeInstallState({ env = process.env } = {}) {
  rmSync(installStatePath(env), { force: true });
}

export function configuredDefaultWorkspace(die, env = process.env) {
  try {
    return loadUserConfig({ env })?.defaultWorkspace ?? null;
  } catch (error) {
    die(error.message);
  }
}

export function isWithinGuardScope(cwd, config) {
  const canonical = realpathSync(path.resolve(cwd));
  return (config?.guardScopes || []).some((scope) => {
    const relative = path.relative(scope, canonical);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}
