#!/usr/bin/env node
// Session pulse Stop hook (AIO-214) — prints a 2-line pulse from the last `aios analyze` run:
// AM Spine/overall, the CE shadow band, the weakest axis + tip, and a freshness reading. Living
// proof that maturity monitoring runs in the background, without running anything by hand.
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

// Duplicated from scripts/analyze/aem.mjs on purpose (see file header: this hook must stay
// dependency-free and standalone in a scaffolded workspace that has no scripts/analyze/).
const AXIS_LABELS = {
  verification: "Verification",
  context_hygiene: "Context hygiene",
  autonomy: "Autonomy / leash",
  learning: "Learning / compounding",
  cost_governance: "Cost & governance",
};

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
  const weakestLabel = AXIS_LABELS[summary.weakest] || summary.weakest || "—";
  const ceBand = summary.ce_band == null ? "–" : `${summary.ce_band}`;
  const overall = Number.isFinite(summary.overall) ? summary.overall.toFixed(1) : "0.0";
  const line1 =
    `Session pulse — AM Spine ${summary.spine} (${overall}/4) · ergonomics ${ceBand}/4 (shadow)` +
    ` · weakest: ${weakestLabel}`;
  const line2 =
    `tip: ${summary.weakest_tip || "—"} · measured ${freshness}` +
    (stale ? " (stale — run aios analyze or `aios loop install` for a scheduled refresh)" : "");
  return `${line1}\n${line2}`;
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

  emit("Session pulse — no maturity data yet. Run `aios analyze` to start tracking.");
  pulseState.last_suggest_at = new Date(now).toISOString();
  writeJson(pulseStatePath, pulseState);
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
