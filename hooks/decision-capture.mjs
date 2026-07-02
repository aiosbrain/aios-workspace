#!/usr/bin/env node
// Decision capture hook (AIO-170 / EE4) — a dependency-free Claude Code PostToolUse hook that
// records human-in-the-loop decision prompts into the local decisions corpus. It writes the SAME
// v1 NDJSON create line and honors the SAME lockfile protocol as
// src/operator-loop/decisions/store.ts (a parity test proves hook-written lines fold identically
// via the compiled store) — reimplemented here because `dist` may be unbuilt when a hook fires.
//
// Two tools ARE the structured decision moments:
//   • AskUserQuestion — one decision record PER question in tool_input.questions[]; the chosen
//     label(s) + any free-text notes are extracted defensively from tool_input.answers /
//     tool_response (unknown shape → choice:null, still captured).
//   • ExitPlanMode — one `plan-approval` record; approved/rejected read from the response text
//     (rejection feedback → notes; unknown → choice:null).
//
// HARD RULE: this hook must NEVER disturb a session. Everything is wrapped in try/catch and the
// process ALWAYS exits 0. A missed capture (lock busy, malformed payload) is acceptable; blocking
// or crashing a session is not.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

const DECISIONS_STORE_REL = ".aios/loop/decisions/decisions.ndjson";
const SCHEMA_VERSION = 1;
const STDIN_MAX = 1_000_000;
const HARD_LINE_CAP = 20_000;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40; // ~1s bounded retries (matches the store); a missed capture is acceptable
const LOCK_DELAY_MS = 25;

const QUESTION_MAX = 500;
const HEADER_MAX = 200;
const NOTES_MAX = 2000;
const OPTION_LABEL_MAX = 200;
const OPTION_DESC_MAX = 1000;
const OPTIONS_MAX = 50;
const CHOICE_MAX = 50;

// eslint-disable-next-line no-control-regex -- intentional: collapse control chars in single-line fields
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function singleLine(raw, max) {
  return String(raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}
function multiline(raw, max) {
  return String(raw ?? "").slice(0, max);
}

function storePath(root) {
  return path.join(root, DECISIONS_STORE_REL);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Acquire the store lock, returning an fd or null (never throws — a busy lock means skip).
function acquireLock(lockPath) {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      return openSync(lockPath, "wx");
    } catch (e) {
      if (e?.code !== "EEXIST") return null;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* lost the reclaim race */
          }
          continue;
        }
      } catch {
        /* lock vanished — retry */
      }
      if (attempt < LOCK_RETRIES) sleepSync(LOCK_DELAY_MS);
    }
  }
  return null;
}

