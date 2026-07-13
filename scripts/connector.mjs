#!/usr/bin/env node
/**
 * connector.mjs — the connector engine. Reused by the `aios connect` CLI verb and
 * the GUI server's /api/connectors endpoints.
 *
 * A connector descriptor (.claude/descriptors/<id>.json) drives one
 * connect → validate → store flow over two transports:
 *   - "mcp"   → writes an MCP server block into .mcp.json
 *   - "skill" → installs a direct-API skill into .claude/skills/<name>/
 *   - "api"   → validates and stores local env only (no runtime artifact)
 *
 * Secrets are validated in memory (provider→localhost only), then stored ENCRYPTED
 * via dotenvx (.env ciphertext + .env.keys private key). Plaintext secrets are never
 * written to .mcp.json (placeholders only), never to descriptors, never logged.
 *
 * Zero npm deps (Node >= 18: built-in fetch; dotenvx CLI on PATH with .env fallback).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readDescriptors } from "./gen-catalog.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCAFFOLD = path.join(SCRIPT_DIR, "..", "scaffold");

// ── descriptors + status ─────────────────────────────────────────────────────

// The team blueprint a lead published (which tools the team uses + non-secret
// instance config), pulled into .aios/blueprint.json. Null if none pulled yet.
export function readBlueprint(repo) {
  const p = path.join(repo, ".aios", "blueprint.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// Granola (AIO-356) is dual-auth: an optional portable API key, falling back to the
// signed-in local desktop-app session — and it otherwise picks that path silently.
// Report which one is currently active so connector status output can surface it
// instead of leaving auth resolution invisible until an ingestion run fails.
function granolaTokenFile() {
  return path.join(homedir(), "Library", "Application Support", "Granola", "supabase.json");
}
export function granolaAuthPath(repo) {
  if (vaultGet(repo, "GRANOLA_API_KEY")) return { mode: "api-key", label: "API key" };
  const signedIn = existsSync(granolaTokenFile());
  return {
    mode: "desktop-app",
    label: signedIn ? "desktop-app session" : "desktop-app session (not signed in)",
  };
}

// List connectable tools = descriptors, with live status merged from integrations.json,
// and (if a team blueprint was pulled) team_enabled + the team's instance config merged in.
export function listConnectors(repo) {
  const descs = readDescriptors(repo);
  const statuses = {};
  try {
    const ints =
      JSON.parse(readFileSync(path.join(repo, ".claude", "integrations.json"), "utf8"))
        .integrations || [];
    for (const i of ints) statuses[i.id] = i.status;
  } catch {
    /* none */
  }
  const bp = readBlueprint(repo);
  const teamConn = (bp && bp.connectors) || {};
  return Object.values(descs).map((d) => {
    const t = teamConn[d.id];
    return {
      id: d.id,
      name: d.name,
      category: d.category,
      transport: d.transport,
      auth_mode: d.auth_mode || "token",
      summary: d.summary || "",
      scopes: d.scopes || [],
      scopes_advisory: !!d.scopes_advisory,
      secrets: (d.secrets || []).map((s) => ({
        env: s.env,
        label: s.label,
        required: s.required !== false,
        placeholder: s.placeholder || "",
      })),
      docs: d.docs || {},
      // shared, lead-set config fields (e.g. the Jira site URL) the Team tab collects
      team_instance: d.team_instance || [],
      // team instance config (e.g. the Jira site URL) overrides/augments the descriptor's
      instance: { ...(d.instance || {}), ...((t && t.instance) || {}) },
      status: statuses[d.id] || d.status || "available",
      team_enabled: !!(t && t.enabled),
      verified_against_docs: (d.docs && d.docs.verified_against_docs) || null,
      // Dual-auth connectors (currently just Granola) report which path is active —
      // see granolaAuthPath. Other connectors get null; this is not a general auth
      // resolution mechanism, just observability for the one connector that has it.
      auth_path: d.id === "granola" ? granolaAuthPath(repo) : null,
    };
  });
}

export function getDescriptor(repo, id) {
  const d = readDescriptors(repo)[id];
  if (!d) throw new Error(`unknown connector '${id}'`);
  return d;
}

