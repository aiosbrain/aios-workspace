#!/usr/bin/env node
// test/ergonomics.test.mjs — AIO-190 Phase A: the Cognitive Ergonomics SHADOW
// scorer. Asserts the spec's acceptance: the two null cases (below
// MIN_ACTIVE_HOURS; baseline thinner than MIN_BASELINE_DAYS), the candidate
// band is non-decreasing as baseline-relative focus rises, the shadow never
// leaks into placement.axes, and scripts/analyze/aem.mjs exports are unchanged.
// Synthetic fixtures only. Zero network, zero deps. Run: node test/ergonomics.test.mjs

import { readFileSync } from "node:fs";

import {
  scoreCognitiveErgonomics,
  ergonomicsBaseline,
  MIN_ACTIVE_HOURS,
  MIN_BASELINE_DAYS,
  AXIS_LABEL_ERGONOMICS,
} from "../scripts/analyze/ergonomics.mjs";
import * as aem from "../scripts/analyze/aem.mjs";
import { toJson, buildPushPayload } from "../scripts/analyze/report.mjs";

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

/** Attention-signal shape as emitted by metrics.mjs computeAttentionSignals. */
function signals(o = {}) {
  return {
    active_hours: 6,
    focus_block_avg_min: 30,
    context_switch_rate: 10,
    interrupts_per_hour: 12,
    concurrent_sessions_peak: 6,
    ...o,
  };
}

function day(date, o = {}) {
  return { date, signals: signals(o) };
}

/** MIN_BASELINE_DAYS identical active days → baseline medians equal signals(). */
function steadyDays(n = MIN_BASELINE_DAYS) {
  return Array.from({ length: n }, (_, i) => day(`2026-06-${String(11 + i).padStart(2, "0")}`));
}

const BASELINE = ergonomicsBaseline(steadyDays());

// ── ergonomicsBaseline ──────────────────────────────────────────────────────

console.log("ergonomicsBaseline");
check(
  "returns null below MIN_BASELINE_DAYS active days",
  ergonomicsBaseline(steadyDays(MIN_BASELINE_DAYS - 1)) === null
);
check(
  "inactive days (active_hours < MIN_ACTIVE_HOURS) don't count toward the baseline",
  ergonomicsBaseline([
    ...steadyDays(MIN_BASELINE_DAYS - 1),
    day("2026-06-20", { active_hours: MIN_ACTIVE_HOURS - 0.1 }),
  ]) === null
);
check(
  "covers exactly MIN_BASELINE_DAYS at the threshold",
  BASELINE !== null && BASELINE.days === MIN_BASELINE_DAYS
);
check(
  "baseline is the trailing median of each attention signal",
  BASELINE.focus_block_avg_min === 30 &&
    BASELINE.context_switch_rate === 10 &&
    BASELINE.interrupts_per_hour === 12 &&
    BASELINE.concurrent_sessions_peak === 6
);
check(
  "trailing window: only the last MIN_BASELINE_DAYS active days feed the median",
  ergonomicsBaseline([day("2026-06-01", { focus_block_avg_min: 999 }), ...steadyDays()])
    .focus_block_avg_min === 30
);

// ── null discipline (the two spec null cases) ───────────────────────────────

console.log("scoreCognitiveErgonomics — null discipline");
check(
  "null when active_hours < MIN_ACTIVE_HOURS",
  scoreCognitiveErgonomics(signals({ active_hours: MIN_ACTIVE_HOURS - 0.01 }), BASELINE) === null
);
check(
  "null when nothing is timestamped (all attention signals zero)",
  scoreCognitiveErgonomics(
    signals({
      active_hours: 0,
      focus_block_avg_min: 0,
      context_switch_rate: 0,
      interrupts_per_hour: 0,
      concurrent_sessions_peak: 0,
    }),
    BASELINE
  ) === null
);
check(
  "null when the baseline is null (fewer than MIN_BASELINE_DAYS)",
  scoreCognitiveErgonomics(signals(), null) === null
);
check(
  "null when the baseline object covers too few days",
  scoreCognitiveErgonomics(signals(), { ...BASELINE, days: MIN_BASELINE_DAYS - 1 }) === null
);
check(
  "scores (non-null) at exactly MIN_ACTIVE_HOURS with a full baseline",
  scoreCognitiveErgonomics(signals({ active_hours: MIN_ACTIVE_HOURS }), BASELINE) !== null
);

// ── band shape + monotonicity ───────────────────────────────────────────────

