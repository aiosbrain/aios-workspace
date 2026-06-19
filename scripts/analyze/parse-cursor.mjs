/**
 * parse-cursor.mjs — Cursor agent history → NormalizedEvent[].
 *
 * Source: Cursor's SQLite state.vscdb. Agent turns live in the GLOBAL store's
 * `cursorDiskKV` table as `bubbleId:<composerId>:<bubbleId>` rows, each a JSON
 * blob with: type (1=user, 2=assistant), tokenCount.{input,output}Tokens,
 * toolFormerData.name (the tool), createdAt (ISO), text.
 *
 * We shell out to the `sqlite3` CLI (no zero-dep SQLite in Node; sqlite3 is an
 * external tool like git, so the no-npm-dep rule holds). We use json_extract in
 * SQL so the projection pulls ONLY structural fields — never the message text
 * (we read length(text) to detect a real prompt, not the text itself). This is
 * both privacy-preserving and tiny (~1.6 MB for 16k bubbles).
 *
 * Cursor events are null-heavy: no git branch, often zero tokenCount, no model,
 * no explicit tool_result bubbles. Every downstream consumer null-guards, so
 * Cursor degrades gracefully (task counts + tool diversity survive; token-based
 * signals read 0 when Cursor didn't record them).
 *
 * Capability-gated: if `sqlite3` is absent the orchestrator skips Cursor with a
 * warning rather than failing. Zero npm dependencies.
 */

import { execFileSync } from "node:child_process";
import { makeEvent } from "./normalize.mjs";

// Projection pulls structure only — NO message text leaves SQLite.
const QUERY = `SELECT
  key,
  json_extract(value,'$.type')                    AS type,
  json_extract(value,'$.createdAt')               AS created,
  json_extract(value,'$.tokenCount.inputTokens')  AS in_tok,
  json_extract(value,'$.tokenCount.outputTokens') AS out_tok,
  json_extract(value,'$.toolFormerData.name')     AS tool,
  length(json_extract(value,'$.text'))            AS text_len
FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'`;

/** Is the `sqlite3` CLI available on PATH? */
export function sqlite3Available() {
  try {
    execFileSync("sqlite3", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Query one vscdb for bubble rows. Returns [] if the table is absent/locked. */
export function queryBubbles(dbPath) {
  let out;
  try {
    out = execFileSync("sqlite3", ["-readonly", "-json", dbPath, QUERY], {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return []; // no cursorDiskKV table (per-workspace dbs), locked, etc.
  }
  const s = out.trim();
  if (!s) return [];
  try { return JSON.parse(s); } catch { return []; }
}

/** composerId is the middle segment of `bubbleId:<composerId>:<bubbleId>`. */
function composerOf(key) {
  const parts = String(key).split(":");
  return parts.length >= 2 ? parts[1] : "cursor";
}

export function rowsToEvents(rows) {
  const events = [];
  for (const r of rows) {
    const base = {
      tool: "cursor",
      session_id: composerOf(r.key),
      ts: r.created || null,
      model: null,
      project: null,
    };
    if (r.type === 1) {
      // user bubble — a task root only if it actually carries text
      if ((r.text_len || 0) > 0) {
        events.push(makeEvent({ ...base, actor: "user", block_type: "text" }));
      }
    } else if (r.type === 2) {
      // assistant bubble — a tool call and/or a token-bearing turn
      if (r.tool) {
        events.push(makeEvent({ ...base, actor: "assistant", block_type: "tool_use", tool_name: r.tool }));
      }
      const tin = r.in_tok || 0;
      const tout = r.out_tok || 0;
      if (tin > 0 || tout > 0) {
        events.push(makeEvent({
          ...base, actor: "assistant", block_type: "text",
          tokens: { input_tokens: tin, output_tokens: tout, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }));
      } else if (!r.tool) {
        events.push(makeEvent({ ...base, actor: "assistant", block_type: "text" }));
      }
    }
  }
  return events;
}

/** Parse one Cursor vscdb file → events. */
export function parseCursor(dbPath) {
  return rowsToEvents(queryBubbles(dbPath));
}