// ── template + path helpers ──────────────────────────────────────────────────

function resolve(str, values) {
  return String(str).replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_, k) =>
    values[k] != null ? values[k] : ""
  );
}
function getPath(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ── validate (live, provider→localhost, in-memory secret) ────────────────────

/**
 * Run the descriptor's validate spec against in-memory secret values.
 * Returns { ok, checks:[{name,ok,detail}], identity, instance, error }.
 * Secrets are never echoed in the result.
 */
export async function validateConnector(descriptor, secretValues, { timeoutMs = 9000 } = {}) {
  const v = descriptor.validate;
  if (!v)
    return {
      ok: true,
      checks: [{ name: "config", ok: true, detail: "no validation configured" }],
      identity: null,
      instance: null,
    };
  const values = { ...secretValues, ...(descriptor.instance || {}) };

  // headers (resolve ${ENV}); optional "basic:${EMAIL}:${TOKEN}" shorthand
  const headers = {};
  for (const [k, val] of Object.entries(v.headers || {})) headers[k] = resolve(val, values);
  if (v.auth && v.auth.startsWith("basic:")) {
    const [, rest] = v.auth.split("basic:");
    const [u, p] = resolve(rest, values).split(":");
    headers["Authorization"] = "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
  }
  const url = resolve(v.url, values);
  const checks = [];

  const init = { method: v.method || "GET", headers };
  if (v.body) {
    init.body = typeof v.body === "string" ? v.body : JSON.stringify(v.body);
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
  }

  let res, json;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    res = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(t);
  } catch (e) {
    const offline = e.name === "AbortError";
    return {
      ok: false,
      checks: [
        {
          name: "reachable",
          ok: false,
          detail: offline ? "timed out — check your connection" : "couldn't reach the service",
        },
      ],
      identity: null,
      instance: null,
      error: offline ? "offline" : "network",
    };
  }
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  // reachable + auth
  const wantStatus = (v.expect && v.expect.status) || 200;
  if (res.status === 401 || res.status === 403) {
    checks.push({
      name: "reachable",
      ok: false,
      detail: "key rejected — it may be invalid, revoked, or lack access",
    });
    return { ok: false, checks, identity: null, instance: null, error: "invalid_key" };
  }
  if (res.status !== wantStatus) {
    checks.push({
      name: "reachable",
      ok: false,
      detail: `unexpected response (HTTP ${res.status})`,
    });
    return { ok: false, checks, identity: null, instance: null, error: "unexpected_status" };
  }
  // Some APIs return 200 even for bad keys (Slack `{ok:false}`, GraphQL `{errors}`):
  // treat a declared `expect.ok_path` / `expect.json_has` miss as a rejected key.
  const okPathFail = v.expect && v.expect.ok_path && getPath(json, v.expect.ok_path) !== true;
  const jsonHasFail = ((v.expect && v.expect.json_has) || []).some(
    (k) => !(json && getPath(json, k) != null)
  );
  if (okPathFail || jsonHasFail) {
    const reason =
      json && json.error
        ? `rejected (${json.error})`
        : "key rejected — invalid, revoked, or lacks access";
    checks.push({ name: "reachable", ok: false, detail: reason });
    return { ok: false, checks, identity: null, instance: null, error: "invalid_key" };
  }
  checks.push({ name: "reachable", ok: true, detail: "key accepted" });
  let ok = true;

  // scope probe (optional second call)
  if (v.scope_probe) {
    try {
      const sUrl = resolve(v.scope_probe.url, values);
      const sRes = await fetch(sUrl, { method: "GET", headers });
      const sJson = await sRes.json().catch(() => null);
      const exp = v.scope_probe.expect || {};
      const got = exp.json_path ? getPath(sJson, exp.json_path) : sRes.ok;
      const pass = exp.equals !== undefined ? got === exp.equals : !!got;
      checks.push({
        name: "scope",
        ok: pass,
        detail: pass ? "required permissions present" : "missing a required permission",
      });
      if (!pass) ok = false;
    } catch {
      checks.push({ name: "scope", ok: false, detail: "couldn't verify permissions" });
    }
  }

  // identity + instance (workspace) — for the confident "connected as … in …" message
  const identity = v.identity
    ? {
        label: v.identity.label || "Account",
        value: v.identity.json_path ? getPath(json, v.identity.json_path) : null,
      }
    : null;
  const instance = v.instance_check
    ? {
        label: v.instance_check.label || "Workspace",
        value: v.instance_check.json_path ? getPath(json, v.instance_check.json_path) : null,
      }
    : null;
  if (instance && instance.value)
    checks.push({ name: "workspace", ok: true, detail: instance.value });

  // capture derived env values from the response (e.g. Slack team_id) to store too
  const captured = {};
  for (const [env, jp] of Object.entries(v.capture || {})) {
    const val = getPath(json, jp);
    if (val != null) captured[env] = String(val);
  }

  return { ok, checks, identity, instance, captured, error: ok ? null : "incomplete" };
}

