/**
 * Slack credential + brain-destination resolution for the built-in adapter (AIO-1068).
 *
 * Two distinct secrets flow through here and they are never conflated:
 *
 *   - the SLACK USER TOKEN (xoxp-…) — what every Slack Web API call carries;
 *   - the BRAIN API KEY (AIOS_API_KEY) — what the token fetch / connect / resolve
 *     endpoints on the Team Brain carry.
 *
 * Token roots, in precedence order (one complete source wins; fields are never assembled
 * across sources — scripts/cli/credential-broker.mjs):
 *
 *   1. environment  — process.env.SLACK_USER_TOKEN.
 *   2. user-config  — the user-level config.json credentialSources.slack REFERENCE
 *                     (env:VARIABLE or keychain:service). Only the reference is stored.
 *   3. team brain   — GET /api/v1/me/slack-token with the brain bearer key. The brain
 *                     DESTINATION is validated (scripts/cli/destination-policy.mjs) before
 *                     the bearer key is materialized: a foreign, file:, malformed, or
 *                     non-loopback-http brain URL receives zero credential bytes.
 *
 * Missing everywhere → AIOS_E_CREDENTIAL_MISSING (exit class 3) naming the bootstrap.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  AiosError,
  readUserConfig,
  resolveCredentialRoot,
  resolveUserConfigPath,
} from "../../cli.mjs";
import { brainGetJson } from "./web.mjs";

// Deliberately duplicated from scripts/connectors/linear/credentials.mjs rather than
// imported: a cross-adapter import would let a sabotaged Linear adapter break Slack,
// which is exactly what the quarantine fixtures forbid.
const ENV_REFERENCE = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;
const KEYCHAIN_REFERENCE = /^keychain:([A-Za-z0-9][A-Za-z0-9._/@:+-]{0,255})$/;

function keychainRead(service, runner = spawnSync) {
  const result = runner("security", ["find-generic-password", "-s", service, "-w"], {
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout ?? "").replace(/\n$/, "");
}

export function resolveSlackReferenceValue(
  reference,
  { env = process.env, keychain = keychainRead } = {}
) {
  const envMatch = ENV_REFERENCE.exec(String(reference ?? ""));
  if (envMatch) return env[envMatch[1]] || null;
  const keychainMatch = KEYCHAIN_REFERENCE.exec(String(reference ?? ""));
  if (keychainMatch) return keychain(keychainMatch[1]) || null;
  return null;
}

/** agent-context.json (Hermes/Mac agent config): AGENT_CONTEXT → HERMES_HOME → ~/.claude. */
function agentContext(env, home) {
  const candidates = [
    env.AGENT_CONTEXT,
    env.HERMES_HOME ? path.join(env.HERMES_HOME, "agent-context.json") : null,
    path.join(home, ".claude", "agent-context.json"),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
    } catch {
      /* unreadable/absent context files are simply not a source */
    }
  }
  return {};
}

/**
 * Resolve the Team Brain endpoint config { url, key, team } WITHOUT validating or using it.
 * Sources: env, agent-context.json, then the workspace .env vault (scoped decryption via
 * resolveConnectorEnv — decrypts only the brain keys, never the whole .env).
 */
export async function resolveBrainConfig(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const brain = agentContext(env, home).brain ?? {};
  let url = env.AIOS_BRAIN_URL || brain.url || null;
  let key = (brain.api_key_ref ? env[brain.api_key_ref] : null) || env.AIOS_API_KEY || null;
  let team = env.AIOS_TEAM || brain.team || null;
  if ((!url || !key) && env.AIOS_DISABLE_WORKSPACE_CREDENTIALS !== "1") {
    const { resolveConnectorEnv } = await import("../../global-connector-runtime.mjs");
    const resolved = resolveConnectorEnv({ cwd: options.cwd ?? process.cwd(), env });
    url = url || resolved.AIOS_BRAIN_URL || null;
    key = key || resolved.AIOS_API_KEY || null;
    team = team || resolved.AIOS_TEAM || null;
  }
  return { url: url ? url.replace(/\/+$/, "") : null, key, team };
}

