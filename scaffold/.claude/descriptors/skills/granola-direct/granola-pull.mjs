#!/usr/bin/env node
/**
 * granola-pull.mjs — pull Granola meeting notes + transcripts into the workspace.
 *
 * Our own Granola connector. It is dual-auth and uses NO MCP:
 *
 *   1. PUBLIC API (preferred, portable, any machine) — Business/Enterprise plan.
 *        GET https://public-api.granola.ai/v1/notes?limit=&cursor=&created_after=
 *        GET https://public-api.granola.ai/v1/notes/{id}?include=transcript
 *        Authorization: Bearer grn_…   (resolved from env → dotenvx → .env)
 *
 *   2. LOCAL APP TOKEN (fallback, works on ANY plan, this machine only) — used
 *      automatically when the public key is absent or returns 401/403, or with
 *      --local. Reuses the Granola desktop app's WorkOS session:
 *        token file: ~/Library/Application Support/Granola/supabase.json
 *        refresh:    POST https://api.granola.ai/v1/refresh-access-token {refresh_token}
 *        list:       POST https://api.granola.ai/v1/get-documents {}
 *        transcript: POST https://api.granola.ai/v1/get-document-transcript {document_id}
 *
 * No secret is ever printed and nothing leaves this machine except the calls above.
 *
 * Usage:
 *   node granola-pull.mjs [--since YYYY-MM-DD] [--limit N] [--repo PATH]
 *                         [--match SUBSTR] [--access TIER] [--local] [--force] [--dry-run]
 *
 *   --match   only write meetings whose title or participants contain SUBSTR (case-insensitive)
 *   --access  frontmatter access tier for written files (default: team; use private for sensitive)
 *   --local   force the local-app-token path (skip the public API)
 *   --force   explicitly replace an existing transcript with the connector copy
 *   --dry-run list what would be written without touching the filesystem
 *
 * Protecting a manual redaction: add `redacted: true` to a transcript's frontmatter
 * and this connector will always SKIP it (action "skip-redacted"), never overwriting
 * a deliberately-shortened note back to the full content — unless --force is passed.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_API = "https://public-api.granola.ai/v1";
const APP_API = "https://api.granola.ai/v1";
const TOKEN_FILE = path.join(homedir(), "Library", "Application Support", "Granola", "supabase.json");

// ── args ──
const argv = process.argv.slice(2);
const flag = (n, d = null) => { const i = argv.indexOf(n); return i !== -1 ? argv[i + 1] : d; };
const has = (n) => argv.includes(n);
const repo = path.resolve(flag("--repo", process.cwd()));
const since = flag("--since");                 // ISO date; maps to created_after
const limit = parseInt(flag("--limit", "25"), 10);
const match = (flag("--match") || "").toLowerCase();
const accessTier = flag("--access", "team");
const speakerName = flag("--speaker", "Speaker");   // label for the non-microphone party on 1:1 calls
const forceLocal = has("--local");
const force = has("--force");
const dryRun = has("--dry-run");

const slug = (s) => String(s || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] != null) return o[k]; return null; };
const log = (...a) => console.error(...a);   // diagnostics to stderr; never the secret

// ── resolve the public API key locally (never logged) ──
function resolvePublicKey() {
  if (process.env.GRANOLA_API_KEY) return process.env.GRANOLA_API_KEY;
  const envPath = path.join(repo, ".env");
  if (existsSync(envPath)) {
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
  return null;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  let text;
  try { text = buf.toString("utf8"); JSON.parse(text); }
  catch { try { text = gunzipSync(buf).toString("utf8"); } catch { /* keep utf8 */ } }
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { ok: res.ok, status: res.status, json };
}

// ── normalize a note/document into one shape ──
// { id, title, created, participants:[...], transcriptText }
function normalize({ id, title, created, participants, transcriptText }) {
  return { id, title: title || "untitled", created: created || "", participants: participants || [], transcriptText: transcriptText || "" };
}

function matches(note) {
  if (!match) return true;
  const hay = `${note.title} ${note.participants.join(" ")}`.toLowerCase();
  return hay.includes(match);
}