// ── OAuth (one-click, token lives in the brain) ──────────────────────────────
//
// For auth_mode:"oauth" descriptors the secret NEVER touches this machine — the
// browser authorizes the brain, which stores the per-member token. startOAuth asks
// the brain for an authorize_url; pollOAuthStatus waits for the browser leg to land;
// postBrainToken is the manual fallback (paste a token → straight to the brain).
// All take an injectable fetchImpl so they unit-test without a network.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function brainUrlOf(cfg) {
  return cfg.brainUrl || cfg.brain_url || "";
}
function oauthHeaders(cfg) {
  return {
    Authorization: `Bearer ${cfg.apiKey || cfg.api_key || ""}`,
    "X-AIOS-Team": cfg.teamId || cfg.team_id || "",
  };
}

/** GET the descriptor's oauth.start_url with the member key → { authorize_url }. */
export async function startOAuth(descriptor, cfg, { fetchImpl = fetch } = {}) {
  const url = resolve((descriptor.oauth || {}).start_url || "", { BRAIN_URL: brainUrlOf(cfg) });
  const res = await fetchImpl(url, { method: "GET", headers: oauthHeaders(cfg) });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.authorize_url) {
    throw new Error(
      `oauth start failed: ${(json && (json.message || json.error)) || `HTTP ${res.status}`}`
    );
  }
  return { authorize_url: json.authorize_url };
}

/** GET the descriptor's oauth.status_url once → { connected, slack_user_id, workspace }. */
export async function checkOAuthStatus(descriptor, cfg, { fetchImpl = fetch } = {}) {
  const url = resolve((descriptor.oauth || {}).status_url || "", { BRAIN_URL: brainUrlOf(cfg) });
  const res = await fetchImpl(url, { method: "GET", headers: oauthHeaders(cfg) });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `oauth status failed: ${(json && (json.message || json.error)) || `HTTP ${res.status}`}`
    );
  }
  return {
    connected: !!json?.connected,
    slack_user_id: json?.slack_user_id ?? null,
    workspace: json?.workspace ?? null,
  };
}

/** Poll oauth.status_url until connected:true or the deadline (throws Error 'oauth_timeout'). */
export async function pollOAuthStatus(
  descriptor,
  cfg,
  { fetchImpl = fetch, timeoutMs = 120000, intervalMs = 2000, onTick } = {}
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await checkOAuthStatus(descriptor, cfg, { fetchImpl });
    if (status.connected) return status;
    if (Date.now() + intervalMs >= deadline) {
      const e = new Error("oauth_timeout");
      e.code = "oauth_timeout";
      throw e;
    }
    onTick?.();
    await sleep(intervalMs);
  }
}

/** Manual fallback: POST a pasted user token to the descriptor's fallback.store_url. */
export async function postBrainToken(descriptor, cfg, token, { fetchImpl = fetch } = {}) {
  const url = resolve((descriptor.fallback || {}).store_url || "", { BRAIN_URL: brainUrlOf(cfg) });
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { ...oauthHeaders(cfg), "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.ok === false) {
    throw new Error(
      `store token failed: ${(json && (json.message || json.error)) || `HTTP ${res.status}`}`
    );
  }
  return json || {};
}

