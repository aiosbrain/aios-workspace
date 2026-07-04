/**
 * maturity-week.mjs — AM6 weekly agentic-maturity report + belts (AIO-231).
 *
 * Where AM2's SessionStart brief nudges the operator on their weakest axis each
 * session, the weekly report shows TRAJECTORY: did the Spine level move, which
 * axis gained, and exactly what unlocks the next belt. Belts (White→Black, plus a
 * "Ninja Master" honorific at a perfect L5) make progression legible.
 *
 * This is a read-only consumer of AM1's session store. It folds a week's sessions
 * with the SAME shared fold as the brief (scripts/analyze/maturity-fold.mjs) and
 * scores with the SAME placement()/nextSpineBlockers() as the analyzer — the
 * next-belt thresholds come straight from aem.mjs's band constants, never a
 * duplicated table. Output is a local admin-tier markdown file under 3-log/ —
 * nothing is pushed. Zero dependencies.
 */

import { placement, nextSpineBlockers, AXIS_LABELS, VERIFICATION_GATE } from "./analyze/aem.mjs";
import { AXIS_GUIDE } from "./analyze/guidance.mjs";
import { foldSignals } from "./analyze/maturity-fold.mjs";

// Belt names per Spine level — the single source of truth for the ladder.
export const BELTS = { L1: "White", L2: "Yellow", L3: "Green", L4: "Brown", L5: "Black" };
// Below this, a week is too thin for an honest trajectory read.
export const MIN_WEEK_SESSIONS = 5;

