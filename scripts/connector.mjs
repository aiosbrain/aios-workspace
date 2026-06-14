#!/usr/bin/env node
/**
 * connector.mjs — the connector engine. Reused by the `aios connect` CLI verb and
 * the GUI server's /api/connectors endpoints.
 *
 * A connector descriptor (.claude/descriptors/<id>.json) drives one
 * connect → validate → store flow over two transports:
 *   - "mcp"   → writes an MCP server block into .mcp.json
 *   - "skill" → installs a direct-API skill into .claude/skills/<name>/
 *
 * Secrets are validated in memory (provider→localhost only), then stored ENCRYPTED
 * via dotenvx (.env ciphertext + .env.keys private key). Plaintext secrets are never
 * written to .mcp.json (placeholders only), never to descriptors, never logged.
 *
 * Zero npm deps (Node >= 18: built-in fetch; dotenvx CLI on PATH with .env fallback).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDescriptors } from "./gen-catalog.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_SCAFFOLD = path.join(SCRIPT_DIR, "..", "scaffold");

// ── descriptors + status ─────────────────────────────────────────────────────

// List connectable tools = descriptors, with live status merged from integrations.json.
export function listConnectors(repo) {
  const descs = readDescriptors(repo);
  const statuses = {};
  try {
    const ints = JSON.parse(readFileSync(path.join(repo, ".claude", "integrations.json"), "utf8")).integrations || [];
    for (const i of ints) statuses[i.id] = i.status;
  } catch { /* none */ }
  return Object.values(descs).map((d) => ({
    id: d.id, name: d.name, category: d.category, transport: d.transport, auth_mode: d.auth_mode || "token",
    summary: d.summary || "", scopes: d.scopes || [], scopes_advisory: !!d.scopes_advisory,
    secrets: (d.secrets || []).map((s) => ({ env: s.env, label: s.label, required: s.required !== false, placeholder: s.placeholder || "" })),
    docs: d.docs || {}, instance: d.instance || {},
    status: statuses[d.id] || d.status || "available",
    verified_against_docs: (d.docs && d.docs.verified_against_docs) || null,
  }));
}

export function getDescriptor(repo, id) {
  const d = readDescriptors(repo)[id];
  if (!d) throw new Error(`unknown connector '${id}'`);
  return d;
}

// ── template + path helpers ──────────────────────────────────────────────────

function resolve(str, values) {
  return String(str).replace(/\$\{([A-Za-z0-9_.]+)\}/g, (_, k) => (values[k] != null ? values[k] : ""));
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
  if (!v) return { ok: true, checks: [{ name: "config", ok: true, detail: "no validation configured" }], identity: null, instance: null };
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

  let res, json;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    res = await fetch(url, { method: v.method || "GET", headers, signal: ctrl.signal });
    clearTimeout(t);
  } catch (e) {
    const offline = e.name === "AbortError";
    return { ok: false, checks: [{ name: "reachable", ok: false, detail: offline ? "timed out — check your connection" : "couldn't reach the service" }], identity: null, instance: null, error: offline ? "offline" : "network" };
  }
  try { json = await res.json(); } catch { json = null; }

  // reachable + auth
  const wantStatus = (v.expect && v.expect.status) || 200;
  if (res.status === 401 || res.status === 403) {
    checks.push({ name: "reachable", ok: false, detail: "key rejected — it may be invalid, revoked, or lack access" });
    return { ok: false, checks, identity: null, instance: null, error: "invalid_key" };
  }
  if (res.status !== wantStatus) {
    checks.push({ name: "reachable", ok: false, detail: `unexpected response (HTTP ${res.status})` });
    return { ok: false, checks, identity: null, instance: null, error: "unexpected_status" };
  }
  checks.push({ name: "reachable", ok: true, detail: "key accepted" });

  // json_has assertions
  let ok = true;
  for (const key of (v.expect && v.expect.json_has) || []) {
    const present = json && getPath(json, key) != null;
    if (!present) ok = false;
  }

  // scope probe (optional second call)
  if (v.scope_probe) {
    try {
      const sUrl = resolve(v.scope_probe.url, values);
      const sRes = await fetch(sUrl, { method: "GET", headers });
      const sJson = await sRes.json().catch(() => null);
      const exp = v.scope_probe.expect || {};
      const got = exp.json_path ? getPath(sJson, exp.json_path) : sRes.ok;
      const pass = exp.equals !== undefined ? got === exp.equals : !!got;
      checks.push({ name: "scope", ok: pass, detail: pass ? "required permissions present" : "missing a required permission" });
      if (!pass) ok = false;
    } catch {
      checks.push({ name: "scope", ok: false, detail: "couldn't verify permissions" });
    }
  }

  // identity + instance (workspace) — for the confident "connected as … in …" message
  const identity = v.identity ? { label: v.identity.label || "Account", value: v.identity.json_path ? getPath(json, v.identity.json_path) : null } : null;
  const instance = v.instance_check ? { label: v.instance_check.label || "Workspace", value: v.instance_check.json_path ? getPath(json, v.instance_check.json_path) : null } : null;
  if (instance && instance.value) checks.push({ name: "workspace", ok: true, detail: instance.value });

  return { ok, checks, identity, instance, error: ok ? null : "incomplete" };
}

