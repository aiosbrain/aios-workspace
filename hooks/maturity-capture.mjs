#!/usr/bin/env node
// Maturity capture hook (AIO-227 / AM1) — a dependency-free Claude Code SessionEnd hook that
// folds one per-session AEM signals record into the local maturity store
// (.aios/loop/maturity/sessions.ndjson). It reuses the analyze signal pipeline as plain .mjs
// SOURCE (parse-claude → normalize → metrics.computeSessionRecord) and the append-under-lock
// logic in scripts/analyze/maturity-store.mjs — NEVER imports from dist/ (may be unbuilt when a
// hook fires).
//
// HARD RULE: this hook must NEVER disturb a session. Everything is wrapped in try/catch and the
// process ALWAYS exits 0, printing nothing. A missed capture (busy lock, oversized/unreadable
// transcript, empty events) is acceptable; blocking or crashing a session is not.

import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseClaude } from "../scripts/analyze/parse-claude.mjs";
import { computeSessionRecord } from "../scripts/analyze/metrics.mjs";
import { appendSession } from "../scripts/analyze/maturity-store.mjs";

const STDIN_MAX = 1_000_000;
const TRANSCRIPT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB read cap

// Slugify a cwd basename into a stable project id (lowercase, non-alphanumerics → "-").
function projectSlug(cwd) {
  try {
    return path
      .basename(String(cwd || ""))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  } catch {
    return "";
  }
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
  if (payload.hook_event_name !== "SessionEnd") return;

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  if (!transcriptPath) return;

  let text;
  try {
    if (statSync(transcriptPath).size > TRANSCRIPT_MAX_BYTES) return; // oversized — skip silently
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return; // missing / unreadable transcript
  }

  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const events = parseClaude(text, sessionId ?? "unknown");
  if (events.length === 0) return;

  const { signals, counts } = computeSessionRecord(events);
  const now = new Date().toISOString();
  const session = {
    session_id: sessionId ?? "unknown",
    tool: "claude",
    project: projectSlug(typeof payload.cwd === "string" ? payload.cwd : root),
    ended_at: now,
    event_count: events.length,
    signals,
    counts,
    tier: "admin",
    captured_at: now,
  };

  appendSession(root, session);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
