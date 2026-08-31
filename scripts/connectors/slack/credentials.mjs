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
 *                     the BRAIN KEY must resolve from the same domain (operator config, or
 *                     a workspace root that supplies BOTH itself), so an untrusted cwd can
 *                     never point the operator's brain key at its own origin. The xoxp
 *                     TOKEN gets the matching guard in the connect flow (setup.mjs): an
 *                     ambient environment-sourced token is never POSTed to a
 *                     workspace-domain brain — only a token passed explicitly (argv or
 *                     --stdin) expresses consent to a workspace destination.
 *
 * Missing everywhere → AIOS_E_CREDENTIAL_MISSING (exit class 3) naming the bootstrap.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFlatYaml } from "../../flat-yaml.mjs";
import { spawnSync } from "node:child_process";
import {
  AiosError,
  readUserConfig,
  resolveCredentialRoot,
  resolveUserConfigPath,
} from "../../cli.mjs";
import { brainDomainConflictError, brainGetJson } from "./web.mjs";

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

// fileURLToPath, never URL(...).pathname: pathname keeps percent-encoding (a space in the
// install path → "%20" → nonexistent dir → the operator vault would be silently skipped).
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const trim = (value) => String(value ?? "").trim();
const stripSlash = (value) => (value ? value.replace(/\/+$/, "") : null);

/** The operator's toolkit vault location: AIOS_TOOLKIT_DIR (their own env) or this package. */
function toolkitRoot(env) {
  return env.AIOS_TOOLKIT_DIR && path.isAbsolute(env.AIOS_TOOLKIT_DIR)
    ? env.AIOS_TOOLKIT_DIR
    : PACKAGE_ROOT;
}

/** Operator-domain fields: process env, agent-context.json, the operator's toolkit vault. */
function operatorBrainConfig(env, brain, vaultRoot, foundation) {
  const { loadDotEnv, isDotenvxEncrypted, decryptDotenvKey } = foundation;
  let vault = {};
  try {
    vault = loadDotEnv(vaultRoot) ?? {};
  } catch {
    vault = {};
  }
  let url = trim(env.AIOS_BRAIN_URL || brain.url || vault.AIOS_BRAIN_URL);
  let key = trim(
    (brain.api_key_ref ? env[brain.api_key_ref] : "") || env.AIOS_API_KEY || vault.AIOS_API_KEY
  );
  try {
    // loadDotEnv skips dotenvx ciphertext, so an all-encrypted vault needs the scoped
    // decrypt for BOTH fields — decrypting only the key would strand the vault as
    // key-without-url and wrongly push resolution into the workspace stage.
    if ((!url || !key) && isDotenvxEncrypted(vaultRoot)) {
      if (!url) url = trim(decryptDotenvKey(vaultRoot, "AIOS_BRAIN_URL"));
      if (!key) key = trim(decryptDotenvKey(vaultRoot, "AIOS_API_KEY"));
    }
  } catch {
    /* an unreadable vault contributes nothing */
  }
  const team = trim(env.AIOS_TEAM || brain.team || vault.AIOS_TEAM) || null;
  return { url, key, team };
}

/**
 * Workspace-domain fields: the cwd's OWN files only (.env plaintext + scoped dotenvx
 * decrypt, aios.yaml brain_url/team_id). Deliberately NOT resolveConnectorEnv: that merge
 * folds process.env and the toolkit vault back in, so "the workspace lookup found it"
 * stops meaning "the workspace owns it" — the exact inference-by-absence that made the
 * trust-domain binding fail open when the two toolkit-root constructions diverged (D1).
 * Provenance here is by construction, not by comparing lookups.
 */
function workspaceOwnBrainConfig(cwd, foundation) {
  const { loadDotEnv, isDotenvxEncrypted, decryptDotenvKey } = foundation;
  let dotenv = {};
  let yaml = {};
  try {
    dotenv = loadDotEnv(cwd) ?? {};
  } catch {
    dotenv = {};
  }
  try {
    yaml = parseFlatYaml(fs.readFileSync(path.join(cwd, "aios.yaml"), "utf8")) ?? {};
  } catch {
    yaml = {};
  }
  let url = trim(dotenv.AIOS_BRAIN_URL || yaml.brain_url);
  let key = trim(dotenv.AIOS_API_KEY);
  try {
    // Mirror of the operator vault: loadDotEnv skips dotenvx ciphertext, so an
    // all-encrypted workspace vault needs the scoped decrypt for BOTH fields — decrypting
    // only the key would strand it as key-without-url and misreport a complete workspace
    // as missing/conflicting. Provenance is unchanged: a decrypted value is still the
    // cwd's own, so the pairing rules apply exactly as for plaintext.
    if ((!url || !key) && isDotenvxEncrypted(cwd)) {
      if (!url) url = trim(decryptDotenvKey(cwd, "AIOS_BRAIN_URL"));
      if (!key) key = trim(decryptDotenvKey(cwd, "AIOS_API_KEY"));
    }
  } catch {
    /* an unreadable workspace vault contributes nothing */
  }
  const team = trim(dotenv.AIOS_TEAM || yaml.team_id) || null;
  return { url, key, team };
}

