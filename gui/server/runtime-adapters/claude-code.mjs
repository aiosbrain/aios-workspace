// claude-code adapter — drives the session with the Claude Agent SDK `query()`.
//
// This is the reference adapter and the default runtime. It is a faithful
// extraction of the original gui/server/index.mjs query loop: same options,
// same SDK→WebSocket event translation, same permission delegation. Behavior
// MUST be byte-identical to pre-Phase-3 when agent_runtime is unset/claude-code.
//
// Adapter contract: export `meta` + `run(host)`. See runtime-adapters/index.mjs.

import { query } from "@anthropic-ai/claude-agent-sdk";

export const meta = { runtime: "claude-code", driver: "claude-sdk" };

/**
 * @param {object} host
 * @param {string} host.repo                       workspace cwd
 * @param {AsyncIterable<{type:"user",text:string}>} host.input   user turns
 * @param {(event:object)=>void} host.emit         WS-shaped event sink
 * @param {(tool:string,input:object)=>Promise<object>} host.confirmClaudeTool  → {behavior,...}
 * @param {AbortSignal} host.signal
 */
export async function run({ repo, input, emit, confirmClaudeTool, signal }) {
  // Map host turns → the SDK's streaming-input message shape (unchanged from
  // the original userMessages() generator).
  async function* prompt() {
    for await (const turn of input) {
      if (signal?.aborted) return;
      yield { type: "user", message: { role: "user", content: turn.text }, parent_tool_use_id: null };
    }
  }

  const q = query({
    prompt: prompt(),
    options: {
      cwd: repo,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"], // CLAUDE.md + skills + PreToolUse guard hook fire
      includePartialMessages: true,
      canUseTool: confirmClaudeTool,
    },
  });

  for await (const message of q) {
    if (signal?.aborted) break;
    if (message.type === "stream_event") {
      const ev = message.event;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        emit({ type: "delta", text: ev.delta.text });
      }
    } else if (message.type === "assistant") {
      for (const block of message.message?.content || []) {
        if (block.type === "tool_use") {
          emit({ type: "tool_use", name: block.name, input: block.input, id: block.id });
        }
      }
      emit({ type: "assistant_done" });
    } else if (message.type === "user") {
      for (const block of message.message?.content || []) {
        if (block.type === "tool_result") {
          const text = Array.isArray(block.content)
            ? block.content.map((b) => b.text || "").join("")
            : String(block.content ?? "");
          emit({ type: "tool_result", id: block.tool_use_id, text: text.slice(0, 4000), is_error: !!block.is_error });
        }
      }
    } else if (message.type === "result") {
      emit({ type: "result", subtype: message.subtype, cost_usd: message.total_cost_usd });
    }
  }
}
