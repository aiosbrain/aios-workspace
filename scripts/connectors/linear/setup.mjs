/**
 * `aios connect linear` / `aios linear status` / `aios disconnect linear` (AIO-1067).
 *
 * Two setup surfaces, one rule — no plaintext provider credential is ever written to config:
 *
 *   - Workspace mode (a workspace with connector descriptors at cwd): `aios connect linear`
 *     falls through to the existing descriptor flow (aios-runtime cmdConnect), which stores
 *     the token dotenvx-ENCRYPTED in the workspace .env vault. cmdConnectLinear returns
 *     undefined for that case so the caller keeps its legacy behavior.
 *   - User mode (any directory, empty HOME included): a credential REFERENCE
 *     (env:VARIABLE or keychain:service) is stored in the user-level config.json
 *     (credentialSources.linear). `--token` stores the secret in the OS keychain (macOS
 *     `security`) and records only the keychain reference; on platforms without a keychain
 *     backend it refuses and names the env-reference alternative.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import { AiosError, createOutput, writeUserConfig } from "../../cli.mjs";
import {
  describeLinearCredential,
  parseCredentialReference,
  readLinearReference,
  resolveReferenceValue,
} from "./credentials.mjs";

const KEYCHAIN_SERVICE = "aios-linear";

const usageError = (message) =>
  new AiosError(
    "AIOS_E_USAGE",
    message,
    "Run `aios connect linear --reference env:LINEAR_API_KEY` (or --reference keychain:<service>, " +
      "or --token <api-key> on macOS), or run it inside a workspace for the guided vault flow."
  );

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw usageError(`${flag} requires a value`);
  return value;
}

function keychainWrite(service, secret, runner = spawnSync) {
  const result = runner(
    "security",
    ["add-generic-password", "-U", "-s", service, "-a", "aios", "-w", secret],
    { encoding: "utf8" }
  );
  return !result.error && result.status === 0;
}

async function ensureConfigDir(configPath, io) {
  await io.mkdir(path.dirname(configPath), { recursive: true });
}

async function storeReference(reference, options) {
  const { configPath, config } = await readLinearReference(options);
  const io = options.fs ?? fs;
  await ensureConfigDir(configPath, io);
  const sources = { ...(config.known?.credentialSources ?? {}), linear: reference };
  const known = { ...(config.known ?? {}), credentialSources: sources };
  await writeUserConfig(configPath, known, options);
  return configPath;
}

async function promptReference(output) {
  const { createInterface } = await import("node:readline/promises");
  output.diagnostic(
    "Linear setup — store a credential REFERENCE (the secret itself never lands in config)."
  );
  output.diagnostic(
    "Examples: env:LINEAR_API_KEY (export the key yourself) or keychain:aios-linear."
  );
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (
      (await rl.question("credential reference [env:LINEAR_API_KEY]: ")).trim() ||
      "env:LINEAR_API_KEY"
    );
  } finally {
    rl.close();
  }
}

/**
 * User-level connect. Returns an exit code when it handled the request, or undefined when a
 * workspace descriptor flow should run instead (caller: aios-runtime cmdConnect).
 */
export async function cmdConnectLinear(repo, args, options = {}) {
  const output = createOutput(options);
  try {
    const reference = flagValue(args, "--reference");
    const token = flagValue(args, "--token");
    const hasWorkspaceDescriptor =
      repo && existsSync(path.join(repo, ".claude", "descriptors", "linear.json"));
    if (!reference && hasWorkspaceDescriptor) return undefined; // legacy guided vault flow
    let stored = reference;
    if (!stored && token) {
      const write = options.keychainWrite ?? keychainWrite;
      const platform = options.platform ?? process.platform;
      if (platform !== "darwin" || !write(KEYCHAIN_SERVICE, token)) {
        throw usageError(
          "--token outside a workspace needs an OS keychain backend (macOS `security`) and none was usable."
        );
      }
      stored = `keychain:${KEYCHAIN_SERVICE}`;
    }
    if (!stored) {
      if (!process.stdin.isTTY || options.interactive === false) {
        throw usageError(
          "aios connect linear needs --reference (or --token) when run non-interactively."
        );
      }
      stored = await promptReference(output);
    }
    if (!parseCredentialReference(stored)) {
      throw usageError(
        `"${stored}" is not a valid credential reference — use env:VARIABLE_NAME or keychain:service.`
      );
    }
    const configPath = await storeReference(stored, options);
    const resolves = Boolean(resolveReferenceValue(stored, options));
    if (!resolves) {
      output.diagnostic(
        `warning: ${stored} does not currently resolve to a value — \`aios linear status\` will ` +
          "report it incomplete until the referenced secret exists."
      );
    }
    return output.success(
      { connected: true, provider: "linear", reference: stored, configPath },
      `linear: stored credential reference ${stored} in ${configPath}`
    );
  } catch (error) {
    return output.failure(error);
  }
}

/** `aios linear status [--json]` — source class only, never a credential value. */
export async function cmdLinearStatus(args, options = {}) {
  const output = createOutput({ json: args.includes("--json"), ...options });
  const report = await describeLinearCredential(options);
  if (report.configured) {
    return output.success(
      { provider: "linear", ...report },
      `linear: configured (source: ${report.source.name})`
    );
  }
  // Surface the real resolution failure (missing vs an incomplete stored reference).
  const { code, message, remediation } = report.error;
  return output.failure(new AiosError(code, message, remediation));
}

/** `aios disconnect linear` — remove the user-level reference; other source classes are reported, not touched. */
export async function cmdDisconnect(repo, args, options = {}) {
  const output = createOutput({ json: args.includes("--json"), ...options });
  try {
    const target = args.find((arg) => !arg.startsWith("--"));
    if (target !== "linear") {
      throw new AiosError(
        "AIOS_E_USAGE",
        `aios disconnect supports: linear (got ${target ?? "nothing"}).`,
        "Run `aios disconnect linear`."
      );
    }
    const { configPath, reference, config } = await readLinearReference(options);
    if (reference) {
      const sources = { ...(config.known?.credentialSources ?? {}) };
      delete sources.linear;
      await writeUserConfig(
        configPath,
        { ...(config.known ?? {}), credentialSources: sources },
        options
      );
    }
    const env = options.env ?? process.env;
    if (env.LINEAR_API_KEY) {
      output.diagnostic(
        "note: LINEAR_API_KEY is still set in this environment (or a workspace .env) — " +
          "disconnect only removes the user-level reference."
      );
    }
    return output.success(
      { disconnected: Boolean(reference), provider: "linear", removedReference: reference ?? null },
      reference
        ? `linear: removed credential reference ${reference} from ${configPath}`
        : "linear: no user-level credential reference was configured (nothing to remove)"
    );
  } catch (error) {
    return output.failure(error);
  }
}