// Run `fn(abs)` while holding the store lock. Returns fn's result, or null on any failure (skip
// silently — a missed capture is acceptable, disturbing the session is not).
function withStoreLock(root, fn) {
  const abs = storePath(root);
  const lockPath = abs + ".lock";
  try {
    mkdirSync(path.dirname(abs), { recursive: true });
  } catch {
    return null;
  }
  const fd = acquireLock(lockPath);
  if (fd === null) return null;
  const token = randomUUID();
  try {
    try {
      writeFileSync(fd, `${process.pid} ${token} ${new Date().toISOString()}\n`);
    } catch {
      /* advisory stamp only */
    }
    closeSync(fd);
    return fn(abs);
  } catch {
    return null;
  } finally {
    // Never delete a reclaimer's lock: only unlink if the file still carries our token.
    try {
      if (readFileSync(lockPath, "utf8").includes(token)) unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

// Existing dedupe keys (sessionId|sha256(question)) + a line count (mini-fold of create lines).
function existingKeys(root) {
  const abs = storePath(root);
  if (!existsSync(abs)) return { keys: new Set(), lineCount: 0 };
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return { keys: new Set(), lineCount: 0 };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const keys = new Set();
  for (const l of lines) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object" || o.v !== SCHEMA_VERSION) continue;
    if (o.op === "create" && o.decision && typeof o.decision.id === "string") {
      const d = o.decision;
      const sid = typeof d.context?.sessionId === "string" ? d.context.sessionId : "";
      keys.add(dedupeKey(sid, singleLine(d.question, QUESTION_MAX)));
    }
  }
  return { keys, lineCount: lines.length };
}

function dedupeKey(sessionId, normalizedQuestion) {
  return `${sessionId ?? ""}|${sha256(normalizedQuestion)}`;
}

function buildCreateLine(rec) {
  return JSON.stringify({ v: SCHEMA_VERSION, op: "create", decision: rec });
}

// Append each record whose (sessionId|question) key isn't already present — the dedupe read
// happens INSIDE the held lock, so a re-fire cannot slip between the check and the append.
function captureAll(root, records) {
  if (!records.length) return;
  withStoreLock(root, (abs) => {
    const { keys, lineCount } = existingKeys(root);
    if (lineCount > HARD_LINE_CAP) return; // store is unmaintained — skip rather than pile on
    for (const rec of records) {
      const key = dedupeKey(rec.context.sessionId ?? "", rec.question);
      if (keys.has(key)) continue; // duplicate (double-fire / re-fire)
      appendFileSync(abs, buildCreateLine(rec) + "\n");
      keys.add(key); // suppress a duplicate later in the SAME payload too
    }
  });
}

function baseDecision(root, ctx, fields) {
  return {
    id: randomUUID(),
    kind: "decision",
    question: "",
    header: null,
    options: [],
    choice: null,
    notes: null,
    context: {
      sessionId: typeof ctx.session_id === "string" ? ctx.session_id : null,
      project: root ? path.basename(root) : null,
      transcriptPath: typeof ctx.transcript_path === "string" ? ctx.transcript_path : null,
      cwd: typeof ctx.cwd === "string" ? ctx.cwd : null,
    },
    tier: "admin",
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

// ── defensive answer extraction (AskUserQuestion) ────────────────────────────────────────────────

// Flatten any value into { labels, notes }: strings become labels; label-bearing object fields are
// recursed; free-text fields become notes.
function collectFromValue(value) {
  const labels = [];
  let notes = null;
  const visit = (x, depth) => {
    if (x == null || depth > 6) return;
    if (typeof x === "string") {
      const s = x.trim();
      if (s) labels.push(s);
      return;
    }
    if (Array.isArray(x)) {
      for (const el of x) visit(el, depth + 1);
      return;
    }
    if (typeof x === "object") {
      for (const k of [
        "label",
        "answer",
        "selected",
        "selectedOption",
        "choice",
        "value",
        "option",
        "options",
      ]) {
        if (k in x) visit(x[k], depth + 1);
      }
      for (const k of ["notes", "note", "other", "freeText", "free_text", "text", "comment"]) {
        if (typeof x[k] === "string" && x[k].trim() && !notes) notes = x[k].trim();
      }
    }
  };
  visit(value, 0);
  return { labels, notes };
}

// Find the answer value for a specific question across candidate containers (tool_input.answers,
// tool_response). Tries: object keyed by question text / header; array of {question|header,...}
// entries; parallel-index array. Returns the raw matched value or undefined.
function findAnswer(container, questionText, header, index) {
  if (container == null) return undefined;
  if (Array.isArray(container)) {
    for (const el of container) {
      if (el && typeof el === "object") {
        const q = typeof el.question === "string" ? el.question : null;
        const h = typeof el.header === "string" ? el.header : null;
        if ((questionText && q === questionText) || (header && h === header)) return el;
      }
    }
    if (index != null && index < container.length) return container[index];
    return undefined;
  }
  if (typeof container === "object") {
    if (questionText && questionText in container) return container[questionText];
    if (header && header in container) return container[header];
  }
  return undefined;
}

function normalizeOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) return [];
  const out = [];
  for (const o of rawOptions.slice(0, OPTIONS_MAX)) {
    if (!o || typeof o !== "object") continue;
    const label = singleLine(o.label, OPTION_LABEL_MAX);
    if (!label) continue;
    const description =
      o.description == null ? null : multiline(o.description, OPTION_DESC_MAX) || null;
    out.push({ label, description });
  }
  return out;
}

function normalizeChoiceLabels(labels) {
  const out = [];
  for (const l of labels.slice(0, CHOICE_MAX)) {
    const s = singleLine(l, OPTION_LABEL_MAX);
    if (s) out.push(s);
  }
  return out.length ? out : null;
}

function handleAskUserQuestion(root, payload) {
  const input = payload.tool_input;
  if (!input || typeof input !== "object" || !Array.isArray(input.questions)) return;
  const response = payload.tool_response;
  const responseObj =
    response && typeof response === "object" && !Array.isArray(response) ? response : null;
  // Candidate answer containers, most-specific first.
  const answerContainers = [
    input.answers,
    responseObj?.answers,
    Array.isArray(response) ? response : undefined,
    responseObj?.response,
    responseObj,
  ];

  const records = [];
  input.questions.forEach((q, i) => {
    if (!q || typeof q !== "object") return;
    const questionText = singleLine(q.question, QUESTION_MAX);
    if (!questionText) return;
    const header = q.header == null ? null : singleLine(q.header, HEADER_MAX) || null;
    const options = normalizeOptions(q.options);

    let labels = [];
    let notes = null;
    for (const container of answerContainers) {
      const value = findAnswer(container, q.question, q.header, i);
      if (value === undefined) continue;
      const collected = collectFromValue(value);
      if (collected.labels.length || collected.notes) {
        labels = collected.labels;
        notes = collected.notes;
        break;
      }
    }
    // Last resort: a bare string response for a SINGLE question is the chosen label.
    if (!labels.length && typeof response === "string" && input.questions.length === 1) {
      const s = singleLine(response, OPTION_LABEL_MAX);
      if (s) labels = [s];
    }

    records.push(
      baseDecision(root, payload, {
        kind: "ask-user-question",
        question: questionText,
        header,
        options,
        choice: normalizeChoiceLabels(labels),
        notes: notes ? multiline(notes, NOTES_MAX) : null,
      })
    );
  });

  captureAll(root, records);
}

// ── plan approval extraction (ExitPlanMode) ──────────────────────────────────────────────────────

function responseToText(response) {
  if (response == null) return "";
  if (typeof response === "string") return response;
  if (Array.isArray(response)) {
    return response
      .map((b) => (b && typeof b === "object" && typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof response === "object") {
    for (const k of ["text", "response", "message", "output", "result"]) {
      if (typeof response[k] === "string") return response[k];
    }
    if (Array.isArray(response.content)) return responseToText(response.content);
    if (typeof response.content === "string") return response.content;
  }
  return "";
}

function planTitle(input) {
  const plan =
    input && typeof input === "object" && typeof input.plan === "string" ? input.plan : "";
  for (const line of plan.split(/\r?\n/)) {
    const t = line.replace(/^#+\s*/, "").trim();
    if (t) return singleLine(t, QUESTION_MAX - 16);
  }
  return "";
}

function handleExitPlanMode(root, payload) {
  const title = planTitle(payload.tool_input);
  const question = title ? `Plan approval: ${title}` : "Plan approval";
  const text = responseToText(payload.tool_response).trim();

  let choice = null;
  let notes = null;
  if (text) {
    if (/\bapprov/i.test(text)) {
      choice = ["approved"];
    } else {
      // Any non-approval response is a rejection; the response text is the user's feedback.
      choice = ["rejected"];
      notes = text;
    }
  }

  captureAll(root, [
    baseDecision(root, payload, {
      kind: "plan-approval",
      question: singleLine(question, QUESTION_MAX),
      choice,
      notes: notes ? multiline(notes, NOTES_MAX) : null,
    }),
  ]);
}

// ── stdin + dispatch ─────────────────────────────────────────────────────────────────────────────

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
  if (payload.hook_event_name !== "PostToolUse") return;

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  const tool = payload.tool_name;
  if (tool === "AskUserQuestion") handleAskUserQuestion(root, payload);
  else if (tool === "ExitPlanMode") handleExitPlanMode(root, payload);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
