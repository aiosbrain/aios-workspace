// ACP adapter — drives the session over the Agent Client Protocol (JSON-RPC on
// stdio) against a spawned agent process. Used by every `driver: "acp"` runtime
// in scripts/runtimes.mjs (Hermes first; OpenClaw rides the same adapter once
// its spawn command is confirmed).
//
// Governance model (the safe, fully-pre-gated path): the agent does NOT write
// files itself — it asks the client via `fs/write_text_file`. We route every
// such write through host.guardWrite() BEFORE touching disk, so secrets /
// admin-tier leakage / path-escape are blocked uniformly with claude-code. Tool
// permissions arrive as option-based `session/request_permission` requests and
// are surfaced through host.requestPermission() (ACP options are option-IDs, not
// booleans). fs reads/writes are scoped to `repo` (realpath + symlink-escape).
//
// Scope note: we advertise fs (read/write) but NOT the `terminal` capability —
// shell commands run inside the agent's own process (cwd=repo) and are reported
// as tool calls. Host-mediated terminals (scoped to repo) are a follow-up slice.
//
// Adapter contract: export `meta` + `run(host)`. See runtime-adapters/index.mjs.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ClientSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from "@agentclientprotocol/sdk";
import { GUI_RUNTIMES } from "../../../scripts/runtimes.mjs";

export const meta = { driver: "acp" };

// ── pure event mapping (ACP session/update → WS event shapes) ─────────────────
// Exported for the contract test: feeding canned notifications must yield the
// exact field shapes the React client expects (delta | tool_use | tool_result).

function extractToolText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "content" && item.content?.type === "text") parts.push(item.content.text || "");
    else if (item.type === "diff") parts.push(item.newText || "");
    // `terminal` content is live output — surfaced as it streams, not snapshotted here.
  }
  return parts.join("\n");
}

/** Map one ACP SessionUpdate to zero or more WS events. Pure + side-effect free. */
export function mapSessionUpdate(update) {
  if (!update || typeof update !== "object") return [];
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const c = update.content;
      if (c && c.type === "text" && c.text) return [{ type: "delta", text: c.text }];
      return [];
    }
    case "tool_call":
      // Close any open assistant text bubble, then surface the tool invocation.
      return [
        { type: "assistant_done" },
        { type: "tool_use", name: update.title || update.kind || "tool", input: update.rawInput ?? {}, id: update.toolCallId },
      ];
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        return [{
          type: "tool_result",
          id: update.toolCallId,
          text: extractToolText(update.content).slice(0, 4000),
          is_error: update.status === "failed",
        }];
      }
      return [];
    default:
      // user_message_chunk / agent_thought_chunk / plan / mode / usage — no UI channel yet.
      return [];
  }
}

// Resolve `target` to an absolute path proven to live inside `repo` (defeats ../
// and symlinked escapes). Returns null if it escapes or doesn't resolve.
function inRepo(repo, target) {
  try {
    const repoReal = realpathSync(repo);
    const real = realpathSync(path.resolve(repo, target));
    if (real === repoReal || real.startsWith(repoReal + path.sep)) return real;
  } catch { /* not found / bad path */ }
  return null;
}

/**
 * @param {object} host  see runtime-adapters/index.mjs — repo, input, emit,
 *   requestPermission({title,content,options})→optionId|null, guardWrite, signal,
 *   runtime (selects the spawn command from the registry).
 */
