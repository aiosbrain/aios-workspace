import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { parseFlatYaml } from "../flat-yaml.mjs";
import { atomicWrite } from "./atomic-file.mjs";
import { AiosError } from "./errors.mjs";

const REFERENCE_KEY = /(?:source|reference|ref)$/i;
const KNOWN_USER_KEYS = new Set(["schemaVersion", "defaultWorkspace", "credentialSources"]);

function platformPath(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

/** Resolve the one versioned user-config path without reading the filesystem. */
export function resolveUserConfigPath(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const paths = platformPath(platform);
  if (env.AIOS_CONFIG_DIR !== undefined) {
    if (!paths.isAbsolute(env.AIOS_CONFIG_DIR)) {
      throw new AiosError(
        "AIOS_E_CONFIG_INVALID",
        "AIOS_CONFIG_DIR must be an absolute path.",
        "Set AIOS_CONFIG_DIR to an absolute directory or unset it."
      );
    }
    return paths.join(env.AIOS_CONFIG_DIR, "config.json");
  }
  if (platform === "win32") {
    const base = env.APPDATA && paths.isAbsolute(env.APPDATA) ? env.APPDATA : null;
    if (!base) {
      throw new AiosError(
        "AIOS_E_CONFIG_MISSING",
        "APPDATA is unavailable, so the Windows user-config path cannot be resolved.",
        "Set APPDATA or use an absolute AIOS_CONFIG_DIR."
      );
    }
    return paths.join(base, "aios", "config.json");
  }
  if (platform === "darwin")
    return paths.join(home, "Library", "Application Support", "aios", "config.json");
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && paths.isAbsolute(xdg) ? xdg : paths.join(home, ".config");
  return paths.join(base, "aios", "config.json");
}

function rejectSecrets(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /(?:apikey|token|password|secret|privatekey)$/.test(
        key.replace(/[^a-z0-9]/gi, "").toLowerCase()
      ) &&
      !REFERENCE_KEY.test(key) &&
      child != null &&
      child !== ""
    ) {
      throw new AiosError(
        "AIOS_E_CONFIG_INVALID",
        `Plaintext secret field is forbidden at ${[...trail, key].join(".")}.`,
        "Store the value in an approved credential source and keep only its source reference."
      );
    }
    rejectSecrets(child, [...trail, key]);
  }
}

export function parseUserConfig(raw) {
  let document;
  try {
    document = JSON.parse(raw);
  } catch (cause) {
    throw new AiosError(
      "AIOS_E_CONFIG_INVALID",
      "User config is not valid JSON.",
      "Repair config.json or restore its last-known-good snapshot.",
      { cause }
    );
  }
  if (
    !document ||
    Array.isArray(document) ||
    typeof document !== "object" ||
    document.schemaVersion !== 2
  ) {
    throw new AiosError(
      "AIOS_E_CONFIG_INVALID",
      "User config must be an object with schemaVersion 2.",
      "Run the explicit v2 config migration or create a version-2 config."
    );
  }
  rejectSecrets(document);
  const known = {};
  const unknown = {};
  for (const [key, value] of Object.entries(document)) {
    (KNOWN_USER_KEYS.has(key) ? known : unknown)[key] = value;
  }
  return { document, known, unknown };
}

export function parseWorkspaceConfig(raw) {
  const document = parseFlatYaml(raw);
  rejectSecrets(document);
  return document;
}

export async function readUserConfig(configPath, options = {}) {
  const io = options.fs ?? fs;
  try {
    return { path: configPath, ...parseUserConfig(await io.readFile(configPath, "utf8")) };
  } catch (error) {
    if (error?.code === "ENOENT") return { path: configPath, missing: true, document: null };
    throw error;
  }
}

export async function writeUserConfig(configPath, nextKnown, options = {}) {
  const current = await readUserConfig(configPath, options);
  const document = {
    ...(current.unknown ?? {}),
    ...(current.known ?? {}),
    ...nextKnown,
    schemaVersion: 2,
  };
  rejectSecrets(document);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await atomicWrite(configPath, serialized, options);
  return { path: configPath, document, serialized };
}