console.log("scoreCognitiveErgonomics — band");
{
  let allValid = true;
  let prev = -1;
  let monotonic = true;
  // Sweep baseline-relative focus from collapsed (0.1×) to protected (3×),
  // everything else held at baseline: the band must never decrease.
  for (let f = 0.1; f <= 3.0001; f += 0.05) {
    const b = scoreCognitiveErgonomics(
      signals({ focus_block_avg_min: BASELINE.focus_block_avg_min * f }),
      BASELINE
    );
    if (!(Number.isInteger(b) && b >= 0 && b <= 4)) allValid = false;
    if (b < prev) monotonic = false;
    prev = b;
  }
  check("band is always an integer 0–4", allValid);
  check("band is non-decreasing as baseline-relative focus rises", monotonic);
  check(
    "the sweep actually moves the band (higher focus → strictly higher somewhere)",
    scoreCognitiveErgonomics(
      signals({ focus_block_avg_min: BASELINE.focus_block_avg_min * 3 }),
      BASELINE
    ) >
      scoreCognitiveErgonomics(
        signals({ focus_block_avg_min: BASELINE.focus_block_avg_min * 0.1 }),
        BASELINE
      )
  );
}
check(
  "fully protected day (focus up, fragmentation down, concurrency matched) hits 4",
  scoreCognitiveErgonomics(
    signals({
      focus_block_avg_min: 60,
      context_switch_rate: 4,
      interrupts_per_hour: 5,
      concurrent_sessions_peak: 6,
    }),
    BASELINE
  ) === 4
);
check(
  "fragmented day (focus collapsed, switching up) hits 0",
  scoreCognitiveErgonomics(
    signals({ focus_block_avg_min: 5, context_switch_rate: 25, interrupts_per_hour: 30 }),
    BASELINE
  ) === 0
);
check(
  "exceeding baseline concurrency lowers the band (matched does not)",
  scoreCognitiveErgonomics(signals({ concurrent_sessions_peak: 9 }), BASELINE) <
    scoreCognitiveErgonomics(signals({ concurrent_sessions_peak: 6 }), BASELINE)
);
check("AXIS_LABEL_ERGONOMICS is exported", AXIS_LABEL_ERGONOMICS === "Cognitive ergonomics");

// ── hard rails: aem.mjs untouched, no aem import, no leak into placement ────

console.log("hard rails");
const FIVE_AXES = ["verification", "context_hygiene", "autonomy", "learning", "cost_governance"];
check(
  "aem.mjs exports unchanged: scoreAxes/spineLevel/AXIS_LABELS as before",
  typeof aem.scoreAxes === "function" &&
    typeof aem.spineLevel === "function" &&
    typeof aem.placement === "function" &&
    typeof aem.overallScore === "function" &&
    JSON.stringify(Object.keys(aem.AXIS_LABELS)) === JSON.stringify(FIVE_AXES)
);
{
  const sample = signals({
    verify_tool_rate: 0.2,
    cache_hit_rate: 0.6,
    delegation_ratio: 0.15,
    subagent_usage: 0.4,
    permission_events: 1,
    tool_diversity: 4,
    tokens_per_task: 50_000,
  });
  const axes = aem.scoreAxes(sample);
  check(
    "scoreAxes still returns exactly the five canonical axes",
    JSON.stringify(Object.keys(axes)) === JSON.stringify(FIVE_AXES)
  );
  check(
    "placement carries no shadow axis",
    !("cognitive_ergonomics" in aem.placement(sample).axes)
  );
}
check(
  "ergonomics.mjs does not import from aem.mjs (Phase A rail)",
  !/(import|from)\s*\(?\s*["'][^"']*aem\.mjs["']/.test(
    readFileSync(new URL("../scripts/analyze/ergonomics.mjs", import.meta.url), "utf8")
  )
);

// ── toJson wiring: axes_shadow beside placement, never inside it ────────────

console.log("toJson wiring");
{
  const days = [
    ...steadyDays(MIN_BASELINE_DAYS),
    day("2026-06-16", { focus_block_avg_min: 60, context_switch_rate: 4, interrupts_per_hour: 5 }),
  ].map((d) => ({ ...d, placement: aem.placement(d.signals) }));
  const result = {
    window: { since: "2026-06-11", until: "2026-06-16" },
    tools: ["claude"],
    totals: { sessions: 1, tasks: 1, events: 1, total_tokens: 1 },
    signals: days[days.length - 1].signals,
    placement: aem.placement(days[days.length - 1].signals),
    days,
  };
  const out = toJson(result);
  check(
    "days[].axes_shadow.cognitive_ergonomics exists on every day",
    out.days.every((d) => d.axes_shadow && "cognitive_ergonomics" in d.axes_shadow)
  );
  check(
    "early days (baseline still thin) are null; a post-baseline day scores",
    out.days[0].axes_shadow.cognitive_ergonomics === null &&
      Number.isInteger(out.days[out.days.length - 1].axes_shadow.cognitive_ergonomics)
  );
  check(
    "rolled-up top-level axes_shadow.cognitive_ergonomics exists",
    out.axes_shadow && "cognitive_ergonomics" in out.axes_shadow
  );
  check(
    "axes_shadow never rides inside placement.axes (top level or per-day)",
    !("cognitive_ergonomics" in out.placement.axes) &&
      out.days.every((d) => !("cognitive_ergonomics" in d.placement.axes))
  );
  check(
    "per-day placement objects pass through toJson untouched",
    out.days.every((d, i) => d.placement === days[i].placement)
  );
  const payload = buildPushPayload({ ...days[days.length - 1], date: "2026-06-16" }, "alex");
  check(
    "buildPushPayload still excludes the shadow band and raw attention signals (EE10)",
    !JSON.stringify(payload).includes("cognitive_ergonomics") &&
      !("focus_block_avg_min" in payload.signals) &&
      !("active_hours" in payload.signals)
  );
}

console.log("");
if (failed) {
  console.log(`${RED}${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`${GREEN}all ergonomics checks passed${NC}`);