// ════════════════════════════ TRANSCRIPT RENDERING (shared) ═══════════════
// Granola segments mark speaker only by source: "microphone" = the note owner
// (you), anything else = the other party. We resolve a human label and merge
// consecutive same-speaker fragments into readable turns.
function speakerLabelFor(seg, ownerName) {
  const sp = seg.speaker;
  const src = typeof sp === "string" ? sp : (sp && sp.source);
  if (src === "microphone") return ownerName || "Me";
  if (sp && typeof sp === "object" && sp.name) return sp.name;
  return speakerName;                          // "speaker"/"system"/unknown → the named other party
}

function segmentsToTurns(segs, ownerName) {
  const turns = [];
  for (const s of segs) {
    const text = (s.text || "").trim();
    if (!text) continue;
    const who = speakerLabelFor(s, ownerName);
    const last = turns[turns.length - 1];
    if (last && last.who === who) last.text += " " + text;
    else turns.push({ who, text });
  }
  return turns.map((t) => `**${t.who}:** ${t.text}`).join("\n\n");
}

// ════════════════════════════ PUBLIC API PATH ════════════════════════════
function publicTranscriptText(note) {
  const t = note.transcript;
  const owner = note.owner && note.owner.name;
  if (!t) return "";
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return segmentsToTurns(t, owner);
  if (Array.isArray(t.segments)) return segmentsToTurns(t.segments, owner);
  if (typeof t.text === "string") return t.text;
  return "";
}

async function pullPublic(KEY) {
  const headers = { Authorization: `Bearer ${KEY}`, Accept: "application/json" };
  // list
  const items = [];
  let cursor = null;
  do {
    const qs = new URLSearchParams({ limit: String(Math.min(limit, 100)) });
    if (since) qs.set("created_after", since);
    if (cursor) qs.set("cursor", cursor);
    const { ok, status, json } = await fetchJson(`${PUBLIC_API}/notes?${qs}`, { headers });
    if (!ok) return { authFailed: status === 401 || status === 403, status, notes: null };
    const page = json || {};
    const pageItems = page.data || page.notes || page.items || (Array.isArray(page) ? page : []);
    items.push(...pageItems);
    cursor = page.next_cursor || page.cursor || (page.pagination && page.pagination.next_cursor) || null;
  } while (cursor && items.length < limit);

  const notes = [];
  for (const n of items.slice(0, limit)) {
    const id = pick(n, "id", "note_id", "uuid");
    const created = pick(n, "created_at", "created", "createdAt") || "";
    const participants = (n.participants || n.attendees || []).map((p) => (typeof p === "string" ? p : pick(p, "name", "email") || "")).filter(Boolean);
    const note = normalize({ id, title: pick(n, "title", "name"), created, participants, transcriptText: publicTranscriptText(n) });
    if (!matches(note)) continue;
    if (id && !note.transcriptText) {
      const { ok, json } = await fetchJson(`${PUBLIC_API}/notes/${id}?include=transcript`, { headers });
      if (ok && json) {
        note.transcriptText = publicTranscriptText(json) || pick(json, "summary_markdown", "summary", "notes", "content") || "";
        const att = (json.attendees || []).map((p) => (typeof p === "string" ? p : pick(p, "name", "email") || "")).filter(Boolean);
        if (att.length && !note.participants.length) note.participants = att;
      }
    }
    notes.push(note);
  }
  return { authFailed: false, notes };
}

// ════════════════════════════ LOCAL APP-TOKEN PATH ════════════════════════
function readWorkosTokens() {
  if (!existsSync(TOKEN_FILE)) return null;
  const d = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  let w = d.workos_tokens;
  w = typeof w === "string" ? JSON.parse(w) : w;
  return w || null;
}

