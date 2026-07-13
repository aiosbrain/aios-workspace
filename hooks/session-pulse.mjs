#!/usr/bin/env node
// Session pulse Stop hook (AIO-214) — prints one concise `aios tip:` from the last
// `aios analyze` run. It stays silent while Claude Code deep-work mode disables ambient
// notifications.
//
// HARD RULE (same as hooks/asks-capture.mjs): this hook must NEVER disturb a session. Everything
// is wrapped in try/catch and the process ALWAYS exits 0. A missed pulse is acceptable; blocking
// or crashing a session is not.
//
// Dependency-free and self-contained on purpose: this file is copied standalone into scaffolded
// workspaces (scripts/scaffold-project.sh), which do not carry scripts/analyze/. It is a DUMB
// reader only — all scoring/tips are precomputed by `aios analyze` into last_summary
// (scripts/analyze/report.mjs#buildLastSummary); this hook never recomputes anything.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const ANALYZE_STATE_REL = ".aios/analyze-state.json";
const PULSE_STATE_REL = ".aios/session-pulse-state.json";
const PULSE_THROTTLE_MS = 45 * 60 * 1000; // 45 min
const SUGGEST_THROTTLE_MS = 24 * 60 * 60 * 1000; // 24h
const STALE_MS = 24 * 60 * 60 * 1000; // 24h
const STDIN_MAX = 1_000_000;

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  try {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2));
  } catch {
    /* best-effort — a missed throttle write is acceptable */
  }
}

function fmtAge(ms) {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(ms / 86_400_000);
  return `${days}d ago`;
}

function buildPulseMessage(summary, now) {
  const ageMs = now - Date.parse(summary.generated_at);
  const stale = Number.isFinite(ageMs) && ageMs > STALE_MS;
  const freshness = Number.isFinite(ageMs) ? fmtAge(ageMs) : "unknown";
  return (
    `aios tip: ${summary.weakest_tip || "run aios analyze"}` +
    (stale ? ` (data ${freshness} old — run aios analyze)` : "")
  );
}

function ambientNotificationsDisabled() {
  const settingsPath = path.join(process.env.HOME || "", ".claude", "settings.json");
  const settings = readJson(settingsPath);
  return settings?.preferredNotifChannel === "notifications_disabled";
}

function emit(systemMessage) {
  process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);
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
  if (payload.stop_hook_active) return; // avoid recursion on hook-triggered stops
  if (ambientNotificationsDisabled()) return;

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  const pulseStatePath = path.join(root, PULSE_STATE_REL);
  const pulseState = readJson(pulseStatePath) || { last_pulse_at: null, last_suggest_at: null };
  const now = Date.now();

  const lastPulseMs = pulseState.last_pulse_at ? Date.parse(pulseState.last_pulse_at) : NaN;
  if (Number.isFinite(lastPulseMs) && now - lastPulseMs < PULSE_THROTTLE_MS) return; // throttled

  const analyzeState = readJson(path.join(root, ANALYZE_STATE_REL));
  const summary = analyzeState && analyzeState.last_summary;

  if (summary && summary.generated_at) {
    emit(buildPulseMessage(summary, now));
    pulseState.last_pulse_at = new Date(now).toISOString();
    writeJson(pulseStatePath, pulseState);
    return;
  }

  // No precomputed state yet — suggest running analyze, at most once per 24h.
  const lastSuggestMs = pulseState.last_suggest_at ? Date.parse(pulseState.last_suggest_at) : NaN;
  if (Number.isFinite(lastSuggestMs) && now - lastSuggestMs < SUGGEST_THROTTLE_MS) return; // silent

  emit("aios tip: run `aios analyze` once to start maturity tracking.");
  pulseState.last_suggest_at = new Date(now).toISOString();
  writeJson(pulseStatePath, pulseState);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
