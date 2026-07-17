#!/usr/bin/env node
// test/analyze-render.test.mjs — AIO-213: the text report renders the Cognitive
// Ergonomics SHADOW band beside the five AM axes, a 14-day AM-vs-CE dual
// sparkline, and one CE coaching tip — WITHOUT turning CE into a maturity axis
// and WITHOUT changing the JSON contract. Asserts: CE line + "shadow" marker,
// the null-baseline copy, sparkline glyph-per-day alignment, exactly five axis
// bars (CE excluded), the frozen toJson key order, ergonomicsTip's readings,
// and text↔JSON band agreement.
// Synthetic fixtures only. Zero network, zero deps. Run: node test/analyze-render.test.mjs

import { renderText, toJson, buildPushPayload } from "../scripts/analyze/report.mjs";
import { ergonomicsTip } from "../scripts/analyze/guidance.mjs";
import { AXIS_LABELS, placement, contextHealthCard } from "../scripts/analyze/aem.mjs";
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

// ── Context health card (SHADOW, NOT an axis) ───────────────────────────────

console.log("contextHealthCard");
const FAKE_CH = {
  mode: "workspace",
  checks: [
    { id: "toolkit-staleness", label: "toolkit staleness", kind: "soft", ok: false, value: 3 },
    { id: "tier-coverage", label: "tier coverage", kind: "soft", ok: true, value: 92 },
    {
      id: "broken-links",
      label: "broken links",
      kind: "hard",
      ok: false,
      value: 2,
      detail: "docs/foo.md -> missing",
    },
  ],
  hardFailures: 1,
  softMisses: 1,
  score: 2,
  summary: "a few things need attention",
};
check("contextHealthCard returns null for a null result", contextHealthCard(null) === null);
check(
  "contextHealthCard shapes a non-null result",
  (() => {
    const card = contextHealthCard(FAKE_CH);
    return (
      card.label === "Context health" &&
      card.metrics.score === 2 &&
      card.metrics.mode === "workspace" &&
      card.metrics.hard_failures === 1 &&
      card.metrics.soft_misses === 1 &&
      card.reading === "a few things need attention"
    );
  })()
);

console.log("renderText — Context health card");
const chLines = renderText(RICH, null, FAKE_CH).split("\n");
check(
  "a Context health line renders when a result is provided",
  chLines.some((l) => l.startsWith("  Context health — "))
);
check(
  "up to 3 failing check labels are listed",
  chLines.some((l) => l.includes("toolkit staleness") && l.includes("broken links"))
);
check(
  "no Context health line renders when the result is null (module absent/threw)",
  !renderText(RICH, null, null)
    .split("\n")
    .some((l) => l.startsWith("  Context health — "))
);

console.log("toJson — context_health key");
check(
  "context_health is present when a result is provided",
  toJson(RICH, undefined, FAKE_CH).context_health?.metrics.score === 2
);
check(
  "context_health is absent when the result is null",
  !("context_health" in toJson(RICH, undefined, null))
);
check(
  "context_health is absent when not passed at all (back-compat 2-arg call)",
  !("context_health" in toJson(RICH))
);

console.log("buildPushPayload — context_health (scalars only)");
const pushDay = RICH.days[RICH.days.length - 1];
const pushedWith = buildPushPayload(pushDay, "alex", 3, FAKE_CH);
const pushedWithout = buildPushPayload(pushDay, "alex", 3);
check(
  "context_health is present and scalar-only when contextHealth is passed",
  pushedWith.context_health &&
    pushedWith.context_health.score === 2 &&
    pushedWith.context_health.mode === "workspace" &&
    pushedWith.context_health.drift_count === 1 &&
    pushedWith.context_health.versions_behind === 3 &&
    pushedWith.context_health.coverage_pct === 92 &&
    pushedWith.context_health.broken_link_count === 2 &&
    /^\d{4}-\d{2}-\d{2}$/.test(pushedWith.context_health.checked_at) &&
    Object.values(pushedWith.context_health).every((v) => v === null || typeof v !== "object")
);
check(
  "context_health is absent when contextHealth is omitted",
  !("context_health" in pushedWithout)
);
check(
  "context_health is absent when contextHealth is explicitly null",
  !("context_health" in buildPushPayload(pushDay, "alex", 3, null))
);
check(
  "coverage_pct falls back to claude-coverage in repo mode",
  buildPushPayload(pushDay, "alex", 3, {
    mode: "repo",
    checks: [
      { id: "claude-coverage", label: "claude coverage", kind: "soft", ok: true, value: 55 },
    ],
    hardFailures: 0,
    softMisses: 0,
    score: 4,
    summary: "healthy",
  }).context_health.coverage_pct === 55
);
check(
  "versions_behind is null in repo mode (no toolkit-staleness check)",
  buildPushPayload(pushDay, "alex", 3, {
    mode: "repo",
    checks: [],
    hardFailures: 0,
    softMisses: 0,
    score: 4,
    summary: "healthy",
  }).context_health.versions_behind === null
);
check(
  "broken_link_count defaults to 0 when the broken-links check is absent",
  buildPushPayload(pushDay, "alex", 3, {
    mode: "workspace",
    checks: [],
    hardFailures: 0,
    softMisses: 0,
    score: 4,
    summary: "healthy",
  }).context_health.broken_link_count === 0
);

console.log("");
if (failed) {
  console.log(`${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`${GREEN}all analyze-render checks passed${NC}`);
