// test/ux/driver.mjs — the agentic driver. Drives the localhost cockpit by INTENT via the
// `@anthropic-ai/claude-agent-sdk` query(), restricting the agent to a single safe binary:
// `agent-browser`. Captures annotated screenshots + console errors + the SDK transcript into
// the flow's evidence dir.
//
// SECURITY (load-bearing) — two distinct, explicit permission layers, both default-deny:
//
//   1. DRIVER BASH ALLOWLIST (this file, `makeBashAllowlist`): the agent may run Bash ONLY
//      when the command parses as EXACTLY `agent-browser <subcommand> <args…>`. We REJECT any
//      shell metacharacter (; | & $ ` > < ( ) { } and newlines), command chaining, leading
//      env-assignments, redirection, quotes that imply shell parsing, and ANY non-agent-browser
//      binary. We do NOT shell-split heuristically and hope; we tokenize and demand the first
//      token be the literal `agent-browser`. Deny (not allow) on any doubt.
//
//   2. COCKPIT GUI PERMISSION PROMPTS (Flow A): handled by the FLOW via agent-browser clicks,
//      not here — the flow Allows only the exact firecrawl-extract / suggest-connectors
//      commands and Denies everything else. This file only governs what the DRIVER itself runs.
//
// The `query()` here imports the Agent SDK at the top — that is fine: only run-ux.mjs (the
// orchestrator) imports this, and only when ANTHROPIC_API_KEY is present. The PURE gate
// (judge.mjs) never imports an SDK, so the zero-dep CI job is unaffected.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

// The pure Bash allowlist lives in allowlist.mjs (zero-dep, unit-tested without the SDK).
import { tokenizeSimpleCommand, isAgentBrowserCommand } from "./allowlist.mjs";

/**
 * Build the SDK `canUseTool` callback for the driver. Default-deny: Bash is gated by the
 * agent-browser allowlist; every other tool is denied (the driver only needs the browser).
 * Records each decision into the transcript via `log`.
 */
export function makeBashAllowlist(log) {
  return async (toolName, toolInput /*, options */) => {
    if (toolName !== "Bash") {
      log({ kind: "tool_denied", tool: toolName, reason: "only Bash(agent-browser) is permitted" });
      return { behavior: "deny", message: `Tool '${toolName}' is not permitted. Use only: Bash running agent-browser.` };
    }
    const command = toolInput && typeof toolInput.command === "string" ? toolInput.command : "";
    const verdict = isAgentBrowserCommand(command);
    if (!verdict.allow) {
      log({ kind: "bash_denied", command, reason: verdict.reason });
      return { behavior: "deny", message: `Denied: ${verdict.reason}. Only 'agent-browser <subcommand> …' is allowed (no shell features).` };
    }
    log({ kind: "bash_allowed", command });
    return { behavior: "allow", updatedInput: toolInput };
  };
}

// Pull plain text + tool_use blocks out of a streamed assistant SDK message.
function readAssistant(msg) {
  const out = { text: [], toolUses: [] };
  const content = msg?.message?.content || [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") out.text.push(block.text);
    else if (block.type === "tool_use") out.toolUses.push({ name: block.name, input: block.input });
  }
  return out;
}

/**
 * Run one flow's intent through the agentic driver.
 *
 * @param {object} args
 * @param {object} args.flow         the flow module ({ id, intent, ... })
 * @param {string} args.tokenUrl     the cockpit URL with ?token=…
 * @param {string} args.evidenceDir  per-flow evidence dir (already created by the caller)
 * @param {string} args.model        SDK model id for the driver
 * @param {object} args.sdk          { query } injected (so this stays unit-testable)
 * @param {string} [args.session]    agent-browser session name (default: flow id)
 * @param {number} [args.maxTurns]
 * @returns {Promise<{transcript:Array, screenshots:string[], errors:any[]}>}
 */
export async function runDriver({ flow, tokenUrl, evidenceDir, model, sdk, session, maxTurns = 40 }) {
  mkdirSync(evidenceDir, { recursive: true });
  const transcriptPath = path.join(evidenceDir, "driver-transcript.jsonl");
  const transcript = [];
  const log = (entry) => {
    const rec = { ts: new Date().toISOString(), ...entry };
    transcript.push(rec);
    try { appendFileSync(transcriptPath, JSON.stringify(rec) + "\n"); } catch { /* best-effort */ }
  };
  const sessionName = session || flow.id;

  const intent =
    `You are driving a localhost web app (a "cockpit") to test its UX. You control a real ` +
    `browser ONLY through the \`agent-browser\` CLI (run via Bash). You may NOT use any other ` +
    `tool or binary.\n\n` +
    `Use one persistent session named "${sessionName}" by passing \`--session ${sessionName}\` ` +
    `to every agent-browser command. The core loop is: open → wait → snapshot -i (discover ` +
    `@refs) → act on a @ref → re-snapshot after each state change. Capture an annotated ` +
    `screenshot at each meaningful step with \`screenshot --annotate <path>\` writing into ` +
    `"${evidenceDir}", and run \`errors\` to capture console errors.\n\n` +
    `First command to run:\n` +
    `  agent-browser --session ${sessionName} open "${tokenUrl}"\n` +
    `Then:\n` +
    `  agent-browser --session ${sessionName} wait --load networkidle\n\n` +
    `THE FLOW INTENT:\n${flow.intent}\n\n` +
    `Important: never type, click, or confirm anything the intent tells you NOT to. When done, ` +
    `summarize what you observed in plain text.`;

  log({ kind: "intent", flow: flow.id, tokenUrl });

  const q = sdk.query({
    prompt: intent,
    options: {
      model,
      allowedTools: ["Bash"],
      permissionMode: "default",
      maxTurns,
      systemPrompt:
        "You are a meticulous UX test driver. You drive a real browser through the agent-browser " +
        "CLI only. You never invent shell pipelines; you run one simple agent-browser command at a " +
        "time. You faithfully follow the flow intent and respect every 'do not' instruction.",
      canUseTool: makeBashAllowlist(log),
    },
  });

  const screenshots = [];
  let lastResult = null;
  for await (const msg of q) {
    if (msg.type === "assistant") {
      const a = readAssistant(msg);
      for (const t of a.text) if (t.trim()) log({ kind: "assistant_text", text: t });
      for (const tu of a.toolUses) {
        log({ kind: "tool_use", name: tu.name, input: tu.input });
        // Track screenshot paths the agent asked for (best-effort; the file is written by
        // agent-browser itself when the command is allowed + runs).
        const cmd = tu.name === "Bash" && tu.input && typeof tu.input.command === "string" ? tu.input.command : "";
        const m = cmd.match(/screenshot\s+(?:--annotate\s+)?("?)([^"\s]+\.png)\1/);
        if (m) screenshots.push(m[2]);
      }
    } else if (msg.type === "result") {
      lastResult = msg;
      log({ kind: "result", subtype: msg.subtype, is_error: msg.is_error });
    } else if (msg.type === "system") {
      log({ kind: "system", subtype: msg.subtype });
    }
  }

  // Console errors are captured by the agent via `agent-browser errors`; the flow's
  // post-asserts + the judge read them from the transcript. We also surface a flat list.
  const errors = transcript
    .filter((e) => e.kind === "assistant_text" && /error/i.test(e.text))
    .map((e) => e.text);

  // Write a manifest so run-ux.mjs / the judge can find the evidence deterministically.
  const manifest = { flow: flow.id, tokenUrl, screenshots, transcriptPath, resultSubtype: lastResult?.subtype || null };
  writeFileSync(path.join(evidenceDir, "driver-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  return { transcript, screenshots, errors };
}
