// Codex adapter — drives the session with the Codex CLI's non-interactive
// `codex exec --json` (JSONL events on stdout). One user turn = one `codex exec`
// process; continuation uses `codex exec resume <thread_id>` (NOT --thread).
//
// NATIVE-runtime governance tier: Codex executes its own file writes in-process
// (apply_patch / shell), so the host CANNOT pre-gate them the way the ACP adapter
// pre-gates fs/write_text_file. Mitigations:
//   - run inside Codex's `--full-auto` sandbox (workspace-write) scoped to -C repo;
//   - a POST-TURN guard sweep re-runs team-ops-guard.sh over files the turn
//     changed and surfaces violations/truncation as blocking errors;
//   - the UI banner (hello.safetyNote) discloses the post-hoc nature honestly.
// This is the weaker tier the ACP path was designed to avoid — opt-in via
// `agent_runtime: codex`.
//
// Codex streams per-ITEM, not per-token (JSONL exposes completed items), so the
// client sees a full agent message as one delta, not a token stream.
//
// Adapter contract: export `meta` + `run(host)`. See runtime-adapters/index.mjs.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { postTurnSweep, SWEEP_MAX_FILES } from "./sweep.mjs";

export const meta = { driver: "codex" };

// ── pure event mapping (codex JSONL ThreadEvent → WS event shapes) ────────────
// Exported for the contract test. Top-level events the run loop owns directly
// (thread.started → thread_id capture; turn.completed → result after the sweep)
// map to nothing here.

function extractMcpText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content.map((b) => (b && b.type === "text" ? b.text : "")).join("");
}

function mapItemStarted(item) {
  if (!item || typeof item !== "object") return [];
  switch (item.type) {
    case "command_execution":
      return [{ type: "tool_use", name: "shell", input: { command: item.command }, id: item.id }];
    case "file_change":
      return [{ type: "tool_use", name: "apply_patch", input: { changes: item.changes }, id: item.id }];
    case "mcp_tool_call":
      return [{ type: "tool_use", name: `${item.server}/${item.tool}`, input: item.arguments ?? {}, id: item.id }];
    case "web_search":
      return [{ type: "tool_use", name: "web_search", input: { query: item.query }, id: item.id }];
    default:
      return []; // agent_message/reasoning/todo_list surface (or not) on completion
  }
}

function mapItemCompleted(item) {
  if (!item || typeof item !== "object") return [];
  switch (item.type) {
    case "agent_message":
      // Codex delivers the full message at once — one delta, then close the bubble.
      return item.text ? [{ type: "delta", text: item.text }, { type: "assistant_done" }] : [];
    case "command_execution":
      return [{ type: "tool_result", id: item.id, text: (item.aggregated_output || "").slice(0, 4000), is_error: item.status === "failed" }];
    case "file_change": {
      const summary = (item.changes || []).map((c) => `${c.kind} ${c.path}`).join("\n");
      return [{ type: "tool_result", id: item.id, text: summary, is_error: item.status === "failed" }];
    }
    case "mcp_tool_call": {
      const text = item.error?.message || extractMcpText(item.result);
      return [{ type: "tool_result", id: item.id, text: (text || "").slice(0, 4000), is_error: item.status === "failed" }];
    }
    case "web_search":
      return [{ type: "tool_result", id: item.id, text: `searched: ${item.query}`, is_error: false }];
    case "error":
      return [{ type: "error", message: item.message || "error" }];
    default:
      return []; // reasoning / todo_list — no UI channel yet
  }
}

/** Map one codex JSONL event to zero or more WS events. Pure + side-effect free. */
export function mapCodexEvent(event) {
  if (!event || typeof event !== "object") return [];
  switch (event.type) {
    case "item.started": return mapItemStarted(event.item);
    case "item.completed": return mapItemCompleted(event.item);
    case "turn.failed": return [{ type: "error", message: event.error?.message || "turn failed" }];
    case "error": return [{ type: "error", message: event.message || "codex error" }];
    // thread.started (thread_id captured by run), turn.started, turn.completed
    // (result emitted by run after the sweep), item.updated → no WS event.
    default: return [];
  }
}

