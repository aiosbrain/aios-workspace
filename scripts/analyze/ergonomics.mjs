/**
 * ergonomics.mjs — Phase A SHADOW scorer for the candidate 6th AEM axis:
 * Cognitive Ergonomics (AIO-190, spec §"Phase A scoring contract").
 *
 * Measures whether the operator is protecting attention — longer focus blocks,
 * fewer interrupts/context switches, concurrency matched to their own norm —
 * RELATIVE TO THE OPERATOR'S OWN BASELINE, never an absolute bar. Higher band =
 * more protected focus (the end-state thesis: maturity is the human regaining
 * deep work, not answering agents all day).
 *
 * Phase A discipline:
 *  - SHADOW ONLY. The band is recorded for the calibration corpus (Phase B
 *    decides MERGE/PROMOTE/HOLD); it is never rendered as a maturity verdict,
 *    never enters placement.axes / spineLevel / overallScore, and never syncs.
 *  - This module must NOT import from aem.mjs (hard rail — the canonical
 *    scorers stay untouched until a Phase B PROMOTE verdict).
 *  - Insufficient data is never guessed: below MIN_ACTIVE_HOURS, below
 *    MIN_BASELINE_DAYS of baseline, or with nothing timestamped, the score is
 *    null and null propagates unchanged.
 *
 * The scorer is pure: the caller computes the baseline from per-day buckets
 * (ergonomicsBaseline) and passes it in. Zero dependencies.
 */

export const AXIS_LABEL_ERGONOMICS = "Cognitive ergonomics";

/** A day counts as active (scorable + baseline-eligible) only at ≥ this many active hours. */
export const MIN_ACTIVE_HOURS = 1;

/** The baseline must cover this many trailing ACTIVE days before any band is emitted. */
export const MIN_BASELINE_DAYS = 5;

// The four attention signals the band reads (all already computed by
// metrics.mjs computeAttentionSignals; admin-tier, local-only — EE10).
const BASELINE_KEYS = [
  "focus_block_avg_min",
  "context_switch_rate",
  "interrupts_per_hour",
  "concurrent_sessions_peak",
];

// Uncalibrated Phase A band thresholds (ratios vs the operator's own baseline).
// Deliberately simple; Phase B calibrates or rejects them.
const FOCUS_UP = 1.25; //  ≥ 25% longer focus blocks than baseline → strong focus
const FOCUS_HELD = 0.9; //  within ~10% of baseline → focus held
const FRAG_DOWN = 0.8; //  ≥ 20% less switching/interruption → strong protection
const FRAG_HELD = 1.15; //  within ~15% of baseline → fragmentation held

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Trailing baseline over the last MIN_BASELINE_DAYS ACTIVE days: the median of
 * each attention signal. `days` is the per-day bucket array (each `{ signals }`)
 * in ascending date order, EXCLUDING the day being scored. Returns null while
 * fewer than MIN_BASELINE_DAYS active days exist.
 * @returns {{days:number, focus_block_avg_min:number, context_switch_rate:number,
 *   interrupts_per_hour:number, concurrent_sessions_peak:number}|null}
 */
export function ergonomicsBaseline(days) {
  const active = (days || []).filter((d) => (d?.signals?.active_hours ?? 0) >= MIN_ACTIVE_HOURS);
  if (active.length < MIN_BASELINE_DAYS) return null;
  const window = active.slice(-MIN_BASELINE_DAYS);
  const baseline = { days: window.length };
  for (const key of BASELINE_KEYS) {
    baseline[key] = median(window.map((d) => Number(d.signals[key]) || 0));
  }
  return baseline;
}

/** current/baseline ratio, defined at zero: 0/0 → 1 (unchanged), x/0 → Infinity. */
function rel(current, base) {
  if (base > 0) return current / base;
  return current > 0 ? Infinity : 1;
}

/**
 * Candidate Cognitive Ergonomics band, 0–4 integer or null (AIO-190 Phase A).
 *
 * Composite (recorded for the corpus, never a verdict):
 *  - focus component 0–2: focus_block_avg_min vs baseline (higher → higher band;
 *    monotonically non-decreasing in baseline-relative focus).
 *  - fragmentation component 0–2: the WORSE of context_switch_rate and
 *    interrupts_per_hour vs baseline (lower → higher band).
 *  - concurrency: concurrent_sessions_peak must be matched to (not exceed)
 *    baseline; exceeding it costs 1.
 *
 * Null when active_hours < MIN_ACTIVE_HOURS, when the baseline covers fewer
 * than MIN_BASELINE_DAYS days, or when nothing is timestamped (active_hours 0).
 * @returns {0|1|2|3|4|null}
 */
export function scoreCognitiveErgonomics(signals, baseline) {
  if (!signals || !baseline) return null;
  const activeHours = Number(signals.active_hours) || 0;
  if (activeHours < MIN_ACTIVE_HOURS) return null;
  if ((Number(baseline.days) || 0) < MIN_BASELINE_DAYS) return null;

  const focusRel = rel(Number(signals.focus_block_avg_min) || 0, baseline.focus_block_avg_min);
  const fragRel = Math.max(
    rel(Number(signals.context_switch_rate) || 0, baseline.context_switch_rate),
    rel(Number(signals.interrupts_per_hour) || 0, baseline.interrupts_per_hour)
  );

  let band = 0;
  if (focusRel >= FOCUS_UP) band += 2;
  else if (focusRel >= FOCUS_HELD) band += 1;
  if (fragRel <= FRAG_DOWN) band += 2;
  else if (fragRel <= FRAG_HELD) band += 1;
  if ((Number(signals.concurrent_sessions_peak) || 0) > baseline.concurrent_sessions_peak) {
    band -= 1;
  }
  return Math.max(0, Math.min(4, band));
}
