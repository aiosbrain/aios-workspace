// Full-content chat search for GET /api/sessions/search?q=. Pure + bounded so it can be
// unit-tested without booting the HTTP server. Every limit below is a hard ceiling: the
// search never loads an unbounded transcript, never scans the whole index, and never
// returns raw event JSON or markup.
import { openSync, readSync, closeSync, statSync } from "node:fs";
import path from "node:path";

export const SEARCH_LIMITS = {
  maxQueryLen: 200, // clamp the query (defense; substring match, no regex)
  maxSessions: 200, // newest-first; stop scanning past this many sessions
  maxBytes: 256 * 1024, // per-transcript: read at most this many bytes
  maxResults: 50, // stop once we have this many hits
  snippetLen: 160, // plain-text excerpt cap
};

/** Read at most `maxBytes` of a file as utf8 without loading the whole thing. */
function readCapped(file, maxBytes) {
  let fd;
  try {
    const size = statSync(file).size;
    const n = Math.min(size, maxBytes);
    if (n <= 0) return "";
    fd = openSync(file, "r");
    const buf = Buffer.allocUnsafe(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.toString("utf8", 0, read);
  } catch {
    return ""; // missing / unreadable → no content (skip, never throw)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* noop */
      }
    }
  }
}

/** Strip HTML/markup and collapse whitespace so a snippet can't inject markup. */
export function plainText(s) {
  return String(s || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a capped excerpt of `text` centered on the first match of `needleLower`. */
function makeSnippet(text, needleLower, snippetLen) {
  const clean = plainText(text);
  const at = clean.toLowerCase().indexOf(needleLower);
  if (at < 0) return clean.slice(0, snippetLen) + (clean.length > snippetLen ? " …" : "");
  const pad = Math.max(0, Math.floor((snippetLen - needleLower.length) / 2));
  const start = Math.max(0, at - pad);
  const end = Math.min(clean.length, start + snippetLen);
  return (start > 0 ? "… " : "") + clean.slice(start, end) + (end < clean.length ? " …" : "");
}

/** Collect the searchable text from one transcript (user turns + assistant deltas). */
function transcriptText(sessionsDir, id, maxBytes) {
  const raw = readCapped(path.join(sessionsDir, `${id}.jsonl`), maxBytes);
  if (!raw) return "";
  const parts = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "echo_user" && ev.text) parts.push(String(ev.text));
      else if (ev.type === "delta" && ev.text) parts.push(String(ev.text));
    } catch {
      /* skip a torn / partial JSONL line */
    }
  }
  return parts.join(" ");
}

/**
 * Search visible sessions for `q`. `sessions` is the already-visible, newest-first list
 * (e.g. from visibleSessionIndex().sessions). Returns { results: [{id,title,snippet}] }.
 */
export function searchSessions(sessionsDir, sessions, q, limits = {}) {
  const L = { ...SEARCH_LIMITS, ...limits };
  const needle = String(q || "")
    .trim()
    .slice(0, L.maxQueryLen)
    .toLowerCase();
  if (!needle) return { results: [] };

  const results = [];
  const list = Array.isArray(sessions) ? sessions.slice(0, L.maxSessions) : [];
  for (const s of list) {
    if (results.length >= L.maxResults) break;
    const title = String(s?.title || "");
    const body = transcriptText(sessionsDir, s.id, L.maxBytes);
    const hayLower = (title + " " + body).toLowerCase();
    if (!hayLower.includes(needle)) continue;
    // Prefer a body snippet; fall back to the title when only the title matched.
    const source = body.toLowerCase().includes(needle) ? body : title;
    results.push({
      id: s.id,
      title: plainText(title),
      snippet: makeSnippet(source, needle, L.snippetLen),
    });
  }
  return { results };
}