// Run one `codex exec` process to completion: stream JSONL → WS events, capture
// the thread id, and report whether the turn failed. Resolves on child exit.
function runCodexTurn(bin, args, prompt, { emit, signal, onThreadId }) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let failed = false;
    let spawnError = null;
    let stderrTail = "";
    let lastError = null; // codex emits both `error` and `turn.failed` for one failure

    const onAbort = () => { try { child.kill("SIGTERM"); } catch { /* gone */ } };
    if (signal?.aborted) { onAbort(); resolve({ failed: true, spawnError: null }); return; }
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.on("error", (e) => {
      spawnError = e.code === "ENOENT"
        ? "agent_runtime 'codex' selected but 'codex' is not on PATH. Install the Codex CLI, then retry."
        : `failed to start codex: ${e.message}`;
    });
    child.stderr?.on("data", (d) => { stderrTail = (stderrTail + d).slice(-2000); });

    // Pass the prompt on stdin so arbitrary text (leading '-', newlines, very long
    // prompts) can't be misread as flags.
    try { child.stdin.write(prompt); child.stdin.end(); } catch { /* spawn failed */ }

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const s = line.trim();
      if (!s) return;
      let ev;
      try { ev = JSON.parse(s); } catch { return; } // tolerate any non-JSONL log line
      if (ev.type === "thread.started" && ev.thread_id) { onThreadId(ev.thread_id); return; }
      if (ev.type === "turn.failed" || ev.type === "error") failed = true;
      for (const wsEvent of mapCodexEvent(ev)) {
        // Collapse the duplicate error codex emits as both `error` + `turn.failed`.
        if (wsEvent.type === "error") {
          if (wsEvent.message === lastError) continue;
          lastError = wsEvent.message;
        } else {
          lastError = null;
        }
        emit(wsEvent);
      }
    });

    child.on("close", (code) => {
      signal?.removeEventListener?.("abort", onAbort);
      if (spawnError) { resolve({ failed: true, spawnError }); return; }
      if (code !== 0 && !failed && !signal?.aborted) {
        emit({ type: "error", message: `codex exited ${code}${stderrTail ? `: ${stderrTail.trim().slice(-500)}` : ""}` });
        failed = true;
      }
      resolve({ failed, spawnError: null });
    });
  });
}

/**
 * @param {object} host  see runtime-adapters/index.mjs — repo, input, emit,
 *   guardWrite, signal, model. (Codex has no host-mediated permission/write flow;
 *   it self-executes under its sandbox, then the post-turn sweep governs.)
 */
export async function run(host) {
  const { repo, input, emit, guardWrite, signal, model } = host;
  let threadId = null;

  for await (const turn of input) {
    if (signal?.aborted) break;
    const turnStart = Date.now(); // baseline for the post-turn sweep

    // Exec-level options (--json/-C/--skip-git-repo-check/…) MUST precede the
    // `resume` subcommand — the CLI rejects them after it. Prompt is read from
    // stdin via the trailing "-" (required for `resume`; also valid for `exec`).
    const opts = ["--json", "--skip-git-repo-check", "-C", repo, "--full-auto", "--color", "never"];
    if (model) opts.push("-m", model);
    const args = threadId
      ? ["exec", ...opts, "resume", threadId, "-"] // continue the same Codex thread
      : ["exec", ...opts, "-"];

    let failed = false;
    const r = await runCodexTurn("codex", args, turn.text, { emit, signal, onThreadId: (id) => { threadId = id; } });
    if (r.spawnError) { emit({ type: "error", message: r.spawnError }); break; } // fail loud, no fallback
    failed = r.failed;

    // Post-turn governance: Codex writes files in-process, so this is the gate.
    // A governance violation/truncation/sweep-failure MUST taint the turn result
    // (not just emit an error then report success).
    try {
      const { violations, truncated } = await postTurnSweep(repo, guardWrite, turnStart);
      for (const v of violations) emit({ type: "error", message: `post-turn guard: ${v.path} — ${v.reason}` });
      if (violations.length) failed = true;
      if (truncated) {
        emit({ type: "error", message: `post-turn guard: workspace exceeds the ${SWEEP_MAX_FILES}-file sweep cap — some changes this turn were NOT validated. Review changes manually or run validation/validate-all.sh.` });
        failed = true;
      }
    } catch (e) {
      emit({ type: "error", message: `post-turn guard: sweep failed to run (${String(e?.message || e)}) — changes this turn were NOT validated.` });
      failed = true;
    }

    emit({ type: "result", subtype: failed ? "error" : "success", cost_usd: null });
    if (signal?.aborted) break;
  }
}
