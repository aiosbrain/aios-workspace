import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { parseFlatYaml } from "../flat-yaml.mjs";
import { atomicWrite } from "./atomic-file.mjs";
import { AiosError } from "./errors.mjs";

const KNOWN_USER_KEYS = new Set(["schemaVersion", "defaultWorkspace", "credentialSources"]);
const REFERENCE_SUFFIXES = ["sources", "source", "references", "reference", "refs", "ref"];
const VALUE_SUFFIXES = ["values", "value"];
const HEADER_SUFFIXES = ["headers", "header"];
const SECRET_SUFFIXES = [
  "apikey",
  "token",
  "password",
  "secret",
  "privatekey",
  "credential",
  "authorization",
  "authheader",
  "bearer",
  "accesskey",
  "signingkey",
  "auth",
  "cookie",
  "session",
  "sessionid",
  "signature",
  "sig",
  "clientkey",
  "jwt",
  // Standalone credential carriers that are not suffix variants of the entries above.
  "connectionstring",
  "databaseurl",
  "jdbcurl",
  "dsn",
  "accesscode",
  "passcode",
  "passphrase",
  "pwd",
  "otp",
  "pat",
  "subscriptionkey",
  "passkey",
];
const CREDENTIAL_SOURCE_NAME = /^[a-z][a-z0-9._-]{0,63}$/i;
const ENV_REFERENCE = /^env:[A-Za-z_][A-Za-z0-9_]*$/;
const KEYCHAIN_REFERENCE = /^keychain:[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255}$/;

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

/**
 * Keys are compared without case or separators, and without a trailing ordinal run: `token2`,
 * `apiKey_1`, and `db_password10` are the same family as `token`, `apiKey`, and `password`. A
 * purely numeric key has no stem and is never secret-bearing.
 */
function dropOrdinal(key) {
  return key.replace(/\d+$/, "");
}

function normalizedKey(key) {
  return dropOrdinal(key.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

/**
 * Strip one terminal marker and the ordinal that may sit between it and the stem, so
 * `password1Value`, `apiKey1Ref`, and `secret2Key` reduce to the same stems as their unnumbered
 * forms at every layer, not just the outermost one.
 */
function stripSuffix(key, suffixes) {
  const suffix = suffixes.find((candidate) => key.endsWith(candidate));
  return suffix ? { stem: dropOrdinal(key.slice(0, -suffix.length)), suffix } : null;
}

/**
 * A normalized key is secret-bearing when it ends in a secret-family suffix (singular or plural),
 * or when a terminal `key`/`keys` wrapper exposes such a stem: `secretKey`, `tokenKeys`, `authKey`,
 * `oauthKey`. A bare `oauth`/`oauths` suffix is metadata (`oauth`, `providerOauth`) unless its own
 * stem is secret-bearing (`tokenOauth`). The `key` wrapper alone is never secret-bearing, so `key`,
 * `sortKey`, and `primaryKey` stay allowed; the check is vocabulary-based, not "ends in key".
 */
function hasSecretSuffix(key) {
  const oauthSuffix = stripSuffix(key, ["oauths", "oauth"]);
  if (oauthSuffix) {
    return oauthSuffix.stem ? hasSecretSuffix(oauthSuffix.stem) : false;
  }
  if (SECRET_SUFFIXES.some((suffix) => key.endsWith(suffix) || key.endsWith(`${suffix}s`))) {
    return true;
  }
  const keySuffix = stripSuffix(key, ["keys", "key"]);
  if (!keySuffix?.stem) return false;
  return (
    stripSuffix(keySuffix.stem, ["oauths", "oauth"]) !== null || hasSecretSuffix(keySuffix.stem)
  );
}

/**
 * Config keys are compared without case or separators. Secret-bearing suffixes are forbidden in
 * singular/plural form, including fields wrapped in a terminal value/values marker. A terminal
 * source/reference/ref marker changes the value contract to an unresolved credential reference;
 * the marker alone never exempts an arbitrary value.
 */
function classifySecretKey(key) {
  const normalized = normalizedKey(key);
  if (!normalized) return null;

  let stem = normalized;
  let reference = false;
  while (stem) {
    const referenceSuffix = stripSuffix(stem, REFERENCE_SUFFIXES);
    if (referenceSuffix) {
      reference = true;
      stem = referenceSuffix.stem;
      continue;
    }
    const valueSuffix = stripSuffix(stem, VALUE_SUFFIXES);
    if (valueSuffix) {
      stem = valueSuffix.stem;
      continue;
    }
    const headerSuffix = stripSuffix(stem, HEADER_SUFFIXES);
    if (headerSuffix) {
      stem = headerSuffix.stem;
      continue;
    }
    break;
  }

  if (reference && hasSecretSuffix(stem)) {
    return {
      kind: "reference",
      sourceMap: normalized === "credentialsources",
    };
  }
  return hasSecretSuffix(stem) ? { kind: "plaintext" } : null;
}

/**
 * A value is "material" when it could carry a secret. Booleans and zero cannot: `basicAuth: false`
 * is a disable flag and `tokens: 0` is a count. Any non-zero number stays material because
 * numeric codes (`otp`, `accessCode`) are real credentials.
 */
function hasMaterialValue(value) {
  if (value == null || value === "" || value === 0 || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.some(hasMaterialValue);
  if (typeof value === "object") return Object.values(value).some(hasMaterialValue);
  return true;
}

function isUnresolvedReference(value) {
  return typeof value === "string" && (ENV_REFERENCE.test(value) || KEYCHAIN_REFERENCE.test(value));
}

function isReferenceCollection(value) {
  if (isUnresolvedReference(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isUnresolvedReference);
}

function isCredentialSourceMap(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  return Object.entries(value).every(
    ([name, reference]) => CREDENTIAL_SOURCE_NAME.test(name) && isUnresolvedReference(reference)
  );
}

function invalidReference(trail) {
  throw new AiosError(
    "AIOS_E_CONFIG_INVALID",
    `Credential reference field is invalid at ${trail.join(".")}.`,
    "Use an unresolved env:VARIABLE_NAME or keychain:locator reference; never store a literal secret."
  );
}

function rejectSecrets(value, trail = []) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const classification = classifySecretKey(key);
    if (classification?.kind === "reference" && hasMaterialValue(child)) {
      const valid = classification.sourceMap
        ? isCredentialSourceMap(child)
        : isReferenceCollection(child);
      if (!valid) invalidReference([...trail, key]);
      continue;
    }
    if (classification?.kind === "plaintext" && hasMaterialValue(child)) {
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