const MISSING = () =>
  new AiosError(
    "AIOS_E_CREDENTIAL_MISSING",
    "No Slack credential source is configured.",
    "Set SLACK_USER_TOKEN, or run `aios slack connect` so the Team Brain holds your token."
  );

/**
 * The dotenvx-wrapper footgun guard ported from slack.py: a token captured through command
 * substitution can embed a log banner (control characters) that corrupts the Authorization
 * header — and uncaught, the runtime's own error text would echo the secret. Fail fast with
 * a fixed, value-free message.
 */
export function assertTokenShape(token) {
  const malformed =
    /[\n\r\t]/.test(token) || !(token.startsWith("xoxp-") || token.startsWith("xoxb-"));
  if (malformed) {
    throw new AiosError(
      "AIOS_E_CREDENTIAL_INCOMPLETE",
      "The Slack token looks malformed (embedded whitespace/control characters, or a missing " +
        "xoxp-/xoxb- prefix). Value intentionally not shown.",
      "Export the token directly (a wrapper like `export T=$(dotenvx run -- printenv …)` " +
        "captures the wrapper's own log output into the value)."
    );
  }
  return token;
}

async function readSlackReference(options) {
  const configPath = resolveUserConfigPath(options);
  const config = await readUserConfig(configPath, options);
  return config.missing ? null : (config.known?.credentialSources?.slack ?? null);
}

/**
 * Select the one Slack token source. Returns `{ values: { token }, source }`; the source
 * names its class (environment | user-config | team-brain) and never carries a value.
 */
export async function resolveSlackCredential(options = {}) {
  const env = options.env ?? process.env;
  const roots = [
    {
      name: "environment",
      load: () => (env.SLACK_USER_TOKEN?.trim() ? { token: env.SLACK_USER_TOKEN.trim() } : null),
    },
    {
      name: "user-config",
      load: async () => {
        const reference = await readSlackReference(options);
        if (!reference) return null;
        const value = resolveSlackReferenceValue(reference, options);
        if (!value) {
          throw new AiosError(
            "AIOS_E_CREDENTIAL_INCOMPLETE",
            `The configured Slack credential reference (${reference}) did not resolve to a value.`,
            "Make the referenced secret available, or store a working reference under " +
              "credentialSources.slack."
          );
        }
        return { token: value };
      },
    },
    {
      name: "team-brain",
      load: async () => {
        const brain = await resolveBrainConfig(options);
        if (!brain.url || !brain.key) return null;
        // brainGetJson routes through trustedFetch: the DESTINATION is validated before the
        // bearer key materializes, and redirects are origin-pinned.
        const { status, body } = await brainGetJson(brain, "/api/v1/me/slack-token", options);
        if (status === 404) return null;
        if (status >= 400) {
          const detail =
            (typeof body?.error === "object" ? body?.error?.message : body?.error) ?? null;
          throw new AiosError(
            "AIOS_E_CREDENTIAL_INCOMPLETE",
            `Team Brain token fetch failed (HTTP ${status}${detail ? `: ${detail}` : ""}).`,
            "Check the brain API key, or run `aios slack connect` to (re)store your Slack token."
          );
        }
        return body?.token ? { token: body.token } : null;
      },
    },
  ];
  try {
    const resolved = await resolveCredentialRoot({ roots, requiredFields: ["token"] });
    assertTokenShape(resolved.values.token);
    return resolved;
  } catch (error) {
    if (error instanceof AiosError && error.code === "AIOS_E_CREDENTIAL_MISSING") throw MISSING();
    throw error;
  }
}

/** Reduce a resolution (or its absence) to a value-free report. */
export async function describeSlackCredential(options = {}) {
  try {
    const resolved = await resolveSlackCredential(options);
    return { configured: true, source: resolved.source };
  } catch (error) {
    if (error instanceof AiosError) return { configured: false, error: error.toJSON().error };
    throw error;
  }
}