export async function run(host) {
  const { repo, input, emit, requestPermission, guardWrite, signal, runtime } = host;

  const command = GUI_RUNTIMES[runtime]?.command || ["hermes", "acp"];
  const [bin, ...baseArgs] = command;
  // Hermes prompts for unseen shell hooks on a TTY; in ACP (no TTY) that would
  // wedge. Auto-accept hooks — real write governance still runs via guardWrite.
  const args = bin === "hermes" ? [...baseArgs, "--accept-hooks"] : baseArgs;

  const child = spawn(bin, args, { cwd: repo, stdio: ["pipe", "pipe", "pipe"] });
  let stderrTail = "";
  let spawnErr = null;
  child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  child.on("error", (e) => { spawnErr = e; });

  let sessionId = null;
  let conn = null;
  let aborted = false;
  const onAbort = () => {
    aborted = true;
    try { if (sessionId && conn) conn.cancel({ sessionId }); } catch { /* gone */ }
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  };
  if (signal?.aborted) { onAbort(); return; }
  signal?.addEventListener?.("abort", onAbort, { once: true });

  try {
    if (!child.stdin || !child.stdout) throw new Error("child has no stdio");
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));

    const client = {
      async sessionUpdate({ update }) {
        for (const ev of mapSessionUpdate(update)) emit(ev);
      },
      async requestPermission({ options, toolCall }) {
        const choice = await requestPermission({
          title: (toolCall && (toolCall.title || toolCall.kind)) || "tool",
          content: toolCall ? (toolCall.rawInput ?? {}) : {},
          options: (options || []).map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
        });
        // host returns the chosen optionId (string), or a non-string when the tab
        // closed / the user denied / it timed out → ACP "cancelled".
        return typeof choice === "string"
          ? { outcome: { outcome: "selected", optionId: choice } }
          : { outcome: { outcome: "cancelled" } };
      },
      async writeTextFile({ path: target, content }) {
        // Pre-gate EVERY host-mediated write through the shared governance hook.
        const verdict = guardWrite({ path: target, content, operation: "Write" });
        if (!verdict.ok) throw RequestError.internalError({ reason: verdict.reason }, verdict.reason);
        await writeFile(target, content); // absolute + proven in-repo by guardWrite
        return {};
      },
      async readTextFile({ path: target, line, limit }) {
        const real = inRepo(repo, target);
        if (!real) throw RequestError.resourceNotFound(target);
        let text = await readFile(real, "utf8");
        if (line || limit) {
          const lines = text.split("\n");
          const start = line ? line - 1 : 0;
          text = lines.slice(start, limit ? start + limit : undefined).join("\n");
        }
        return { content: text };
      },
    };

    conn = new ClientSideConnection(() => client, stream);

    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "aios-workspace-gui", version: "0.1.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
    const res = await conn.newSession({ cwd: repo, mcpServers: [] });
    sessionId = res.sessionId;
  } catch (e) {
    if (aborted) return; // closing the tab races initialize — not an error
    const enoent = spawnErr?.code === "ENOENT" || /ENOENT/.test(String(e?.message || e));
    emit({
      type: "error",
      message: enoent
        ? `agent_runtime '${runtime}' selected but '${bin}' is not on PATH. Install it, then: aios skills export --runtime ${runtime} --install`
        : `failed to start '${[bin, ...args].join(" ")}' (${String(e?.message || e)})${stderrTail ? `\n${stderrTail.trim()}` : ""}`,
    });
    try { child.kill("SIGKILL"); } catch { /* gone */ }
    return;
  }

  // Session-streamed turn model: each user turn is a fresh session/prompt on the
  // same session; follow-ups naturally queue behind the in-flight prompt.
  try {
    for await (const turn of input) {
      if (aborted || signal?.aborted) break;
      try {
        const { stopReason } = await conn.prompt({ sessionId, prompt: [{ type: "text", text: turn.text }] });
        emit({ type: "assistant_done" });
        emit({ type: "result", subtype: stopReason, cost_usd: null });
      } catch (e) {
        if (aborted || signal?.aborted) break;
        emit({ type: "error", message: `prompt failed: ${String(e?.message || e)}` });
      }
    }
  } finally {
    try { if (sessionId && !aborted) conn.cancel({ sessionId }); } catch { /* gone */ }
    try { child.kill("SIGTERM"); } catch { /* gone */ }
  }
}