async function localAccessToken() {
  const w = readWorkosTokens();
  if (!w || !w.access_token) {
    log("granola-pull: no local Granola session found. Open the Granola desktop app and sign in, then retry.");
    return null;
  }
  const fresh = (w.obtained_at || 0) + (w.expires_in || 0) * 1000 - 60_000 > Date.now();
  if (fresh) return w.access_token;
  // expired → refresh via the app's own endpoint (token held in memory only)
  if (!w.refresh_token) { log("granola-pull: local token expired and no refresh_token. Open the Granola app to re-auth."); return null; }
  const { ok, json } = await fetchJson(`${APP_API}/refresh-access-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: w.refresh_token }),
  });
  if (!ok || !json || !json.access_token) {
    log("granola-pull: token refresh failed. Open the Granola desktop app to refresh the session, then retry.");
    return null;
  }
  return json.access_token;
}

function localTranscriptText(entries, ownerName) {
  if (!Array.isArray(entries)) return "";
  // entries: { text, source } — source "microphone" = note owner, else other party.
  // Normalize to the shared segment shape and reuse turn-merging.
  const segs = entries.map((e) => ({ text: e.text, speaker: { source: e.source } }));
  return segmentsToTurns(segs, ownerName);
}

export function frontmatterValue(markdown, key) {
  const end = markdown.startsWith("---\n") ? markdown.indexOf("\n---\n", 4) : -1;
  if (end < 0) return null;
  const match = markdown.slice(4, end).match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "m"));
  return match?.[1] ?? null;
}

export function transcriptBody(markdown) {
  if (!markdown.startsWith("---\n")) return markdown.trim();
  const end = markdown.indexOf("\n---\n", 4);
  return (end < 0 ? markdown : markdown.slice(end + 5)).trim();
}

export function renderTranscript(note, tier) {
  const body = note.transcriptText || "(no transcript available)";
  return [
    "---",
    "type: transcript",
    "source: granola",
    `granola_id: ${note.id || ""}`,
    `created: ${note.created}`,
    note.participants.length
      ? `participants: [${note.participants.join(", ")}]`
      : "participants: []",
    `access: ${tier}`,
    "status: ingested",
    "---",
    "",
    `# ${note.title}`,
    "",
    body,
    "",
  ].join("\n");
}

export function existingTranscriptsById(destDir) {
  const found = new Map();
  if (!existsSync(destDir)) return found;
  for (const name of readdirSync(destDir)) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(destDir, name);
    const markdown = readFileSync(file, "utf8");
    const id = frontmatterValue(markdown, "granola_id");
    if (id && !found.has(id)) found.set(id, { file, markdown });
  }
  return found;
}

// A transcript is deliberately protected from connector overwrite by adding
// `redacted: true` to its frontmatter — the one opt-in marker a human sets after
// manually shortening a note to strip sensitive content before it syncs outward.
// A redaction is shorter by construction, so the length heuristic below would read
// it as "less complete" and clobber it back to the full transcript (AIO-503). Only
// an explicit --force is allowed to override this marker.
export function isRedacted(markdown) {
  return /^(true|yes)$/i.test((frontmatterValue(markdown, "redacted") || "").trim());
}

export function planTranscriptWrite({ note, destination, existing, accessTier, force = false }) {
  const requested = renderTranscript(note, accessTier);
  if (!existing) return { action: "write", file: destination, markdown: requested };
  if (force) return { action: "overwrite", file: existing.file, markdown: requested };

  // Opt-in redaction guard: never overwrite a hand-redacted transcript, regardless
  // of body length. Distinct action so the daily loop's log names the reason.
  if (isRedacted(existing.markdown)) {
    return { action: "skip-redacted", file: existing.file, markdown: existing.markdown };
  }

  const incomingBody = transcriptBody(requested);
  const currentBody = transcriptBody(existing.markdown);
  if (incomingBody.length <= currentBody.length) {
    return { action: "skip", file: existing.file, markdown: existing.markdown };
  }

  const preservedTier = frontmatterValue(existing.markdown, "access") || accessTier;
  return {
    action: "update",
    file: existing.file,
    markdown: renderTranscript(note, preservedTier),
  };
}