/**
 * Resolve the Team Brain endpoint config WITHOUT validating or using it. Returns
 * `{ url, key, team, source, conflict }`.
 *
 * TRUST-DOMAIN BINDING (round-5 finding 3 + confirmation-pass D1/D2): when a credential
 * will be attached, the destination must come from the SAME trust domain as the key.
 *
 *   - OPERATOR: process env, agent-context.json, and the operator's own toolkit vault
 *     (AIOS_TOOLKIT_DIR → this package checkout's .env; scoped dotenvx decryption only).
 *     Complete (url+key) → wins outright; the cwd is never read.
 *   - WORKSPACE: the cwd's own files, per-field provenance by construction (above).
 *     Used ONLY when it supplies BOTH url and key itself.
 *
 * A cross-domain pairing (an untrusted clone's brain_url + the operator's key, or the
 * mirror) is returned as `{ url: null, key: null, conflict: { urlDomain, keyDomain } }` —
 * data, not a throw (D2): verbs that never contact the brain keep working, `aios slack
 * status` reports it, and web.mjs brainRequest raises the value-free refusal at the
 * point of credential attachment, before any byte leaves. Fields are never assembled
 * across domains.
 */
export async function resolveBrainConfig(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const brain = agentContext(env, home).brain ?? {};
  const foundation = await import("../../brain-config.mjs");
  const op = operatorBrainConfig(env, brain, toolkitRoot(env), foundation);
  if (op.url && op.key) {
    return {
      url: stripSlash(op.url),
      key: op.key,
      team: op.team,
      source: "operator",
      conflict: null,
    };
  }
  if (env.AIOS_DISABLE_WORKSPACE_CREDENTIALS === "1") {
    // Disabling a source can only remove credentials, never add or mix them.
    return { url: null, key: null, team: op.team, source: null, conflict: null };
  }
  // Workspace-domain candidate roots, each read in isolation (per-field provenance by
  // construction). AIOS_AGENT_WORKSPACE is an OPERATOR-SET env var designating a workspace
  // root for run-from-anywhere layouts (docs/integrations.md) — that operator designation
  // is what makes accepting it safe; a hostile cwd cannot set it. Both fields must still
  // come from ONE root: candidates never fill each other's gaps.
  const cwd = options.cwd ?? process.cwd();
  const candidates = [{ root: cwd, label: "workspace" }];
  const agentWorkspace = env.AIOS_AGENT_WORKSPACE;
  if (
    agentWorkspace &&
    path.isAbsolute(agentWorkspace) &&
    path.resolve(agentWorkspace) !== path.resolve(cwd)
  ) {
    candidates.push({ root: agentWorkspace, label: "agent-workspace" });
  }
  const reads = candidates.map(({ root, label }) => ({
    label,
    ...workspaceOwnBrainConfig(root, foundation),
  }));
  for (const candidate of reads) {
    const url = op.url || candidate.url;
    const key = op.key || candidate.key;
    if (!url || !key) continue;
    const urlDomain = op.url ? "operator" : candidate.label;
    const keyDomain = op.key ? "operator" : candidate.label;
    if (urlDomain !== keyDomain) continue; // cross-domain — reported below, never paired
    return {
      url: stripSlash(candidate.url),
      key: candidate.key,
      team: candidate.team || op.team,
      source: candidate.label,
      conflict: null,
    };
  }
  // No single-domain pairing exists. If a destination and a credential DO resolve — just
  // from different domains/roots — report the conflict (labels only, never values).
  const urlOwner = op.url ? "operator" : (reads.find((candidate) => candidate.url)?.label ?? null);
  const keyOwner = op.key ? "operator" : (reads.find((candidate) => candidate.key)?.label ?? null);
  if (urlOwner && keyOwner && urlOwner !== keyOwner) {
    return {
      url: null,
      key: null,
      team: op.team,
      source: null,
      conflict: { urlDomain: urlOwner, keyDomain: keyOwner },
    };
  }
  return { url: null, key: null, team: op.team, source: null, conflict: null };
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
        // A trust-domain conflict must fail LOUDLY here, not degrade into "no credential
        // source": silence would read as missing config while a hostile pairing sits in
        // the cwd (confirmation-pass D2 — raise at the point of use).
        if (brain.conflict) throw brainDomainConflictError(brain.conflict);
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