/** Install an oauth connector only after the brain reports connected (token lives there). */
export async function storeOAuthConnector(repo, descriptor, cfg, { fetchImpl = fetch } = {}) {
  const status = await checkOAuthStatus(descriptor, cfg, { fetchImpl });
  if (!status.connected) {
    const e = new Error("oauth_not_connected");
    e.code = "oauth_not_connected";
    throw e;
  }
  const stored = storeConnector(repo, descriptor, {});
  return {
    ...stored,
    identity: status.slack_user_id ? { label: "You", value: status.slack_user_id } : null,
    instance: status.workspace ? { label: "Workspace", value: status.workspace } : null,
  };
}

// ── secret vault (dotenvx) ───────────────────────────────────────────────────

function envPath(repo) {
  return path.join(repo, ".env");
}

// dotenvx reads DOTENV_PUBLIC_KEY/DOTENV_PRIVATE_KEY from the environment if present,
// which take priority over the repo's own .env.keys. An ambient shell that already has
// one set (e.g. from a different project's dotenvx setup, or an env cascade like
// Tessera's) silently breaks per-workspace key generation — `set` then encrypts against
// the WRONG key and `get` can never decrypt it back, with no visible error. Strip both
// so every vaultSet/vaultGet always uses this repo's own .env.keys, regardless of what's
// ambient in the caller's shell.
function dotenvxEnv() {
  const env = { ...process.env };
  delete env.DOTENV_PUBLIC_KEY;
  delete env.DOTENV_PRIVATE_KEY;
  return env;
}