// Per-axis ceiling. Every axis tops out at 4 EXCEPT learning, which scoreLearning()
// caps at 3 (session logs can't observe true rule/skill write-back). So the "perfect"
// placement that earns Ninja Master is all-axes-maxed, NOT literally all-4s — the
// latter is unreachable and the honorific would be dead code.
const AXIS_MAX = {
  verification: 4,
  context_hygiene: 4,
  autonomy: 4,
  learning: 3,
  cost_governance: 4,
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// Plain-English gloss for each Spine level. Redefined here (not imported) because
// report.mjs's SPINE_GLOSS is module-private and that file is frozen (EE10).
const SPINE_GLOSS = {
  L1: "Prompting — you ask, and take what comes back",
  L2: "Prompt Engineering — reusable prompts, and you review the diffs",
  L3: "Context Engineering — you manage the agent's context and tools deliberately",
  L4: "Agentic Engineering — agents run against checks, and you review the work",
  L5: "Agentic Orchestration — multiple agents, your own evals, feedback loops",
};

/** UTC Monday (00:00Z) of the ISO week containing `date`. */
export function isoMonday(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const diff = (d.getUTCDay() + 6) % 7; // days since Monday (Sun=0 → 6)
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/**
 * Bucket sessions into the current and prior UTC-Monday weeks by `ended_at`.
 * Rows with no counts or an unparseable ended_at are dropped.
 * @returns {{ thisWeek: object[], prevWeek: object[] }}
 */
export function splitWeeks(sessions, now) {
  const thisMon = isoMonday(now).getTime();
  const prevMon = thisMon - WEEK_MS;
  const nextMon = thisMon + WEEK_MS;
  const thisWeek = [];
  const prevWeek = [];
  for (const s of sessions) {
    if (!s || !s.counts) continue;
    const t = new Date(s.ended_at).getTime();
    if (!Number.isFinite(t)) continue;
    if (t >= thisMon && t < nextMon) thisWeek.push(s);
    else if (t >= prevMon && t < thisMon) prevWeek.push(s);
  }
  return { thisWeek, prevWeek };
}

function sumTasks(sessions) {
  let n = 0;
  for (const s of sessions) n += Number(s?.counts?.tasks) || 0;
  return n;
}

const levelNum = (spine) => Number(String(spine).slice(1)); // "L3" → 3

/**
 * Build the pure weekly report from two pre-split session arrays. Never fakes a
 * delta: with < MIN_WEEK_SESSIONS this week it returns an insufficient-data shape;
 * with an under-strength prior week it still reports this week's placement/belt but
 * leaves the deltas null.
 * @param {{ sessions: object[], prevWeekSessions?: object[], now: Date }} args
 */
export function buildWeekReport({ sessions, prevWeekSessions = [], now }) {
  const weekOf = isoMonday(now).toISOString().slice(0, 10);
  const sessionCount = sessions.length;
  const taskCount = sumTasks(sessions);

  if (sessionCount < MIN_WEEK_SESSIONS) {
    return {
      sufficient: false,
      weekOf,
      insufficient: { have: sessionCount, need: MIN_WEEK_SESSIONS },
      sessionCount,
      taskCount,
      spine: null,
      spineDelta: null,
      belt: null,
      isNinjaMaster: false,
      axes: null,
      axesDeltas: null,
      weakest: null,
      nextBelt: null,
      signals: null,
    };
  }

  const signals = foldSignals(sessions);
  const p = placement(signals); // { axes, spine, overall, weakest }
  const { axes, spine, weakest } = p;

  let spineDelta = null;
  let axesDeltas = null;
  if (prevWeekSessions.length >= MIN_WEEK_SESSIONS) {
    const prev = placement(foldSignals(prevWeekSessions));
    spineDelta = levelNum(spine) - levelNum(prev.spine);
    axesDeltas = {};
    for (const k of Object.keys(axes)) axesDeltas[k] = axes[k] - prev.axes[k];
  }

  const belt = BELTS[spine];
  const isNinjaMaster =
    spine === "L5" && Object.entries(axes).every(([k, v]) => v >= (AXIS_MAX[k] ?? 4));
  const nextBelt = spine === "L5" ? null : nextSpineBlockers(axes, signals);

  return {
    sufficient: true,
    weekOf,
    sessionCount,
    taskCount,
    spine,
    spineDelta,
    belt,
    isNinjaMaster,
    axes,
    axesDeltas,
    weakest,
    nextBelt,
    signals,
  };
}

// ── rendering ───────────────────────────────────────────────────────────────

function bar(score) {
  const s = Math.max(0, Math.min(4, Math.round(score)));
  return "▰".repeat(s) + "▱".repeat(4 - s);
}

function fmtDelta(d) {
  if (d == null) return "";
  if (d === 0) return " (±0)";
  return d > 0 ? ` (+${d})` : ` (${d})`;
}

// Format a signal's raw value for display. Ratios → 2dp; tool_diversity → 1dp;
// tokens/task → rounded integer (no thousands separators, so the exact band
// threshold from aem.mjs is greppable in the output + the tests).
function fmtSignalVal(signal, v) {
  const n = Number(v) || 0;
  if (signal === "tokens_per_task") return String(Math.round(n));
  if (signal === "tool_diversity") return n.toFixed(1);
  return n.toFixed(2);
}

// One next-belt bullet. Sourced entirely from the blocker's current + neededValue,
// which originate in aem.mjs's band constants (never hardcoded here).
function describeBlocker(b) {
  const label = AXIS_LABELS[b.axis] || b.axis;
  const cur = fmtSignalVal(b.signal, b.current);
  if (b.signal === "tokens_per_task") {
    // Inverted axis: lower is better.
    return `**${label}** → ${b.neededScore}/4 — \`${b.signal}\` is ${cur}, needs ≤ ${Math.round(
      b.neededValue
    )} fresh tokens/task`;
  }
  if (b.neededScore == null) {
    // Raw-signal floor (L5 subagent_usage): a share-of-sessions target, not an axis score.
    return `**${label}** — \`${b.signal}\` is ${cur}, needs ≥ ${fmtSignalVal(
      b.signal,
      b.neededValue
    )} (share of sessions using a sub-agent)`;
  }
  return `**${label}** → ${b.neededScore}/4 — \`${b.signal}\` is ${cur}, needs ≥ ${fmtSignalVal(
    b.signal,
    b.neededValue
  )}`;
}

/** Render the report object → an admin-tier markdown string. */
export function renderWeekReport(report) {
  const L = [];
  L.push("---");
  L.push("access: admin");
  L.push("---");
  L.push("");
  L.push(`# Agentic maturity — week of ${report.weekOf}`);
  L.push("");
  L.push(`${report.sessionCount} sessions · ${report.taskCount} tasks`);
  L.push("");

  if (!report.sufficient) {
    const { have, need } = report.insufficient;
    L.push(
      `Insufficient data: ${have} of ${need} sessions this week — capture more before a trajectory read.`
    );
    L.push("");
    L.push("_Run again once the week has at least 5 captured sessions for this project._");
    return L.join("\n") + "\n";
  }

  L.push(`**Spine ${report.spine}${fmtDelta(report.spineDelta)}** — ${SPINE_GLOSS[report.spine]}`);
  if (report.spineDelta == null) {
    L.push("");
    L.push(
      "_No prior-week baseline yet (need ≥ 5 sessions last week too) — deltas start next week._"
    );
  }
  L.push("");

  // Axis grid.
  for (const [key, label] of Object.entries(AXIS_LABELS)) {
    const score = report.axes[key];
    const delta = report.axesDeltas ? report.axesDeltas[key] : null;
    L.push(
      `- ${label.padEnd(22)} ${bar(score)} ${score}/4${fmtDelta(delta)}  ${AXIS_GUIDE[key].gloss}`
    );
  }
  L.push("");

  // Weakest-axis coaching.
  const g = AXIS_GUIDE[report.weakest];
  L.push(`## Biggest opportunity — ${AXIS_LABELS[report.weakest]}`);
  L.push("");
  L.push(g.meaning);
  L.push("");
  L.push(`**Why:** ${g.why}`);
  L.push("");
  for (const step of g.steps) L.push(`- ${step}`);
  L.push("");

  // Next belt.
  const nb = report.nextBelt;
  if (nb && nb.target) {
    L.push(`## Next belt: ${BELTS[nb.target]} (${nb.target})`);
    L.push("");
    if (!nb.blockers.length) {
      L.push("You already clear every requirement — the next capture should tip you over.");
    } else {
      // Verification gates the whole Spine (L4+ needs it), so when the operator is
      // below the gate, lead with the verification blocker.
      let blockers = nb.blockers.slice();
      if (report.axes.verification <= VERIFICATION_GATE) {
        blockers.sort((a, b) =>
          a.axis === "verification" ? -1 : b.axis === "verification" ? 1 : 0
        );
      }
      if (nb.mode === "any") L.push("Reach **either** of:");
      for (const b of blockers) L.push(`- ${describeBlocker(b)}`);
    }
    L.push("");
  }

  // Belt line.
  const honorific = report.isNinjaMaster ? " 🥷 Ninja Master" : "";
  L.push(`**Belt: ${report.belt}**${honorific}`);
  return L.join("\n") + "\n";
}
