#!/usr/bin/env node
// Maturity nudge hook (AIO-233 / AM3) — a dependency-free Claude Code UserPromptSubmit hook that
// fires exactly ONE live anti-pattern detector: context bloat (a session that has run long enough
// it should have been `/clear`ed). This is the moment-of-anti-pattern sibling of maturity-brief.mjs
// (AM2, SessionStart — coaches between sessions); this one coaches inside one.
//
// HARD RULE: this hook must NEVER disturb a session. Everything is wrapped in try/catch and the
// process ALWAYS exits 0. A missed nudge (unreadable transcript, malformed state, whatever) is
// acceptable; blocking or crashing a session is not. Nudges are interruptions — a noisy nudger
// trains the operator to ignore it, so this fires AT MOST once per session, ever, plus a global
// cooldown floor across sessions.

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { parseJsonl, recordsToEvents } from "../scripts/analyze/parse-claude.mjs";

const STDIN_MAX = 1_000_000;
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024; // 2 MB tail read
const BLOAT_TURNS = 40;
const GLOBAL_COOLDOWN_MIN = 60;
const STATE_PRUNE_MS = 7 * 24 * 60 * 60 * 1000; // drop entries older than 7 days on write

const STATE_REL = ".aios/loop/maturity/nudge-state.json";

const NUDGE_MESSAGE =
  "[maturity-nudge] This session is 40+ user turns long. If you're on a new task, a fresh " +
  "session (/clear) will be faster, cheaper, and less error-prone — long stale context is the " +
  "#1 drag on your Context-hygiene axis.";

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

// Tail-read up to `maxBytes` from the end of a file. Returns "" on any failure.
function readTail(filePath, maxBytes) {
  try {
    const size = statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(len);
      const read = readSync(fd, buf, 0, len, start);
      return buf.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// Count genuine user turns (a string/text body — same classification rule as
// scripts/analyze/parse-claude.mjs uses for task roots). tool_result-bearing user records are
// never counted, since recordsToEvents only tags them block_type:"tool_result".
function countUserTurns(transcriptPath, fallbackId) {
  const text = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  if (!text) return 0;
  const records = parseJsonl(text);
  const events = recordsToEvents(records, fallbackId);
  let n = 0;
  for (const e of events) {
    if (e.actor === "user" && e.block_type === "text") n++;
  }
  return n;
}

function statePath(root) {
  return path.join(root, STATE_REL);
}

// Read {sessions:{sid: nudgedAtISO}, lastGlobalNudge: ISOString|null}. Any error → fresh state.
function readState(sp) {
  try {
    const st = JSON.parse(readFileSync(sp, "utf8"));
    if (st && typeof st === "object") {
      return {
        sessions: st.sessions && typeof st.sessions === "object" ? st.sessions : {},
        lastGlobalNudge: typeof st.lastGlobalNudge === "string" ? st.lastGlobalNudge : null,
      };
    }
  } catch {
    /* missing / malformed — start fresh */
  }
  return { sessions: {}, lastGlobalNudge: null };
}

// Prune session entries older than 7 days, then best-effort atomic write. Never throws.
function writeState(sp, state, now) {
  const cutoff = now - STATE_PRUNE_MS;
  const sessions = {};
  for (const [sid, nudgedAt] of Object.entries(state.sessions)) {
    const t = new Date(nudgedAt).getTime();
    if (Number.isFinite(t) && t >= cutoff) sessions[sid] = nudgedAt;
  }
  try {
    mkdirSync(path.dirname(sp), { recursive: true });
    const tmp = sp + ".tmp";
    writeFileSync(tmp, JSON.stringify({ sessions, lastGlobalNudge: state.lastGlobalNudge }));
    renameSync(tmp, sp);
  } catch {
    /* state write failed — the nudge itself still emits */
  }
}

async function main() {
  // Kill switch: opt out entirely without touching settings.json.
  if (process.env.AIOS_MATURITY_NUDGE === "0") return;

  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // no/garbage stdin → nothing to do
  }
  if (!payload || typeof payload !== "object") return;
  if (payload.hook_event_name !== "UserPromptSubmit") return;

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  if (!sessionId || !transcriptPath) return;

  const turns = countUserTurns(transcriptPath, sessionId);
  if (turns < BLOAT_TURNS) return;

  const sp = statePath(root);
  const state = readState(sp);

  if (Object.prototype.hasOwnProperty.call(state.sessions, sessionId)) return; // already nudged

  const now = Date.now();
  if (state.lastGlobalNudge) {
    const last = new Date(state.lastGlobalNudge).getTime();
    if (Number.isFinite(last) && now - last < GLOBAL_COOLDOWN_MIN * 60 * 1000) return;
  }

  const nowIso = new Date(now).toISOString();
  state.sessions[sessionId] = nowIso;
  state.lastGlobalNudge = nowIso;
  writeState(sp, state, now);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: NUDGE_MESSAGE },
    })
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