// Encrypt+store a secret. dotenvx generates .env.keys + DOTENV_PUBLIC_KEY on first use.
export function vaultSet(repo, env, value) {
  const ep = envPath(repo);
  // dotenvx set no-ops (exit 0!) if the .env file is missing — create it first so the
  // first set bootstraps the keypair and encrypts.
  if (!existsSync(ep)) writeFileSync(ep, "");
  // Note: value passes as an execFile arg (no shell); on a shared host this is briefly
  // visible via `ps`. Acceptable for a single-user local app; hardening tracked for M5.
  try {
    execFileSync("dotenvx", ["set", env, value, "-f", ep], {
      cwd: repo,
      env: dotenvxEnv(),
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    if (e.code === "ENOENT") {
      throw new Error(
        `vault: dotenvx isn't on PATH — install it (npm i -g @dotenvx/dotenvx), or run this from the toolkit repo where it's already a dependency`
      );
    }
    const stderr = (e.stderr || "").toString().trim();
    throw new Error(`vault: dotenvx failed to set ${env}${stderr ? ` — ${stderr}` : ""}`);
  }
  // dotenvx returns 0 even on some no-ops; assert the value actually landed encrypted.
  const back = vaultGet(repo, env);
  if (back !== value) {
    throw new Error(`vault: ${env} didn't take — check that .env is writable, then retry`);
  }
}
export function vaultGet(repo, env) {
  try {
    return execFileSync("dotenvx", ["get", env, "-f", envPath(repo)], {
      cwd: repo,
      env: dotenvxEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

export function ensureGitignore(repo, entries = [".env", ".env.keys"]) {
  const gi = path.join(repo, ".gitignore");
  let txt = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const lines = new Set(txt.split("\n").map((l) => l.trim()));
  let changed = false;
  for (const n of entries)
    if (!lines.has(n)) {
      txt = txt.replace(/\s*$/, "\n") + n + "\n";
      changed = true;
    }
  if (changed) writeFileSync(gi, txt);
}

/**
 * Snapshot .env/aios.yaml before an interactive wizard starts mutating them (Hermes
 * pattern) — so a failed or interrupted run has a way back instead of leaving a
 * half-written config with no undo. Returns the backup paths written (empty if
 * neither file exists yet, e.g. a fresh scaffold with no secrets set).
 */
export function backupConfig(repo, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const written = [];
  for (const name of [".env", "aios.yaml"]) {
    const src = path.join(repo, name);
    if (!existsSync(src)) continue;
    const dest = path.join(repo, `${name}.bak.${stamp}`);
    writeFileSync(dest, readFileSync(src));
    written.push(dest);
  }
  if (written.length) ensureGitignore(repo, [".env.bak.*", "aios.yaml.bak.*"]);
  return written;
}

// ── store / unwire (transport dispatch) ──────────────────────────────────────

export function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name),
      d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else writeFileSync(d, readFileSync(s));
  }
}

function flipStatus(repo, id, status) {
  // integrations.json (catalog/status store)
  const ip = path.join(repo, ".claude", "integrations.json");
  if (existsSync(ip)) {
    try {
      const j = JSON.parse(readFileSync(ip, "utf8"));
      const e = (j.integrations || []).find((x) => x.id === id);
      if (e) {
        e.status = status;
        writeFileSync(ip, JSON.stringify(j, null, 2) + "\n");
      }
    } catch {
      /* ignore */
    }
  }
  // per-repo descriptor copy (so status survives + overrides bundled)
  const dp = path.join(repo, ".claude", "descriptors", `${id}.json`);
  if (existsSync(dp)) {
    try {
      const d = JSON.parse(readFileSync(dp, "utf8"));
      d.status = status;
      writeFileSync(dp, JSON.stringify(d, null, 2) + "\n");
    } catch {
      /* ignore */
    }
  }
}

/** Persist a validated connector. Encrypts secrets, writes the transport artifact, flips status. */
export function storeConnector(repo, descriptor, secretValues) {
  ensureGitignore(repo);
  // OAuth connectors keep their secret in the brain, never on this machine — never vault it.
  if (descriptor.auth_mode !== "oauth") {
    for (const [env, value] of Object.entries(secretValues)) {
      if (value) vaultSet(repo, env, value);
    }
  }

  if (descriptor.transport === "mcp") {
    const mcpPath = path.join(repo, ".mcp.json");
    let mcp = { mcpServers: {} };
    if (existsSync(mcpPath)) {
      try {
        mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
        mcp.mcpServers = mcp.mcpServers || {};
      } catch {
        /* reset */
      }
    }
    const m = descriptor.mcp;
    mcp.mcpServers[m.server_key] = {
      command: m.command,
      args: m.args,
      ...(m.env_map ? { env: m.env_map } : {}),
    };
    writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  } else if (descriptor.transport === "skill") {
    const name = descriptor.skill.skill_name;
    // source: repo descriptors first, else bundled scaffold
    const candidates = [
      path.join(repo, ".claude", "descriptors", "skills", name),
      path.join(BUNDLED_SCAFFOLD, ".claude", "descriptors", "skills", name),
    ];
    const src = candidates.find((p) => existsSync(p));
    if (!src) throw new Error(`skill source not found for '${name}'`);
    copyDir(src, path.join(repo, ".claude", "skills", name));
    try {
      execFileSync(process.execPath, [path.join(SCRIPT_DIR, "gen-catalog.mjs"), "--repo", repo], {
        stdio: "ignore",
      });
    } catch {
      /* catalog refresh best-effort */
    }
  } else if (descriptor.transport === "api") {
    // Secret/config only: validation + vault storage above, then status flip below.
  } else {
    throw new Error(`unknown transport '${descriptor.transport}'`);
  }

  flipStatus(repo, descriptor.id, "wired");
  return { id: descriptor.id, status: "wired", transport: descriptor.transport };
}

/** Remove a connector's artifact + secret line, flip status back to available. */
export function unwireConnector(repo, descriptor) {
  if (descriptor.transport === "mcp") {
    const mcpPath = path.join(repo, ".mcp.json");
    if (existsSync(mcpPath)) {
      try {
        const mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
        if (mcp.mcpServers) delete mcp.mcpServers[descriptor.mcp.server_key];
        writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
      } catch {
        /* ignore */
      }
    }
  }
  // drop the secret lines from .env (leave .env.keys/public key intact)
  const ep = envPath(repo);
  if (existsSync(ep)) {
    const envs = new Set((descriptor.secrets || []).map((s) => s.env));
    const kept = readFileSync(ep, "utf8")
      .split("\n")
      .filter((l) => {
        const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=/);
        return !(m && envs.has(m[1]));
      });
    writeFileSync(ep, kept.join("\n"));
  }
  flipStatus(repo, descriptor.id, "available");
  return { id: descriptor.id, status: "available" };
}
