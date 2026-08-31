/**
 * Linear credential resolution for the built-in adapter (AIO-1067).
 *
 * One complete source is selected through the shared credential broker
 * (scripts/cli/credential-broker.mjs); fields are never assembled across sources. Roots, in
 * precedence order:
 *
 *   1. environment      — process.env.LINEAR_API_KEY (a direnv/dotenvx-hydrated shell).
 *   2. workspace        — the cwd workspace / AIOS_AGENT_WORKSPACE .env via
 *                         resolveConnectorEnv({ apiKeyEnv: "LINEAR_API_KEY" }), the exact
 *                         AIO-790 scoped-decryption path the legacy `linear` bin used
 *                         (decrypts ONLY LINEAR_API_KEY, never the whole .env).
 *   3. user-config      — the user-level config.json credentialSources.linear REFERENCE
 *                         (env:VARIABLE or keychain:service), written by `aios connect linear`.
 *                         Only the reference is stored; the secret itself stays in the
 *                         referenced environment variable or OS keychain.
 *
 * Missing everywhere → AIOS_E_CREDENTIAL_MISSING with the exact bootstrap command
 * (`aios connect linear`), exit class 3. No credential VALUE is ever returned to callers
 * that report state; describeLinearCredential reduces the result to source class only.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  AiosError,
  readUserConfig,
  resolveCredentialRoot,
  resolveUserConfigPath,
} from "../../cli.mjs";

function ancestors(startDir) {
  const chain = [];
  let dir = path.resolve(startDir);
  for (;;) {
    chain.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return chain;
    dir = parent;
  }
}

/**
 * The workspace root the compat `linear` bin should target, matching what dispatch hands
 * `aios linear` (route-parity contract, AIO-1067). The workspace marker `aios.yaml` wins
 * from ANY depth — a nested package directory carrying its own `.env` must not shadow the
 * workspace above it (Codex round 2). Only when no `aios.yaml` exists anywhere up the tree
 * does the nearest `.env` vault stand in; with neither, the start directory is returned.
 */
export function findLinearBase(startDir = process.cwd()) {
  const chain = ancestors(startDir);
  for (const dir of chain) {
    if (existsSync(path.join(dir, "aios.yaml"))) return dir;
  }
  for (const dir of chain) {
    if (existsSync(path.join(dir, ".env"))) return dir;
  }
  return chain[0];
}

export const ENV_REFERENCE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
export const KEYCHAIN_REFERENCE = /^keychain:([A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255})$/;

export function parseCredentialReference(reference) {
  const env = ENV_REFERENCE.exec(String(reference ?? ""));
  if (env) return { kind: "env", locator: env[1] };
  const keychain = KEYCHAIN_REFERENCE.exec(String(reference ?? ""));
  if (keychain) return { kind: "keychain", locator: keychain[1] };
  return null;
}

function keychainRead(service, runner = spawnSync) {
  const result = runner("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "").replace(/\n$/, "");
}

/** Resolve a stored reference to its secret value, or null when it cannot resolve. */
export function resolveReferenceValue(
  reference,
  { env = process.env, keychain = keychainRead } = {}
) {
  const parsed = parseCredentialReference(reference);
  if (!parsed) return null;
  if (parsed.kind === "env") return env[parsed.locator] || null;
  return keychain(parsed.locator) || null;
}

export async function readLinearReference(options = {}) {
  const configPath = resolveUserConfigPath(options);
  const config = await readUserConfig(configPath, options);
  const reference = config.missing ? null : (config.known?.credentialSources?.linear ?? null);
  return { configPath, reference, config };
}

const MISSING = () =>
  new AiosError(
    "AIOS_E_CREDENTIAL_MISSING",
    "No Linear credential source is configured.",
    "aios connect linear"
  );

/**
 * Select the one Linear credential source. Returns `{ values: { apiKey }, source }`; the
 * source names its class (environment | workspace | user-config) and never carries a value.
 */
export async function resolveLinearCredential(options = {}) {
  const env = options.env ?? process.env;
  const roots = [
    {
      name: "environment",
      load: () => (env.LINEAR_API_KEY ? { apiKey: env.LINEAR_API_KEY } : null),
    },
    {
      name: "workspace",
      load: async () => {
        // Fail-closed test seam: DISABLING a source can only remove credentials, never add
        // them. Lets a test (or a fresh-user rehearsal) simulate a machine without the
        // toolkit vault that resolveConnectorEnv would otherwise find.
        if (env.AIOS_DISABLE_WORKSPACE_CREDENTIALS === "1") return null;
        const { resolveConnectorEnv } = await import("../../global-connector-runtime.mjs");
        const resolved = resolveConnectorEnv({
          apiKeyEnv: "LINEAR_API_KEY",
          cwd: options.cwd ?? process.cwd(),
          env,
        });
        return resolved.LINEAR_API_KEY && resolved.LINEAR_API_KEY !== env.LINEAR_API_KEY
          ? { apiKey: resolved.LINEAR_API_KEY }
          : null;
      },
    },
    {
      name: "user-config",
      load: async () => {
        const { reference } = await readLinearReference(options);
        if (!reference) return null;
        const value = resolveReferenceValue(reference, options);
        if (!value) {
          throw new AiosError(
            "AIOS_E_CREDENTIAL_INCOMPLETE",
            `The configured Linear credential reference (${reference}) did not resolve to a value.`,
            "Make the referenced secret available, or run `aios connect linear` to store a working reference."
          );
        }
        return { apiKey: value };
      },
    },
  ];
  try {
    return await resolveCredentialRoot({ roots, requiredFields: ["apiKey"] });
  } catch (error) {
    if (error instanceof AiosError && error.code === "AIOS_E_CREDENTIAL_MISSING") throw MISSING();
    throw error;
  }
}

/** Reduce a resolution (or its absence) to a value-free report for `aios linear status`. */
export async function describeLinearCredential(options = {}) {
  try {
    const resolved = await resolveLinearCredential(options);
    return { configured: true, source: resolved.source };
  } catch (error) {
    if (error instanceof AiosError) {
      return { configured: false, error: error.toJSON().error };
    }
    throw error;
  }
}

/**
 * Preflight for network verbs: resolve the credential once and export it for the verb
 * implementations (scripts/connectors/linear/core.mjs reads process.env.LINEAR_API_KEY).
 */
export async function ensureLinearCredential(options = {}) {
  const resolved = await resolveLinearCredential(options);
  process.env.LINEAR_API_KEY = resolved.values.apiKey;
  return resolved.source;
}
