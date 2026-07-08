/**
 * parse-opencode.mjs — Opencode session cost NDJSON → NormalizedEvent[].
 *
 * Source: .aios/loop/maturity/opencode-sessions.ndjson, one JSON object per
 * line, written by the aios-instincts Opencode plugin on session idle. Each
 * record carries authoritative cost_usd + token counts from Opencode server
 * API, no token estimation needed.
 *
 * We emit ONE token-bearing assistant event per session (carrying the full
 * session's cost + tokens as the "assistant turn") so it contributes correctly
 * to computeSignals / total_cost_usd. No sub-agent / tool_use breakdown is
 * available from Opencode's message API.
 *
 * Zero dependencies.
 */

import path from "node:path";
import { makeEvent } from "./normalize.mjs";

/** Tolerantly parse JSONL text → array of objects (skips blank/garbled lines). */
export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* partial tail / corrupt line */
    }
  }
  return out;
}

function projectFromDir(dir) {
  if (!dir) return null;
  try {
    return path.basename(dir);
  } catch {
    return null;
  }
}

/**
 * Convert Opencode cost records to NormalizedEvent[].
 * Each record: { tool, session_id, title, cost_usd, input_tokens, output_tokens,
 *   model, ts, project, provider }
 *
 * @param {object[]} records  already-parsed JSONL objects
 * @returns {import("./normalize.mjs").NormalizedEvent[]}
 */
export function recordsToEvents(records) {
  const events = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (!r.cost_usd && !r.input_tokens) continue;

    const base = {
      tool: "opencode",
      session_id: String(r.session_id || "unknown"),
      ts: r.ts || null,
      model: r.model || null,
      project: projectFromDir(r.project) || null,
      raw_uuid: r.session_id || null,
    };

    // One assistant event carrying the session's full token + cost data.
    events.push(
      makeEvent({
        ...base,
        actor: "assistant",
        block_type: "text",
        tokens: {
          in: r.input_tokens || 0,
          out: r.output_tokens || 0,
          cache_read: r.cache_read_tokens || 0,
          cache_create: 0,
        },
      })
    );
  }
  return events;
}

/** Convenience: raw JSONL text → events. */
export function parseOpencode(text) {
  return recordsToEvents(parseJsonl(text));
}
