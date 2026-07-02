#!/usr/bin/env node
// Asks capture hook (AIO-167) — a dependency-free Claude Code Notification/Stop hook that drops
// escalations into the local asks queue. It writes the SAME v1 NDJSON create line and honors the
// SAME lockfile protocol as src/operator-loop/asks/store.ts (a parity test proves hook-written
// lines fold identically via the compiled store) — reimplemented here because `dist` may be
// unbuilt when a hook fires.
//
// HARD RULE: this hook must NEVER disturb a session. Everything is wrapped in try/catch and the
// process ALWAYS exits 0. A missed capture (lock busy, malformed payload, unreadable transcript)
// is acceptable; blocking or crashing a session is not.

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

const ASKS_STORE_REL = ".aios/loop/asks/asks.ndjson";
const SCHEMA_VERSION = 1;
const TITLE_MAX = 200;
const HARD_LINE_CAP = 5000;
const STDIN_MAX = 1_000_000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_RETRIES = 40; // ~1s bounded retries (matches the store); a missed capture is acceptable
const LOCK_DELAY_MS = 25;

// eslint-disable-next-line no-control-regex -- intentional: collapse control chars in a title
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f]+", "g");
const IDLE_RE = /waiting for your (input|response)/i;
const INTERROGATIVE_RE = /\?\s*$/;
const COMPLETION_RE =
  /\b(done|completed?|finished|shipped|ready for review|tests? pass(ing)?|PR (is )?up)\b/i;

const sha256 = (s) => createHash("sha256").update(s).digest("hex");

function normalizeTitle(raw) {
  return String(raw ?? "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_MAX);
}

function storePath(root) {
  return path.join(root, ASKS_STORE_REL);
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

// Run `fn` while holding the store lock. Returns fn's result, or null on any failure (skip
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
  try {
    try {
      writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    } catch {
      /* advisory pid stamp only */
    }
    closeSync(fd);
    return fn(abs);
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  }
}

// Set of dedupeKeys currently OPEN (mini-fold: create opens, resolve/orphan closes; first wins).
function openDedupeKeys(root) {
  const abs = storePath(root);
  if (!existsSync(abs)) return { keys: new Set(), lineCount: 0 };
  let text;
  try {
    text = readFileSync(abs, "utf8");
  } catch {
    return { keys: new Set(), lineCount: 0 };
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const byId = new Map();
  for (const l of lines) {
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object" || o.v !== SCHEMA_VERSION) continue;
    if (o.op === "create" && o.ask && typeof o.ask.id === "string") {
      if (!byId.has(o.ask.id))
        byId.set(o.ask.id, { dedupeKey: o.ask.dedupeKey ?? null, open: true });
    } else if ((o.op === "resolve" || o.op === "orphan") && typeof o.id === "string") {
      const e = byId.get(o.id);
      if (e) e.open = false;
    }
  }
  const keys = new Set();
  for (const e of byId.values()) if (e.open && e.dedupeKey) keys.add(e.dedupeKey);
  return { keys, lineCount: lines.length };
}

function buildCreateLine(rec) {
  return JSON.stringify({ v: SCHEMA_VERSION, op: "create", ask: rec });
}

// Write a create line unless it is a duplicate of an open ask or the store is over the hard cap.
// The dedupe/cap read happens INSIDE the held lock, so a concurrent writer with the same key
// cannot slip between the check and the append.
function capture(root, rec) {
  withStoreLock(root, (abs) => {
    const { keys, lineCount } = openDedupeKeys(root);
    if (lineCount > HARD_LINE_CAP) return; // store is unmaintained — skip rather than pile on
    if (rec.dedupeKey && keys.has(rec.dedupeKey)) return; // open duplicate
    appendFileSync(abs, buildCreateLine(rec) + "\n");
  });
}

function baseRecord(fields) {
  return {
    id: randomUUID(),
    dedupeKey: null,
    kind: "general",
    severity: "fyi",
    title: "",
    body: "",
    ref: null,
    source: "hook",
    sessionId: null,
    tailHash: null,
    transcriptPath: null,
    tier: "admin",
    createdAt: new Date().toISOString(),
    ...fields,
  };
}

// Extract the last assistant text tail from a Claude Code transcript JSONL tail slice. Supports
// `message.content` as an array of blocks (last {type:"text"} block; tool_use/thinking ignored)
// or as a string; ignores user/progress/tool_result lines. Returns the last non-empty line or null.
function lastAssistantTail(transcriptPath) {
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
  const lines = slice.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue; // partial first line or noise
    }
    if (!o || o.type !== "assistant") continue;
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
    if (textVal == null) continue;
    const nonEmpty = textVal
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!nonEmpty.length) continue;
    return nonEmpty[nonEmpty.length - 1];
  }
  return null;
}

function handleNotification(root, payload) {
  const message = typeof payload.message === "string" ? payload.message : "";
  if (!IDLE_RE.test(message)) return; // idle patterns only
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  capture(
    root,
    baseRecord({
      kind: "idle",
      severity: "blocker",
      title: normalizeTitle(message) || "Agent is waiting for your input",
      source: "hook:idle",
      sessionId,
      transcriptPath,
      dedupeKey: sha256(`${sessionId}|idle`),
    })
  );
}

function handleStop(root, payload) {
  if (payload.stop_hook_active) return; // avoid recursion on hook-triggered stops
  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  if (!transcriptPath) return;
  const tail = lastAssistantTail(transcriptPath);
  if (!tail) return;

  let severity = null;
  if (INTERROGATIVE_RE.test(tail)) severity = "decision";
  else if (COMPLETION_RE.test(tail)) severity = "fyi";
  if (!severity) return; // plain prose → nothing

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const tailNormalized = tail.trim().toLowerCase().replace(/\s+/g, " ");
  const tailHash = sha256(tailNormalized);
  capture(
    root,
    baseRecord({
      kind: "stop",
      severity,
      title: normalizeTitle(tail),
      source: "hook:stop",
      sessionId,
      transcriptPath,
      tailHash,
      dedupeKey: sha256(`${sessionId}|${tailHash}`),
    })
  );
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

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  const event = payload.hook_event_name;
  if (event === "Notification") handleNotification(root, payload);
  else if (event === "Stop") handleStop(root, payload);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
