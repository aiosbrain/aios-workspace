#!/usr/bin/env node
/**
 * connector-cli.mjs — `aios connector <action>` (AIO-600, GUI decoupling).
 *
 * The machine-readable connector surface over scripts/connector.mjs. It exists so
 * out-of-repo consumers — the GUI server first — drive the connector engine through
 * the CLI seam (`aios connector … --json`) instead of deep-importing toolkit
 * internals. Each action prints ONE JSON document to stdout:
 *
 *   { "status": <number>, "body": { … } }
 *
 * `status` is HTTP-shaped on purpose: the mapping (422 validation/credential
 * failures, 503 no brain connection, 502 OAuth relay error, 500 internal) is the
 * exact per-action logic the GUI's /api/connectors routes applied in-process before
 * this seam existed, lifted here so it lives in one place and every consumer agrees
 * on it. The process exits 0 whenever a JSON result was produced (even a 4xx/5xx
 * status — that is a *result*, not a CLI failure) and 1 only on usage errors.
 *
 * Secrets NEVER travel through argv (visible in `ps`). Actions that need them
 * (`validate`, `store` for non-OAuth descriptors) take `--secrets-stdin` and read a
 * JSON `{ "secrets": { ENV: value } }` document from stdin. Secrets are held in
 * memory only, never echoed, never logged — storeConnector persists them encrypted.
 *
 * Actions:
 *   list                      wired/available connectors
 *   blueprint                 pulled team blueprint + connectors
 *   oauth-start <id>          relay the brain's OAuth authorize URL
 *   oauth-status <id>         one-shot connected check against the brain
 *   validate <id>             live-validate secrets from stdin (never stores)
 *   store <id>                validate + store (OAuth descriptors: install after
 *                             the brain reports connected — no local secret)
 *   store-existing <id>       re-validate + store the saved local credential
 *   unwire <id>               remove artifact + secret lines, back to available
 */
import {
  listConnectors,
  getDescriptor,
  validateConnector,
  storeConnector,
  storeExistingConnector,
  unwireConnector,
  readBlueprint,
  startOAuth,
  checkOAuthStatus,
  storeOAuthConnector,
} from "./connector.mjs";
import { resolveBrainConfig } from "./brain-config.mjs";

const ACTIONS = new Set([
  "list",
  "blueprint",
  "oauth-start",
  "oauth-status",
  "validate",
  "store",
  "store-existing",
  "unwire",
]);
const NEEDS_ID = new Set([
  "oauth-start",
  "oauth-status",
  "validate",
  "store",
  "store-existing",
  "unwire",
]);

/**
 * Run one connector action and return its `{ status, body }` result. Pure with
 * respect to stdout (the cmd wrapper prints); `secrets` is the already-parsed
 * `{ ENV: value }` map for validate/store. The `impl` bag is injectable for tests.
 */
export async function connectorAction(repo, action, id, secrets = {}, impl = {}) {
  const {
    list = listConnectors,
    blueprint = readBlueprint,
    descriptor = getDescriptor,
    brainConfig = resolveBrainConfig,
    validate = validateConnector,
    store = storeConnector,
    storeExisting = storeExistingConnector,
    unwire = unwireConnector,
    oauthStart = startOAuth,
    oauthStatus = checkOAuthStatus,
    storeOAuth = storeOAuthConnector,
  } = impl;

  if (action === "list") return { status: 200, body: { connectors: list(repo) } };
  if (action === "blueprint") {
    return { status: 200, body: { blueprint: blueprint(repo), connectors: list(repo) } };
  }

  // OAuth relay: the token itself flows browser → brain and never transits here;
  // this only proxies start/status using the workspace's member key.
  if (action === "oauth-start" || action === "oauth-status") {
    try {
      const d = descriptor(repo, id);
      const cfg = brainConfig(repo);
      if (!cfg.brain_url || !cfg.api_key) {
        return { status: 503, body: { ok: false, error: "no_brain_connection" } };
      }
      const result =
        action === "oauth-start" ? await oauthStart(d, cfg) : await oauthStatus(d, cfg);
      return { status: 200, body: result };
    } catch (e) {
      return { status: 502, body: { ok: false, error: e.message } };
    }
  }

  try {
    const d = descriptor(repo, id);
    if (action === "unwire") return { status: 200, body: unwire(repo, d) };
    if (action === "store-existing") {
      const existing = await storeExisting(repo, d);
      return { status: existing.ok ? 200 : 422, body: existing };
    }
    if (action === "store" && d.auth_mode === "oauth") {
      const cfg = brainConfig(repo);
      if (!cfg.brain_url || !cfg.api_key) {
        return { status: 503, body: { ok: false, error: "no_brain_connection" } };
      }
      try {
        const stored = await storeOAuth(repo, d, cfg);
        return { status: 200, body: { ok: true, ...stored } };
      } catch (e) {
        if (e.code === "oauth_not_connected") {
          return {
            status: 422,
            body: { ok: false, error: "oauth_not_connected", message: e.message },
          };
        }
        throw e;
      }
    }
    const result = await validate(d, secrets);
    if (action === "validate") return { status: 200, body: result }; // checks/identity/instance — no secrets
    // store: only persist on a passing validation
    if (!result.ok) return { status: 422, body: { ok: false, validation: result } };
    const stored = store(repo, d, { ...secrets, ...(result.captured || {}) });
    return {
      status: 200,
      body: { ok: true, ...stored, identity: result.identity, instance: result.instance },
    };
  } catch (e) {
    return {
      status: e.code === "credential_missing" ? 422 : 500,
      body: { ok: false, error: e.message },
    };
  }
}

/** Read stdin to EOF and parse `{ secrets: {…} }` (bare object tolerated). */
async function readSecretsStdin(stream = process.stdin) {
  let raw = "";
  for await (const chunk of stream) raw += chunk;
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed.secrets && typeof parsed.secrets === "object" ? parsed.secrets : {};
  } catch {
    return {};
  }
}

/** `aios connector` entry (registry adapt). Returns a truthy status on usage error. */
export async function cmdConnector(repo, rest) {
  const args = rest.filter((a) => a !== "--json"); // JSON is the only output mode
  const secretsStdin = args.includes("--secrets-stdin");
  const positional = args.filter((a) => !a.startsWith("--"));
  const [action, id] = positional;
  if (!ACTIONS.has(action) || (NEEDS_ID.has(action) && !id)) {
    console.log(
      JSON.stringify({
        status: 400,
        body: {
          ok: false,
          error: `usage: aios connector <${[...ACTIONS].join("|")}> [id] [--secrets-stdin]`,
        },
      })
    );
    return 1;
  }
  const secrets = secretsStdin ? await readSecretsStdin() : {};
  const result = await connectorAction(repo, action, id, secrets);
  console.log(JSON.stringify(result));
  return 0;
}
