#!/usr/bin/env node
/**
 * suggest-connectors.mjs — match the tools a Firecrawl onboarding extract mentioned
 * against this workspace's own connectable connectors, so onboarding can offer a
 * concrete next step ("you mentioned Slack, Jira — connect them in Integrations").
 *
 * Self-contained, zero-dependency. Reads only this workspace's files:
 *   .claude/descriptors/*.json   → the CONNECTABLE set (has a descriptor) + each `status`
 *   .claude/integrations.json    → the RECOGNIZED set (curated catalog; some have no descriptor)
 * No toolkit dependency, no `aios` on PATH, no network.
 *
 * SECURITY: the tool strings come from `results[].extracted.tools_mentioned`, which was
 * scraped from untrusted web pages. They are treated purely as DATA — parsed, normalized,
 * and matched against a local index. They are NEVER executed, and (by the calling
 * SKILL.md contract) never shell-interpolated: only a controlled file path reaches argv.
 *
 * Input (extract JSON shape from firecrawl-extract.mjs):
 *   { results: [ { extracted: { tools_mentioned: ["Slack", "Jira", …] } }, … ] }
 *   via  --extract <file>   OR   piped on stdin.
 *
 * Output (stdout, JSON):
 *   { connectable: [ { id, name, category } ], recognized_not_connectable: [ { name } ] }
 *   - connectable  = mentioned tool matched a descriptor AND its status !== "wired".
 *                    Deduped by id; emitted in stable catalog (descriptor) order.
 *   - recognized_not_connectable = mentioned tool matched only a descriptor-less
 *                    integrations.json entry (e.g. github/gmail). DATA, never a CTA.
 *
 * Usage:
 *   node .claude/skills/workspace-setup/suggest-connectors.mjs --extract <file> [--repo PATH]
 *   node .claude/skills/firecrawl-direct/firecrawl-extract.mjs … | node …/suggest-connectors.mjs --repo .
 */

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── normalization + a small alias map (alias → canonical descriptor id/name token) ──
export function normalize(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Aliases map a normalized scraped token to a connector's normalized id.
// Keep small and deliberate: brand/umbrella names that don't equal the descriptor id.
const ALIASES = {
  atlassian: "jira",        // Atlassian umbrella → Jira. Jira was demoted to example-only
                            // (V1.0 supply-chain hardening: no jira descriptor, no
                            // integrations.json entry), so this alias now resolves to
                            // nothing and degrades gracefully — a mentioned "Jira"/
                            // "Atlassian" is never surfaced as a connectable CTA.
  gsuite: "gmail",          // recognized-only; resolves into integrations.json (id "google")
  googleworkspace: "gmail",
};

/**
 * Build the matcher's two indexes from a workspace's catalog files.
 *  - connectable index: normalize(name)+normalize(id)+aliases → { id, name, category, status }
 *    (one entry per descriptor; stable catalog order preserved separately)
 *  - recognized index: normalize(name)+normalize(id) → { name } for integrations.json
 *    entries that have NO descriptor (descriptor-less = not connectable).
 */
export function loadCatalog(repo) {
  const descDir = path.join(repo, ".claude", "descriptors");
  const descriptors = [];
  if (existsSync(descDir)) {
    for (const f of readdirSync(descDir).sort()) {        // stable alphabetical catalog order
      if (!f.endsWith(".json")) continue;                  // ignore the skills/ subdir, etc.
      let d;
      try { d = JSON.parse(readFileSync(path.join(descDir, f), "utf8")); }
      catch { continue; }
      if (d && typeof d.id === "string") {
        descriptors.push({ id: d.id, name: d.name || d.id, category: d.category || null, status: d.status || null });
      }
    }
  }

  const connectableIndex = new Map();   // normalized token → descriptor
  const descriptorIds = new Set();
  for (const d of descriptors) {
    descriptorIds.add(d.id);
    connectableIndex.set(normalize(d.id), d);
    connectableIndex.set(normalize(d.name), d);
  }
  // aliases that resolve to a real descriptor id become connectable matches too
  for (const [alias, target] of Object.entries(ALIASES)) {
    const d = descriptors.find((x) => x.id === target);
    if (d) connectableIndex.set(normalize(alias), d);
  }

  // recognized-but-not-connectable: integrations.json entries lacking a descriptor
  const recognizedIndex = new Map();    // normalized token → { name }
  const integrationsPath = path.join(repo, ".claude", "integrations.json");
  if (existsSync(integrationsPath)) {
    let cat = null;
    try { cat = JSON.parse(readFileSync(integrationsPath, "utf8")); } catch { cat = null; }
    const list = (cat && Array.isArray(cat.integrations)) ? cat.integrations : [];
    for (const it of list) {
      if (!it || typeof it.id !== "string") continue;
      if (descriptorIds.has(it.id)) continue;              // has a descriptor → connectable, skip
      const entry = { name: it.name || it.id };
      recognizedIndex.set(normalize(it.id), entry);
      recognizedIndex.set(normalize(it.name), entry);
    }
    // recognized-only aliases (e.g. gsuite/googleworkspace → google) when they resolve here
    for (const [alias, target] of Object.entries(ALIASES)) {
      if (connectableIndex.has(normalize(alias))) continue; // already a connectable alias
      const hit = recognizedIndex.get(normalize(target)) ||
        list.filter((x) => x && x.id === target).map((x) => ({ name: x.name || x.id }))[0];
      if (hit) recognizedIndex.set(normalize(alias), hit);
    }
  }

  return { descriptors, connectableIndex, recognizedIndex };
}

/** Pull tool strings out of the extract JSON. Defensive: missing/odd shapes → []. */
export function toolsFromExtract(extract) {
  const out = [];
  const results = extract && Array.isArray(extract.results) ? extract.results : [];
  for (const r of results) {
    const t = r && r.extracted && r.extracted.tools_mentioned;
    if (Array.isArray(t)) for (const s of t) if (typeof s === "string") out.push(s);
  }
  return out;
}

/**
 * Core matcher. Given the parsed catalog and a list of mentioned tool strings, return
 * { connectable, recognized_not_connectable }. Connectable is deduped by id, emitted in
 * stable catalog order (NOT tools order), and excludes status === "wired". team_enabled
 * is NOT consulted.
 */
export function suggest(catalog, tools) {
  const matchedConnectable = new Set();   // descriptor ids
  const recognizedNames = new Map();      // name → true (deduped, first-seen order)

  for (const raw of tools) {
    const key = normalize(raw);
    if (!key) continue;
    const d = catalog.connectableIndex.get(key);
    if (d) {
      if (d.status !== "wired") matchedConnectable.add(d.id);
      continue;                            // a connectable match is never also "recognized-only"
    }
    const rec = catalog.recognizedIndex.get(key);
    if (rec && !recognizedNames.has(rec.name)) recognizedNames.set(rec.name, true);
  }

  // stable catalog order from the descriptor list
  const connectable = catalog.descriptors
    .filter((d) => matchedConnectable.has(d.id))
    .map((d) => ({ id: d.id, name: d.name, category: d.category }));

  const recognized_not_connectable = [...recognizedNames.keys()].map((name) => ({ name }));

  return { connectable, recognized_not_connectable };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
  const repo = path.resolve(flag("--repo", process.cwd()));
  const extractPath = flag("--extract", null);

  let rawJson;
  if (extractPath) {
    if (!existsSync(extractPath)) {
      console.error(`suggest-connectors: --extract file not found: ${extractPath}`);
      process.exit(1);
    }
    rawJson = readFileSync(extractPath, "utf8");
  } else {
    rawJson = readStdin();
    if (!rawJson.trim()) {
      console.error("suggest-connectors: no input — pass --extract <file> or pipe extract JSON on stdin");
      process.exit(1);
    }
  }

  let extract;
  try { extract = JSON.parse(rawJson); }
  catch { console.error("suggest-connectors: input is not valid JSON"); process.exit(1); }

  const catalog = loadCatalog(repo);
  const tools = toolsFromExtract(extract);
  const result = suggest(catalog, tools);
  console.log(JSON.stringify(result, null, 2));
}

// run as CLI only when invoked directly (not when imported by tests). realpath both
// sides so a symlinked invocation path (e.g. /tmp → /private/tmp on macOS) still matches.
function isMain() {
  if (!process.argv[1]) return false;
  const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
  return real(process.argv[1]) === real(fileURLToPath(import.meta.url));
}
if (isMain()) main();
