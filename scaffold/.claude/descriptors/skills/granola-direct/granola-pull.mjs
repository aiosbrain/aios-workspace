#!/usr/bin/env node
/**
 * granola-pull.mjs — pull Granola meeting notes + transcripts into the workspace.
 *
 * Our own Granola connector: calls the Granola PUBLIC REST API directly (no MCP).
 * Base/auth/endpoints verified against https://docs.granola.ai/introduction on
 * 2026-06-14:
 *   GET https://public-api.granola.ai/v1/notes?limit=&cursor=&created_after=
 *   GET https://public-api.granola.ai/v1/notes/{id}?include=transcript
 *   Authorization: Bearer grn_…
 *
 * The API key is resolved locally (env → dotenvx → plain .env); it is never
 * printed and never leaves this machine.
 *
 * Usage:
 *   node .claude/skills/granola-direct/granola-pull.mjs [--since YYYY-MM-DD] [--limit N] [--repo PATH] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const API = "https://public-api.granola.ai/v1";

// ── args ──
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const repo = path.resolve(flag("--repo", process.cwd()));
const since = flag("--since");                 // ISO date; maps to created_after
const limit = parseInt(flag("--limit", "25"), 10);
const dryRun = has("--dry-run");

// ── resolve the API key locally (never logged) ──
function resolveKey() {
  if (process.env.GRANOLA_API_KEY) return process.env.GRANOLA_API_KEY;
  const envPath = path.join(repo, ".env");
  if (existsSync(envPath)) {
    // Prefer dotenvx (handles encrypted values); fall back to plain parse.
    try {
      const out = execFileSync("dotenvx", ["get", "GRANOLA_API_KEY", "-f", envPath], {
        cwd: repo, stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      if (out) return out;
    } catch { /* dotenvx absent or value not encrypted — fall through */ }
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*GRANOLA_API_KEY\s*=\s*(.+)\s*$/);
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  }
  console.error("granola-pull: no GRANOLA_API_KEY found (env or .env). Connect Granola first.");
  process.exit(1);
}
const KEY = resolveKey();
const headers = { Authorization: `Bearer ${KEY}`, Accept: "application/json" };

const slug = (s) => String(s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };

async function api(url) {
  const res = await fetch(url, { headers });
  if (!res.ok) { console.error(`granola-pull: ${res.status} on ${url.replace(API, "")}`); process.exit(1); }
  return res.json();
}

// ── list notes (defensive about the response envelope + field names) ──
async function listNotes() {
  const out = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (since) qs.set("created_after", since);
    if (cursor) qs.set("cursor", cursor);
    const page = await api(`${API}/notes?${qs}`);
    const items = page.data || page.notes || page.items || (Array.isArray(page) ? page : []);
    out.push(...items);
    cursor = page.next_cursor || page.cursor || (page.pagination && page.pagination.next_cursor) || null;
  } while (cursor && out.length < limit);
  return out.slice(0, limit);
}

function transcriptText(note) {
  const t = note.transcript;
  if (!t) return "";
  if (typeof t === "string") return t;
  if (typeof t.text === "string") return t.text;
  if (Array.isArray(t.segments)) return t.segments.map((s) => `${s.speaker ? s.speaker + ": " : ""}${s.text || ""}`).join("\n");
  if (Array.isArray(t)) return t.map((s) => `${s.speaker ? s.speaker + ": " : ""}${s.text || ""}`).join("\n");
  return "";
}

const destDir = path.join(repo, existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake", "transcripts");

const notes = await listNotes();
if (!notes.length) { console.log("granola-pull: no notes found for the given filter."); process.exit(0); }

if (!dryRun) mkdirSync(destDir, { recursive: true });
let wrote = 0;
for (const n of notes) {
  const id = pick(n, "id", "note_id", "uuid");
  const title = pick(n, "title", "name") || "untitled";
  const created = pick(n, "created_at", "created", "createdAt") || "";
  const date = (created || "").slice(0, 10) || "undated";
  const participants = (n.participants || n.attendees || []).map((p) => (typeof p === "string" ? p : pick(p, "name", "email") || "")).filter(Boolean);

  // fetch transcript on demand (documented: ?include=transcript)
  let full = n;
  if (id && !transcriptText(n)) {
    try { full = await api(`${API}/notes/${id}?include=transcript`); } catch { /* keep summary-only */ }
  }
  const body = transcriptText(full) || pick(full, "summary", "notes", "content") || "(no transcript available)";

  const fm = [
    "---",
    "type: transcript",
    "source: granola",
    `granola_id: ${id || ""}`,
    `created: ${created}`,
    participants.length ? `participants: [${participants.join(", ")}]` : "participants: []",
    "access: team",
    "status: ingested",
    "---",
    "",
    `# ${title}`,
    "",
    body,
    "",
  ].join("\n");

  const fname = `${date}-${slug(title)}.md`;
  if (dryRun) { console.log(`  would write ${path.relative(repo, path.join(destDir, fname))}`); }
  else { writeFileSync(path.join(destDir, fname), fm); console.log(`  ✓ ${path.relative(repo, path.join(destDir, fname))}`); }
  wrote++;
}
console.log(`\ngranola-pull: ${dryRun ? "would write" : "wrote"} ${wrote} transcript(s) → ${path.relative(repo, destDir)}/`);