async function pullLocal() {
  const token = await localAccessToken();
  if (!token) return { notes: null };
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
  const { ok, json } = await fetchJson(`${APP_API}/get-documents`, { method: "POST", headers, body: "{}" });
  if (!ok || !json) { log("granola-pull: get-documents failed via local token."); return { notes: null }; }
  const docs = json.docs || json.documents || json.data || (Array.isArray(json) ? json : []);
  const sinceMs = since ? Date.parse(since) : 0;

  const notes = [];
  for (const d of docs) {
    const created = pick(d, "created_at", "created") || "";
    if (sinceMs && created && Date.parse(created) < sinceMs) continue;
    const people = (d.people || d.attendees || []);
    const participants = (Array.isArray(people) ? people : Object.values(people || {}))
      .map((p) => (typeof p === "string" ? p : pick(p, "name", "email") || "")).filter(Boolean);
    const note = normalize({ id: pick(d, "id", "document_id"), title: pick(d, "title", "name"), created, participants });
    if (!matches(note)) continue;
    const ownerName = (d.owner && d.owner.name) || (d.user && d.user.name) || "Me";
    const tr = await fetchJson(`${APP_API}/get-document-transcript`, { method: "POST", headers, body: JSON.stringify({ document_id: note.id }) });
    if (tr.ok && tr.json) note.transcriptText = localTranscriptText(tr.json.transcript || tr.json.entries || tr.json, ownerName);
    notes.push(note);
    if (notes.length >= limit) break;
  }
  return { notes };
}

// ════════════════════════════ DRIVER ════════════════════════════
// One clear, greppable line at the top of every run stating which auth path is
// active — the connector is dual-auth and otherwise picks a path silently.
async function main() {
  let result = { notes: null };
  let pathUsed = "";
  const KEY = forceLocal ? null : resolvePublicKey();

  if (KEY) {
    log("granola: using API key");
    result = await pullPublic(KEY);
    if (result.authFailed) {
      log(
        `granola: API key path failed (HTTP ${result.status}) — falling back to desktop-app session`
      );
      result = await pullLocal();
      if (!result.notes)
        log("granola: desktop-app session path also failed — see above for details.");
      pathUsed = "local (public key rejected)";
    } else {
      pathUsed = "public API";
    }
  } else {
    log(
      forceLocal
        ? "granola: using desktop-app session (--local)"
        : "granola: using desktop-app session (no API key set)"
    );
    result = await pullLocal();
    if (!result.notes)
      log("granola: desktop-app session path failed — see above for details.");
    pathUsed = "local app token";
  }

  const notes = result.notes;
  if (!notes) process.exitCode = 1;
  if (!notes) return;
  if (!notes.length) {
    console.log(`granola-pull: no notes matched (path: ${pathUsed}).`);
    return;
  }

  const destDir = path.join(
    repo,
    existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake",
    "transcripts"
  );
  if (!dryRun) mkdirSync(destDir, { recursive: true });
  const existing = existingTranscriptsById(destDir);

  const counts = { write: 0, update: 0, overwrite: 0, skip: 0, "skip-redacted": 0 };
  for (const note of notes) {
    const date = (note.created || "").slice(0, 10) || "undated";
    const destination = path.join(destDir, `${date}-${slug(note.title)}.md`);
    const plan = planTranscriptWrite({
      note,
      destination,
      existing: note.id ? existing.get(String(note.id)) : null,
      accessTier,
      force,
    });
    counts[plan.action]++;
    const rel = path.relative(repo, plan.file);
    if (dryRun) console.log(`  would ${plan.action} ${rel}`);
    else if (plan.action === "skip-redacted")
      console.log(`  🛡 preserved (redacted: true — kept, pass --force to override) ${rel}`);
    else if (plan.action === "skip") console.log(`  = preserved ${rel}`);
    else {
      writeFileSync(plan.file, plan.markdown);
      console.log(`  ✓ ${plan.action}d ${rel}`);
    }
  }
  console.log(
    `\ngranola-pull: ${dryRun ? "planned" : "finished"} ${notes.length} transcript(s) ` +
      `(new ${counts.write}, updated ${counts.update}, overwritten ${counts.overwrite}, ` +
      `preserved ${counts.skip}, redaction-protected ${counts["skip-redacted"]}) ` +
      `→ ${path.relative(repo, destDir)}/  [path: ${pathUsed}, access: ${accessTier}]`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
