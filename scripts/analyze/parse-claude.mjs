/**
 * parse-claude.mjs — Claude Code session JSONL → NormalizedEvent[].
 *
 * Source: ~/.claude/projects/<cwd-slug>/<sessionId>.jsonl, one JSON object per
 * line. Record types seen in the wild: user, assistant, mode, permission-mode,
 * file-history-snapshot, attachment, last-prompt, ai-title, summary.
 *
 * We emit, per record:
 *   - assistant (message.role==="assistant"): ONE token-bearing event (the turn,
 *     carrying message.usage exactly once) + one tool_use event per tool_use
 *     block (tokens:null) so tool diversity / subagent fan-out is countable.
 *   - user with a string/text body: a genuine user prompt (a task root).
 *   - user with tool_result blocks: one tool_result event per block (these always
 *     have a parent, so they are never mistaken for task roots).
 *   - mode / permission-mode: a permission/mode event (autonomy-axis signal).
 *   - everything else (attachments, titles, snapshots): skipped as noise.
 *
 * Stateless + line-oriented so the orchestrator can tail-parse only new bytes.
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
    try { out.push(JSON.parse(s)); } catch { /* partial tail / corrupt line */ }
  }
  return out;
}

function projectFromCwd(cwd) {
  if (!cwd) return null;
  try { return path.basename(cwd); } catch { return null; }
}

/** Is this user record a genuine human prompt (vs. an auto tool_result turn)? */
function isHumanPrompt(content) {
  if (typeof content === "string") return content.trim().length > 0;
  if (Array.isArray(content)) return content.some((b) => b && b.type === "text");
  return false;
}

/**
 * @param {object[]} records  already-parsed JSONL objects
 * @param {string} fallbackId session id to use when a record omits sessionId
 * @returns {import("./normalize.mjs").NormalizedEvent[]}
 */
export function recordsToEvents(records, fallbackId) {
  const events = [];
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const type = r.type;
    const msg = r.message;
    const base = {
      tool: "claude",
      session_id: r.sessionId || fallbackId,
      ts: r.timestamp || null,
      model: msg?.model || null,
      git_branch: r.gitBranch || null,
      project: projectFromCwd(r.cwd),
      raw_uuid: r.uuid || null,
      turn_parent: r.parentUuid || null,
    };

    if (type === "assistant" && msg?.role === "assistant") {
      const actor = r.isSidechain ? "subagent" : "assistant";
      // The turn itself, carrying usage exactly once.
      events.push(makeEvent({
        ...base, actor, block_type: "text", tokens: msg.usage || null,
      }));
      // Each tool invocation in this turn (no tokens — avoids double counting).
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const b of content) {
        if (b && b.type === "tool_use") {
          events.push(makeEvent({
            ...base, actor, block_type: "tool_use", tool_name: b.name || null,
          }));
        }
      }
      continue;
    }

    if (type === "user" && msg?.role === "user") {
      const content = msg.content;
      if (isHumanPrompt(content)) {
        events.push(makeEvent({ ...base, actor: "user", block_type: "text" }));
      } else if (Array.isArray(content)) {
        // Auto-generated turn carrying tool results back to the model.
        for (const b of content) {
          if (b && b.type === "tool_result") {
            events.push(makeEvent({
              ...base, actor: "user", block_type: "tool_result",
              is_error: Boolean(b.is_error),
            }));
          }
        }
      }
      continue;
    }

    if (type === "mode" || type === "permission-mode") {
      events.push(makeEvent({
        ...base, actor: "user",
        block_type: type === "permission-mode" ? "permission" : "mode",
      }));
      continue;
    }
    // attachment / last-prompt / ai-title / file-history-snapshot / summary → noise
  }
  return events;
}

/** Convenience: raw JSONL text → events. */
export function parseClaude(text, fallbackId) {
  return recordsToEvents(parseJsonl(text), fallbackId);
}