// ── secret vault (dotenvx) ───────────────────────────────────────────────────

function envPath(repo) { return path.join(repo, ".env"); }

// Encrypt+store a secret. dotenvx generates .env.keys + DOTENV_PUBLIC_KEY on first use.
export function vaultSet(repo, env, value) {
  const ep = envPath(repo);
  // dotenvx set no-ops (exit 0!) if the .env file is missing — create it first so the
  // first set bootstraps the keypair and encrypts.
  if (!existsSync(ep)) writeFileSync(ep, "");
  // Note: value passes as an execFile arg (no shell); on a shared host this is briefly
  // visible via `ps`. Acceptable for a single-user local app; hardening tracked for M5.
  execFileSync("dotenvx", ["set", env, value, "-f", ep], { cwd: repo, stdio: ["ignore", "ignore", "pipe"] });
  // dotenvx returns 0 even on some no-ops; assert the value actually landed encrypted.
  const back = vaultGet(repo, env);
  if (back !== value) throw new Error(`vault: failed to store ${env}`);
}
export function vaultGet(repo, env) {
  try {
    return execFileSync("dotenvx", ["get", env, "-f", envPath(repo)], { cwd: repo, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { return ""; }
}

function ensureGitignore(repo) {
  const gi = path.join(repo, ".gitignore");
  const need = [".env", ".env.keys"];
  let txt = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  const lines = new Set(txt.split("\n").map((l) => l.trim()));
  let changed = false;
  for (const n of need) if (!lines.has(n)) { txt = txt.replace(/\s*$/, "\n") + n + "\n"; changed = true; }
  if (changed) writeFileSync(gi, txt);
}

// ── store / unwire (transport dispatch) ──────────────────────────────────────

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
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
      if (e) { e.status = status; writeFileSync(ip, JSON.stringify(j, null, 2) + "\n"); }
    } catch { /* ignore */ }
  }
  // per-repo descriptor copy (so status survives + overrides bundled)
  const dp = path.join(repo, ".claude", "descriptors", `${id}.json`);
  if (existsSync(dp)) {
    try { const d = JSON.parse(readFileSync(dp, "utf8")); d.status = status; writeFileSync(dp, JSON.stringify(d, null, 2) + "\n"); }
    catch { /* ignore */ }
  }
}

/** Persist a validated connector. Encrypts secrets, writes the transport artifact, flips status. */
export function storeConnector(repo, descriptor, secretValues) {
  ensureGitignore(repo);
  for (const [env, value] of Object.entries(secretValues)) {
    if (value) vaultSet(repo, env, value);
  }

  if (descriptor.transport === "mcp") {
    const mcpPath = path.join(repo, ".mcp.json");
    let mcp = { mcpServers: {} };
    if (existsSync(mcpPath)) { try { mcp = JSON.parse(readFileSync(mcpPath, "utf8")); mcp.mcpServers = mcp.mcpServers || {}; } catch { /* reset */ } }
    const m = descriptor.mcp;
    mcp.mcpServers[m.server_key] = { command: m.command, args: m.args, ...(m.env_map ? { env: m.env_map } : {}) };
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
    try { execFileSync(process.execPath, [path.join(SCRIPT_DIR, "gen-catalog.mjs"), "--repo", repo], { stdio: "ignore" }); } catch { /* catalog refresh best-effort */ }
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
      try { const mcp = JSON.parse(readFileSync(mcpPath, "utf8")); if (mcp.mcpServers) delete mcp.mcpServers[descriptor.mcp.server_key]; writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n"); } catch { /* ignore */ }
    }
  }
  // drop the secret lines from .env (leave .env.keys/public key intact)
  const ep = envPath(repo);
  if (existsSync(ep)) {
    const envs = new Set((descriptor.secrets || []).map((s) => s.env));
    const kept = readFileSync(ep, "utf8").split("\n").filter((l) => { const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=/); return !(m && envs.has(m[1])); });
    writeFileSync(ep, kept.join("\n"));
  }
  flipStatus(repo, descriptor.id, "available");
  return { id: descriptor.id, status: "available" };
}
