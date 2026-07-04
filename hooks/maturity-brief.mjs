#!/usr/bin/env node
// Maturity brief hook (AIO-228 / AM2) — a dependency-free Claude Code SessionStart hook that
// folds the operator's RECENT sessions from the local maturity store
// (.aios/loop/maturity/sessions.ndjson, written by AM1's maturity-capture.mjs) and emits a
// 3-line AEM brief into the session's opening context: current Spine placement, the weakest
// axis, and one rotating practical tip for that axis. Both the human and the agent then start
// each session aware of where the operator is weak.
//
// This is the READ side of AM1. It is:
//   - read-only on the admin-tier session store (never writes sessions.ndjson); its ONLY write is
//     a tiny sibling brief-state.json that rotates the tip counter — best-effort, never fatal,
//   - fail-open — ANY error, missing data, or doubt → print nothing and exit 0,
//   - silent until there's signal (≥5 recent sessions for THIS project in 14 days),
//   - under a strict compute budget (pure fs + arithmetic, no process spawn, no network).
// Nothing is pushed anywhere. It reuses the analyze pipeline as plain .mjs SOURCE — NEVER dist/.
//
// DIVERGENCE from the silent state-writer siblings (asks-capture / maturity-capture): a
// SessionStart hook's stdout surfaces to the session as `additionalContext`, so the
// fully-successful happy path DOES print exactly one JSON object. Every other path prints nothing.

import { readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { foldSessions, storePath } from "../scripts/analyze/maturity-store.mjs";
import { placement, AXIS_LABELS } from "../scripts/analyze/aem.mjs";
import { AXIS_GUIDE } from "../scripts/analyze/guidance.mjs";
import { projectSlug, foldSignals, STORE_SIZE_CAP } from "../scripts/analyze/maturity-fold.mjs";

const STDIN_MAX = 1_000_000;
const WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // recency window
const MIN_SESSIONS = 5; // silent until there's signal

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

// Advance the rotating-tip counter. Read/write are best-effort: a state failure degrades to a
// repeated tip, never suppresses the brief. Returns the stepIndex to use for THIS emit.
function nextStepIndex(statePath) {
  let stepIndex = 0;
  try {
    const st = JSON.parse(readFileSync(statePath, "utf8"));
    // Clamp to >= 0: a negative persisted stepIndex would make `stepIndex % steps.length`
    // negative → steps[negative] === undefined → a "Tip: undefined" leak into the session.
    if (st && Number.isFinite(Number(st.stepIndex)))
      stepIndex = Math.max(0, Math.floor(Number(st.stepIndex)));
  } catch {
    stepIndex = 0; // missing / malformed → start at 0
  }
  try {
    mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = statePath + ".tmp";
    writeFileSync(
      tmp,
      JSON.stringify({ stepIndex: stepIndex + 1, lastEmit: new Date().toISOString() })
    );
    renameSync(tmp, statePath);
  } catch {
    /* state write failed — degrade to a repeated tip, still emit the brief */
  }
  return stepIndex;
}

async function main() {
  // Kill switch: opt out entirely without touching settings.json.
  if (process.env.AIOS_MATURITY_BRIEF === "0") return;

  let payload;
  try {
    payload = JSON.parse(await readStdin());
  } catch {
    return; // no/garbage stdin → nothing to do
  }
  if (!payload || typeof payload !== "object") return;
  if (payload.hook_event_name !== "SessionStart") return;

  const root =
    process.env.CLAUDE_PROJECT_DIR ||
    (typeof payload.cwd === "string" ? payload.cwd : null) ||
    process.cwd();

  const sp = storePath(root);
  let text;
  try {
    if (statSync(sp).size > STORE_SIZE_CAP) return; // oversized — fail-open, protect the budget
    text = readFileSync(sp, "utf8");
  } catch {
    return; // missing / unreadable store (ENOENT is the empty-store case)
  }

  const { sessions } = foldSessions(text);

  // Filter to THIS project's sessions (the store co-mingles every repo that shared `root`,
  // keyed only by session_id). Reproduce AM1's tag from THIS payload's cwd (root fallback).
  const project = projectSlug(typeof payload.cwd === "string" ? payload.cwd : root);
  const cutoff = Date.now() - WINDOW_MS;
  const recent = [...sessions.values()].filter((s) => {
    if (!s || !s.counts || s.project !== project) return false;
    const t = new Date(s.ended_at).getTime();
    return Number.isFinite(t) && t >= cutoff;
  });

  if (recent.length < MIN_SESSIONS) return; // silent until there's signal

  const signals = foldSignals(recent);
  const p = placement(signals); // { axes, spine:"L4", overall, weakest:"autonomy" }
  const axis = p.weakest; // axis KEY — aligns across AXIS_LABELS + AXIS_GUIDE
  const label = AXIS_LABELS[axis];
  const score = p.axes[axis];

  const steps = (AXIS_GUIDE[axis] && AXIS_GUIDE[axis].steps) || [];
  if (steps.length === 0) return; // no guidance to give (defensive; every axis has 3)

  const statePath = path.join(path.dirname(sp), "brief-state.json");
  const stepIndex = nextStepIndex(statePath);
  const tip = steps[stepIndex % steps.length];

  const additionalContext = [
    `AEM placement: ${p.spine} (weakest axis: ${label} ${score}/4).`,
    `Tip: ${tip}`,
    "Full report: `npm run aios -- analyze --report`",
  ].join("\n");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
    })
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
