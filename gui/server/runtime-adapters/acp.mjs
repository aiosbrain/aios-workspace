// ACP adapter — drives the session over the Agent Client Protocol (JSON-RPC on
// stdio) against a spawned agent process. Used by every `driver: "acp"` runtime
// in scripts/runtimes.mjs — Hermes (`hermes acp`) and OpenClaw (`openclaw acp`,
// a Gateway-backed ACP bridge) both ride this one adapter.
//
// Governance model — two layers, because ACP file mutation has two paths:
//   1. PRE-GATE (host-mediated): the agent asks the client via
//      `fs/write_text_file`; we route every such write through host.guardWrite()
//      BEFORE touching disk and write only the resolved, in-repo path it vetted.
//   2. POST-TURN SWEEP (in-process): we do NOT advertise the `terminal`
//      capability, so the agent runs shell commands inside its OWN process
//      (cwd=repo). A shell write (`echo secret > f`) therefore bypasses layer 1.
//      So after every turn we re-run the SAME governance hook over the files the
//      turn changed and emit a blocking `error` if one trips. This adapter is
//      thus NOT "fully pre-gated" — host writes are pre-gated, shell-driven
//      changes are caught post-hoc. (A future slice can host-mediate terminals
//      with repo scoping to make shell writes pre-gated too.)
//
// Tool permissions arrive as option-based `session/request_permission` requests
// surfaced through host.requestPermission() (ACP options are option-IDs, not
// booleans). fs reads/writes are scoped to `repo` (realpath + symlink-escape).
//
// Adapter contract: export `meta` + `run(host)`. See runtime-adapters/index.mjs.

import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { postTurnSweep, SWEEP_MAX_FILES } from "./sweep.mjs";
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


// A stable, repo-scoped session key for the OpenClaw bridge (exported for unit
// testing). WHY this is required, not cosmetic: invoked bare, `openclaw acp`
// mints a fresh `acp:<uuid>` session per ACP newSession. The Gateway routes any
// `acp:`-keyed `chat.send` into its ACP-runtime ("acpx") dispatch path, which
// expects an ACP backend bound via `/acp spawn`; with none bound, EVERY turn
// fails server-side with ACP_SESSION_INIT_FAILED and the bridge emits zero
// session/update notifications (the turn hangs, then cancels — no model output).
// Pinning `--session agent:<id>:…` routes `chat.send` to the Gateway's normal
// embedded agent instead, which streams agent_message_chunk → our delta events.
// We scope the key to the repo (so different workspaces don't share history) and
// keep it OUT of the user's `agent:main:main` session (heartbeat/personal chat).
// Agent id is "main" — OpenClaw's default and only agent in a standard install.
export function openclawSessionKey(repo) {
  const h = createHash("sha1").update(String(repo)).digest("hex").slice(0, 12);
  return `agent:main:aios-gui-${h}`;
}

// Per-backend launch quirks for the ACP bridge (exported for unit testing):
//  - hermes: auto-accept unseen shell hooks (no TTY in ACP would otherwise wedge);
//    writes are still governed by guardWrite + the post-turn sweep.
//  - openclaw: `openclaw acp` bridges to the OpenClaw Gateway. Pin the session
//    key (see openclawSessionKey) so prompts reach the main agent, and pass the
//    gateway password when configured — prefer a file so it never lands in
//    argv/ps output.
export function acpSpawnArgs(bin, baseArgs, env = process.env, opts = {}) {
  if (bin === "hermes") return [...baseArgs, "--accept-hooks"];
  if (bin === "openclaw") {
    const args = [...baseArgs];
    if (opts.sessionKey) args.push("--session", opts.sessionKey);
    if (env.OPENCLAW_GATEWAY_PASSWORD_FILE) args.push("--password-file", env.OPENCLAW_GATEWAY_PASSWORD_FILE);
    else if (env.OPENCLAW_GATEWAY_PASSWORD) args.push("--password", env.OPENCLAW_GATEWAY_PASSWORD);
    return args;
  }
  return baseArgs;
}

// Wrap a Node Readable (the child's stdout) as a Web ReadableStream that forwards
// ONLY newline-delimited JSON-RPC lines (each ACP message is one object starting
// with `{`). Some bridges print human banners / config warnings to stdout
// (OpenClaw prints a boxed "Config warnings:" block), which would otherwise
// corrupt ndJsonStream's framing and close the connection. Dropping non-`{` lines
// keeps the protocol stream clean regardless of stdout noise.
export function jsonRpcLines(nodeReadable) {
  const enc = new TextEncoder();
  let buf = "";
  return new ReadableStream({
    start(controller) {
      nodeReadable.on("data", (chunk) => {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i + 1); buf = buf.slice(i + 1);
          if (line.trimStart().startsWith("{")) controller.enqueue(enc.encode(line));
        }
      });
      nodeReadable.on("end", () => {
        if (buf.trimStart().startsWith("{")) controller.enqueue(enc.encode(buf));
        try { controller.close(); } catch { /* already closed */ }
      });
      nodeReadable.on("error", (e) => { try { controller.error(e); } catch { /* */ } });
    },
  });
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
  const sessionKey = bin === "openclaw" ? openclawSessionKey(repo) : undefined;
  const args = acpSpawnArgs(bin, baseArgs, process.env, { sessionKey });

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
    const stream = ndJsonStream(Writable.toWeb(child.stdin), jsonRpcLines(child.stdout));

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
        // Pre-gate EVERY host-mediated write through the shared governance hook,
        // then write the RESOLVED in-repo path it vetted — never the raw input,
        // which may be relative and resolve against the wrong cwd (CLI mode runs
        // the server without cwd=repo). guardWrite returns that safe path.
        const verdict = guardWrite({ path: target, content, operation: "Write" });
        if (!verdict.ok || !verdict.path) {
          throw RequestError.internalError({ reason: verdict.reason }, verdict.reason || "write blocked");
        }
        await writeFile(verdict.path, content);
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
      const turnStart = Date.now(); // baseline for the post-turn sweep
      try {
        const { stopReason } = await conn.prompt({ sessionId, prompt: [{ type: "text", text: turn.text }] });
        emit({ type: "assistant_done" });
        // Catch in-process / shell-driven writes that bypassed the fs/write
        // pre-gate. A violation is reported as a blocking error (the file is
        // already on disk — surfacing it is the honest mitigation for this tier).
        try {
          const { violations, truncated } = await postTurnSweep(repo, guardWrite, turnStart);
          for (const v of violations) {
            emit({ type: "error", message: `post-turn guard: ${v.path} — ${v.reason}` });
          }
          // Fail loud: never let a too-large sweep look like a clean turn.
          if (truncated) {
            emit({ type: "error", message: `post-turn guard: workspace exceeds the ${SWEEP_MAX_FILES}-file sweep cap — some shell-driven changes this turn were NOT validated. Review changes manually or run validation/validate-all.sh.` });
          }
        } catch (e) {
          // The sweep IS the governance for in-process writes — if it can't run,
          // say so rather than implying the turn was clean.
          emit({ type: "error", message: `post-turn guard: sweep failed to run (${String(e?.message || e)}) — changes this turn were NOT validated.` });
        }
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
