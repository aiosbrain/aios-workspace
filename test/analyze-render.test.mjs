#!/usr/bin/env node
// test/analyze-render.test.mjs — AIO-213: the text report renders the Cognitive
// Ergonomics SHADOW band beside the five AM axes, a 14-day AM-vs-CE dual
// sparkline, and one CE coaching tip — WITHOUT turning CE into a maturity axis
// and WITHOUT changing the JSON contract. Asserts: CE line + "shadow" marker,
// the null-baseline copy, sparkline glyph-per-day alignment, exactly five axis
// bars (CE excluded), the frozen toJson key order, ergonomicsTip's readings,
// and text↔JSON band agreement.
// Synthetic fixtures only. Zero network, zero deps. Run: node test/analyze-render.test.mjs

import { renderText, toJson } from "../scripts/analyze/report.mjs";
import { ergonomicsTip } from "../scripts/analyze/guidance.mjs";
import { AXIS_LABELS, placement } from "../scripts/analyze/aem.mjs";
import { AXIS_LABEL_ERGONOMICS, MIN_BASELINE_DAYS } from "../scripts/analyze/ergonomics.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// ── fixtures ────────────────────────────────────────────────────────────────

/** Full signals shape: attention signals + the AEM-axis fields the render reads. */
function signals(o = {}) {
  return {
    active_hours: 6,
    focus_block_avg_min: 30,
    context_switch_rate: 10,
    interrupts_per_hour: 12,
    concurrent_sessions_peak: 6,
    verify_tool_rate: 0.2,
    cache_hit_rate: 0.6,
    delegation_ratio: 0.15,
    subagent_usage: 0.4,
    permission_events: 1,
    tool_diversity: 4,
    cost_per_task: 1.5,
    tokens_per_task: 50_000,
    ...o,
  };
}

function day(date, o = {}) {
  const sig = signals(o);
  return { date, signals: sig, placement: placement(sig) };
}

/** n identical active days → a stable baseline; the first MIN_BASELINE_DAYS
 *  per-day bands are null (baseline still thin), the rest score. */
function steadyDays(n) {
  return Array.from({ length: n }, (_, i) => day(`2026-06-${String(11 + i).padStart(2, "0")}`));
}

function resultFrom(days) {
  const last = days[days.length - 1];
  return {
    window: { since: days[0].date, until: last.date },
    tools: ["claude"],
    totals: { sessions: 1, tasks: 1, events: 1, total_tokens: 1 },
    signals: last.signals,
    placement: last.placement,
    days,
  };
}

const RICH = resultFrom(steadyDays(MIN_BASELINE_DAYS + 2)); // 7 days → non-null rollup, nulls days 0–4
const SPARSE = resultFrom(steadyDays(3)); // 3 days → baseline never forms → null rollup

// ── the CE line + shadow marker ─────────────────────────────────────────────

console.log("renderText — Cognitive Ergonomics line");
const richLines = renderText(RICH).split("\n");
const ceLine = richLines.find((l) => l.startsWith(`  ${AXIS_LABEL_ERGONOMICS.padEnd(22)} `));
check("a Cognitive ergonomics line is rendered", Boolean(ceLine));
check(
  "the CE line marks itself SHADOW (never a maturity axis)",
  !!ceLine && ceLine.includes("shadow")
);

check(
  "sparse window (no baseline yet) renders the null-baseline copy, still shadow-marked",
  (() => {
    const line = renderText(SPARSE)
      .split("\n")
      .find((l) => l.startsWith(`  ${AXIS_LABEL_ERGONOMICS.padEnd(22)} `));
    return !!line && line.includes("shadow") && line.includes("needs 5 active days");
  })()
);

// ── exactly five AM axis bars, CE NOT among them ────────────────────────────

console.log("renderText — CE is beside the axes, not one of them");
const axisLabels = Object.values(AXIS_LABELS);
const axisBarLines = richLines.filter((l) =>
  axisLabels.some((lbl) => l.startsWith(`  ${lbl.padEnd(22)} `))
);
check("exactly five AM axis bars render", axisBarLines.length === 5);
check(
  "CE is not one of the five canonical axis labels",
  !axisLabels.includes(AXIS_LABEL_ERGONOMICS)
);

// ── the dual sparkline: one glyph per day, aligned rows, no-data dots ────────

console.log("renderText — 14-day dual sparkline");
const amRow = richLines.find((l) => l.startsWith("    AM  "));
const ceRow = richLines.find((l) => l.startsWith("    CE  "));
const amGlyphs = amRow ? [...amRow.slice("    AM  ".length)] : [];
const ceGlyphs = ceRow ? [...ceRow.slice("    CE  ".length)] : [];
check("both sparkline rows render", Boolean(amRow) && Boolean(ceRow));
check("CE sparkline has exactly one glyph per day", ceGlyphs.length === RICH.days.length);
check("AM and CE rows are the same width (columns line up)", amGlyphs.length === ceGlyphs.length);
check(
  "days with no CE baseline show the no-data dot",
  ceGlyphs.slice(0, MIN_BASELINE_DAYS).every((g) => g === "·") &&
    ceGlyphs.slice(MIN_BASELINE_DAYS).every((g) => g !== "·")
);
check(
  "the sparkline is skipped for a single-day window (< 2 days)",
  !renderText(resultFrom(steadyDays(1)))
    .split("\n")
    .some((l) => l.startsWith("    CE  "))
);

// ── JSON contract unchanged (render layer only) ─────────────────────────────

console.log("toJson — key order frozen (no contract drift)");
const FROZEN_KEYS = [
  "window",
  "tools",
  "totals",
  "signals",
  "placement",
  "axes_shadow",
  "attention",
  "days",
];
check(
  "toJson top-level keys are exactly the frozen set, in order",
  JSON.stringify(Object.keys(toJson(RICH))) === JSON.stringify(FROZEN_KEYS)
);

// ── text band agrees with the JSON shadow band (acceptance criterion) ───────

console.log("text CE band == JSON axes_shadow.cognitive_ergonomics");
const jsonBand = toJson(RICH).axes_shadow.cognitive_ergonomics;
const textBand = ceLine && ceLine.match(/(\d+)\/4/);
check(
  "the CE line prints the same band the JSON records",
  Number.isInteger(jsonBand) && !!textBand && Number(textBand[1]) === jsonBand
);

// ── ergonomicsTip: prefix-matched, empty for no-activity/unknown ────────────

console.log("ergonomicsTip");
const REAL_READINGS = [
  "orchestration-heavy — protect focus blocks",
  "deep-work leaning — long focus blocks, low switching",
  "mixed — some focus, some context-switching",
];
const SHORTHAND = ["orchestration-heavy", "deep-work", "mixed"];
check(
  "returns a non-empty tip for every live attention reading",
  REAL_READINGS.every((r) => ergonomicsTip(r).length > 0)
);
check(
  "prefix-matches shorthand reading keys too",
  SHORTHAND.every((r) => ergonomicsTip(r).length > 0)
);
check(
  "returns empty (line omitted) for no-activity / unknown / falsy readings",
  ergonomicsTip("no timestamped activity in window") === "" &&
    ergonomicsTip("none") === "" &&
    ergonomicsTip("") === "" &&
    ergonomicsTip(undefined) === ""
);

console.log("");
if (failed) {
  console.log(`${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`${GREEN}all analyze-render checks passed${NC}`);
