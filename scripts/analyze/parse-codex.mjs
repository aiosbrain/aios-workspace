/**
 * parse-codex.mjs — Codex CLI rollout JSONL → NormalizedEvent[].
 *
 * Source: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl. Record envelope:
 *   { timestamp, type, payload }  where type ∈
 *     session_meta  — id, cwd, git.branch (session context)
 *     turn_context  — model, cwd, approval_policy (per-turn context)
 *     event_msg     — payload.type: user_message (a real prompt) | token_count
 *                     (usage: info.last_token_usage) | agent_message | error | …
 *     response_item — payload.type: function_call (tool use, payload.name) |
 *                     function_call_output (tool result) | message | reasoning
 *
 * We map: user_message→task root · token_count→assistant usage (last_token_usage,
 * the per-turn delta, so it doesn't double-count the cumulative total) ·
 * function_call→tool_use · function_call_output→tool_result. Codex is single-
 * agent, so there are no subagent events (delegation signals read 0, correctly).
 *
 * Stateful across records (session/turn context carries forward). Zero deps.
 */

import path from "node:path";
import { makeEvent } from "./normalize.mjs";
import { parseJsonl } from "./parse-claude.mjs";

function projectFromCwd(cwd) {
  if (!cwd) return null;
  try {
    return path.basename(cwd);
  } catch {
    return null;
  }
}

/**
 * Codex usage → canonical token shape.
 * Invariant (see normalize.mjs): `in` = FRESH (uncached) input, `cache_read` =
 * cached input. Codex reports input_tokens as the FULL prompt (cached included),
 * so we subtract cached_input_tokens to match Claude's semantics. Reasoning
 * tokens fold into output.
 */
function codexTokens(u) {
  if (!u) return null;
  const cached = u.cached_input_tokens || 0;
  const fresh = Math.max(0, (u.input_tokens || 0) - cached);
  return {
    input_tokens: fresh,
    output_tokens: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  };
}

export function recordsToEvents(records, fallbackId) {
  const events = [];
  const ctx = { session_id: fallbackId, project: null, branch: null, model: null };

  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const p = r.payload || {};
    const ts = r.timestamp || null;
    const base = () => ({
      tool: "codex",
      session_id: ctx.session_id,
      ts,
      model: ctx.model,
      git_branch: ctx.branch,
      project: ctx.project,
    });

    switch (r.type) {
      case "session_meta":
        ctx.session_id = p.id || fallbackId;
        ctx.project = projectFromCwd(p.cwd);
        ctx.branch = p.git?.branch || null;
        break;

      case "turn_context":
        if (p.model) ctx.model = p.model;
        if (p.cwd) ctx.project = projectFromCwd(p.cwd);
        break;

      case "event_msg":
        if (p.type === "user_message") {
          events.push(makeEvent({ ...base(), actor: "user", block_type: "text" }));
        } else if (p.type === "token_count") {
          const usage = codexTokens(p.info?.last_token_usage);
          if (usage)
            events.push(
              makeEvent({ ...base(), actor: "assistant", block_type: "text", tokens: usage })
            );
        } else if (p.type === "error") {
          events.push(
            makeEvent({ ...base(), actor: "assistant", block_type: "tool_result", is_error: true })
          );
        }
        break;

      case "response_item":
        if (p.type === "function_call") {
          events.push(
            makeEvent({
              ...base(),
              actor: "assistant",
              block_type: "tool_use",
              tool_name: p.name || null,
            })
          );
        } else if (p.type === "function_call_output") {
          events.push(makeEvent({ ...base(), actor: "assistant", block_type: "tool_result" }));
        }
        // message / reasoning → text we don't need (prompt is event_msg user_message)
        break;
    }
  }
  return events;
}

export function parseCodex(text, fallbackId) {
  return recordsToEvents(parseJsonl(text), fallbackId);
}
