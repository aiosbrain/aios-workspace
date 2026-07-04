#!/usr/bin/env node
// Instinct observe hook (AIO-229 / AM4a) — a dependency-free Claude Code Stop hook that detects
// when the operator corrected the agent's prior turn and folds one observation into the local
// maturity store (.aios/loop/maturity/observations.ndjson). Feeds the AM4b instinct-distillation
// pipeline. Clones the hook discipline of hooks/asks-capture.mjs verbatim; the store's fold/write
// logic lives in scripts/analyze/maturity-store.mjs (plain source — never dist/, which may be
// unbuilt when a hook fires).
//
// HARD RULE: this hook must NEVER disturb a session. Everything is wrapped in try/catch and the
// process ALWAYS exits 0, printing nothing. A missed capture (busy lock, malformed payload,
// unreadable transcript, ambiguous correction text) is acceptable; blocking or crashing a
// session is not. Precision over recall: an ambiguous turn is skipped, never guessed at.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendObservation, sha256 } from "../scripts/analyze/maturity-store.mjs";

const STDIN_MAX = 1_000_000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const SNIPPET_MAX = 280;

// eslint-disable-next-line no-control-regex -- intentional: collapse control chars in a snippet
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");

// Benign "no …" replies (checked before the correction branch — a lookahead on \s* cannot
// exclude these because \s* may match zero width, leaving the cursor on the space before
// "worries"/"problem"/etc.).
const NO_BENIGN_RE =
  /^no\b(?:[,.\-–—]\s*|\s+)(?:worries|problem|rush|need|thanks(?:\s+you)?|thank\s+you)\b/i;
// "no" as a whole word at turn start (includes bare "no", "no - …", "no, …" corrections).
const NO_BRANCH_RE = /^no\b/i;
const SAID_AGAIN_RE =
  /\b(i (?:already |just )?(?:said|told you|mentioned)|as i said|like i said|again,? please)\b/i;
const IMPERATIVE_VERBS =
  "use|don't|do not|stop|remove|add|keep|revert|undo|change|fix|avoid|never|always|put|move|delete|replace|make|write|call";
const ACTUALLY_INSTEAD_RE = new RegExp(
  `\\b(actually|instead)\\b[^.?!]{0,60}\\b(${IMPERATIVE_VERBS})\\b`,
  "i"
);

function normalizeSnippet(raw) {
  return String(raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SNIPPET_MAX);
}

function isCorrection(text) {
  if (!text) return false;
  if (NO_BENIGN_RE.test(text)) return false;
  return NO_BRANCH_RE.test(text) || SAID_AGAIN_RE.test(text) || ACTUALLY_INSTEAD_RE.test(text);
}

// A genuine user-authored text turn (not a synthetic tool_result "user" message). Returns the
// trimmed text, or null if this line isn't one.
function extractGenuineUserText(o) {
  const content = o.message?.content;
  if (typeof content === "string") {
    const t = content.trim();
    return t || null;
  }
  if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === "tool_result")) return null; // synthetic turn
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b && b.type === "text" && typeof b.text === "string" && b.text.trim()) {
        return b.text.trim();
      }
    }
  }
  return null;
}

// The assistant's text tail (last text block/string), or null if this turn carried no text
// (e.g. it ended tool_use-only).
function extractAssistantText(o) {
  const content = o.message?.content;
  let textVal = null;
  if (typeof content === "string") {
    textVal = content;
  } else if (Array.isArray(content)) {
    for (let j = content.length - 1; j >= 0; j--) {
      const b = content[j];
      if (b && b.type === "text" && typeof b.text === "string") {
        textVal = b.text;
        break;
      }
    }
  }
  if (textVal == null) return null;
  const trimmed = textVal.trim();
  return trimmed || null;
}

// Read the transcript's tail, find the LAST genuine user text turn (walking backward), then the
// assistant text immediately preceding it. Returns null if no genuine user turn is found.
function lastTurnPair(transcriptPath) {
  let slice;
  try {
    const size = statSync(transcriptPath).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const len = size - start;
    const fd = openSync(transcriptPath, "r");
    try {
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, start);
      slice = buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }

  const parsed = [];
  for (const l of slice.split(/\r?\n/)) {
    const t = l.trim();
    if (!t) continue;
    try {
      parsed.push(JSON.parse(t));
    } catch {
      // partial first line or noise — skip
    }
  }

  let userIdx = -1;
  let userText = null;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const o = parsed[i];
    if (!o || o.type !== "user") continue;
    const text = extractGenuineUserText(o);
    if (text != null) {
      userIdx = i;
      userText = text;
      break;
    }
  }
  if (userIdx === -1) return null;

  let assistantText = "";
  for (let i = userIdx - 1; i >= 0; i--) {
    const o = parsed[i];
    if (!o || o.type !== "assistant") continue;
    assistantText = extractAssistantText(o) ?? "";
    break;
  }

  return { userText, assistantText };
}

function handleStop(root, payload) {
  if (payload.stop_hook_active) return; // avoid recursion on hook-triggered stops
  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  if (!transcriptPath) return;

  const pair = lastTurnPair(transcriptPath);
  if (!pair) return;
  if (!isCorrection(pair.userText)) return;

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : randomUUID();
  const now = new Date().toISOString();
  appendObservation(root, {
    id: randomUUID(),
    session_id: sessionId,
    ts: now,
    kind: "correction",
    snippet: normalizeSnippet(pair.userText),
    prior_hash: sha256(pair.assistantText),
    tier: "admin",
    createdAt: now,
  });
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > STDIN_MAX) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // no/garbage stdin → nothing to do
  }
  if (!payload || typeof payload !== "object") return;
  if (payload.hook_event_name !== "Stop") return;

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  handleStop(root, payload);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
