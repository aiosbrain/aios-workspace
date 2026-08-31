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
 *                     the bearer key is materialized: a file:, malformed, or
 *                     non-loopback-http brain URL receives zero credential bytes, and
 *                     credentialed redirects are origin-pinned. There is deliberately no
 *                     HTTPS origin allowlist; what prevents a planted HTTPS destination is
 *                     the TRUST-DOMAIN BINDING in resolveBrainConfig — the destination and
 *                     the key must resolve from the same domain (operator config, or a
 *                     workspace that supplies BOTH itself), so an untrusted cwd can never
 *                     point the operator's key (or the xoxp token) at its own origin.
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
  // Keychain blobs can carry a trailing newline AND trailing NULs — strip both, exactly
  // like the newline: a surviving NUL would corrupt the Authorization header downstream.
  return String(result.stdout ?? "").replace(/[\0\r\n]+$/, "");
}

/** Parse a stored reference to { kind, locator }, or null when it is not a reference.
 *  A parsed locator matched the reference grammar, so it is safe to name in an error —
 *  a raw secret can never round-trip through this into any message. */
export function parseSlackCredentialReference(reference) {
  const envMatch = ENV_REFERENCE.exec(String(reference ?? ""));
  if (envMatch) return { kind: "env", locator: envMatch[1] };
  const keychainMatch = KEYCHAIN_REFERENCE.exec(String(reference ?? ""));
  if (keychainMatch) return { kind: "keychain", locator: keychainMatch[1] };
  return null;
}

export function resolveSlackReferenceValue(
  reference,
  { env = process.env, keychain = keychainRead } = {}
) {
  const parsed = parseSlackCredentialReference(reference);
  if (!parsed) return null;
  if (parsed.kind === "env") return env[parsed.locator] || null;
  return keychain(parsed.locator) || null;
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

const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

const trim = (value) => String(value ?? "").trim();
const stripSlash = (value) => (value ? value.replace(/\/+$/, "") : null);

/** The operator's toolkit vault location: AIOS_TOOLKIT_DIR (their own env) or this package. */
function toolkitRoot(env) {
  return env.AIOS_TOOLKIT_DIR && path.isAbsolute(env.AIOS_TOOLKIT_DIR)
    ? env.AIOS_TOOLKIT_DIR
    : PACKAGE_ROOT;
}

/**
 * Resolve the Team Brain endpoint config { url, key, team } WITHOUT validating or using it.
 *
 * TRUST-DOMAIN BINDING (round-5 finding 3): when a credential will be attached, the
 * destination must come from the SAME trust domain as the key. Two domains exist:
 *
 *   - OPERATOR: process env, agent-context.json, and the operator's own toolkit vault
 *     (AIOS_TOOLKIT_DIR → this package checkout's .env; brain key decrypted scoped, never
 *     the whole .env). Complete (url+key) → wins outright; an untrusted cwd is never read.
 *   - WORKSPACE: the cwd's own .env/aios.yaml (the legacy resolveConnectorEnv path).
 *     Used ONLY when it supplies BOTH url and key itself.
 *
 * A cross-domain pairing — e.g. an untrusted clone's .env supplying AIOS_BRAIN_URL while
 * the operator's key would fill in from elsewhere — is REFUSED with a value-free error:
 * that pairing is exactly the "cd into a hostile repo, run aios slack, key exfiltrates to
 * attacker's HTTPS origin" shape. Fields are never assembled across domains.
 */
export async function resolveBrainConfig(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const brain = agentContext(env, home).brain ?? {};
  const vaultRoot = toolkitRoot(env);
  const { loadDotEnv, isDotenvxEncrypted, decryptDotenvKey } =
    await import("../../brain-config.mjs");
  let vault = {};
  try {
    vault = loadDotEnv(vaultRoot) ?? {};
  } catch {
    vault = {};
  }
  const opUrl = trim(env.AIOS_BRAIN_URL || brain.url || vault.AIOS_BRAIN_URL);
  let opKey = trim(
    (brain.api_key_ref ? env[brain.api_key_ref] : "") || env.AIOS_API_KEY || vault.AIOS_API_KEY
  );
  if (!opKey && isDotenvxEncrypted(vaultRoot)) {
    opKey = trim(decryptDotenvKey(vaultRoot, "AIOS_API_KEY"));
  }
  const opTeam = trim(env.AIOS_TEAM || brain.team || vault.AIOS_TEAM) || null;
  if (opUrl && opKey) {
    return { url: stripSlash(opUrl), key: opKey, team: opTeam, source: "operator" };
  }
  if (env.AIOS_DISABLE_WORKSPACE_CREDENTIALS === "1") {
    // Disabling a source can only remove credentials, never add or mix them.
    return { url: null, key: null, team: opTeam, source: null };
  }
  const { resolveConnectorEnv } = await import("../../global-connector-runtime.mjs");
  const resolved = resolveConnectorEnv({ cwd: options.cwd ?? process.cwd(), env });
  const wsUrl = trim(resolved.AIOS_BRAIN_URL);
  const wsKey = trim(resolved.AIOS_API_KEY);
  if (!wsUrl || !wsKey) return { url: null, key: null, team: opTeam, source: null };
  const urlDomain = opUrl ? "operator" : "workspace";
  const keyDomain = opKey ? "operator" : "workspace";
  if (urlDomain !== keyDomain) {
    throw new AiosError(
      "AIOS_E_CONFIG_INVALID",
      `The Team Brain destination resolves from the ${urlDomain} config while the brain ` +
        `credential resolves from the ${keyDomain} config — refusing to pair them ` +
        "(values intentionally not shown).",
      "Provide AIOS_BRAIN_URL and the brain key from the SAME place: both in your " +
        "environment/toolkit config, or both in the workspace's own .env."
    );
  }
  return {
    url: stripSlash(wsUrl),
    key: wsKey,
    team: trim(resolved.AIOS_TEAM) || opTeam,
    source: "workspace",
  };
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
  // ANY C0 control char, space, or DEL — undici's own header validator rejects a different
  // subset (NUL/CR/LF) and its TypeError EMBEDS the header value, so anything that would
  // trip it must be refused here first, with this fixed message (round-5 finding 2).
  const malformed =
    // eslint-disable-next-line no-control-regex -- the control range IS the property checked
    /[\x00-\x20\x7f]/.test(token) || !(token.startsWith("xoxp-") || token.startsWith("xoxb-"));
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
        // NEVER interpolate the stored value into a message before it has parsed as a
        // reference: if config carries a raw token instead of env:/keychain:, echoing it
        // would put the secret on stderr and in CI logs (Codex round 4). The config
        // broker's rejectSecrets fires first on the read path; this is the belt for any
        // caller that reaches this root with an unvalidated document.
        const parsed = parseSlackCredentialReference(reference);
        if (!parsed) {
          throw new AiosError(
            "AIOS_E_CONFIG_INVALID",
            "credentialSources.slack is not a valid credential reference " +
              "(value intentionally not shown).",
            "Store env:VARIABLE_NAME or keychain:service — never the secret itself."
          );
        }
        const value = resolveSlackReferenceValue(reference, options);
        if (!value) {
          // Safe to name: kind:locator matched the reference grammar above.
          throw new AiosError(
            "AIOS_E_CREDENTIAL_INCOMPLETE",
            `The configured Slack credential reference (${parsed.kind}:${parsed.locator}) ` +
              "did not resolve to a value.",
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
