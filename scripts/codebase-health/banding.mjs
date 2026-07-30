/**
 * banding.mjs — pure rubric-data → band/score/status math for the codebase-health
 * scorer (AIO-605). NO thresholds live here: every number comes from
 * validation/codebase-health.rubric.json (the thresholds-in-data invariant, proven
 * by a unit test that perturbs a fixture rubric copy and watches the band move
 * with zero code change).
 *
 * Zero dependencies.
 */

/**
 * Band (0–4) for a metric value against rubric thresholds.
 * `thresholds` = [t4, t3, t2, t1]; direction "lowerIsBetter" uses <=, "higherIsBetter" uses >=.
 * A value clearing t4 scores 4, else t3 → 3, … else 0. Null value → null band.
 */
export function bandForValue(value, direction, thresholds) {
  if (value === null || value === undefined || !Array.isArray(thresholds)) return null;
  const cmp = direction === "higherIsBetter" ? (v, t) => v >= t : (v, t) => v <= t;
  for (let i = 0; i < thresholds.length; i++) {
    if (cmp(value, thresholds[i])) return 4 - i;
  }
  return 0;
}

/**
 * Band for one axis from its evaluated checks.
 * - No check of the axis produced a value (all skipped) → null (axis not scored).
 * - A metric-driven axis (bandMetric set) whose metric is skipped → null too: a
 *   missing input makes the axis unscored, never guessed (a cheap-mode run must
 *   not read differently from a full run purely because an input was skipped).
 * - bandMetric present + non-null → bandForValue, then capped at rubric.gateFailCap
 *   when any of the axis's gate checks failed.
 * - Metric-LESS axes (bandMetric null, e.g. a pure-gate axis) use
 *   rubric.fallbackBands.allOk / .anyFail over the non-null checks.
 * @param {object} axis   rubric axis entry
 * @param {object} rubric full rubric (gateFailCap, fallbackBands)
 * @param {Array<{id:string, ok:boolean, value:*}>} axisChecks evaluated checks for this axis
 */
export function axisBand(axis, rubric, axisChecks) {
  const live = axisChecks.filter((c) => c.value !== null && c.value !== undefined);
  if (live.length === 0) return null;
  const gateFailed = (axis.gates || []).some((id) =>
    live.some((c) => c.id === id && c.ok === false)
  );
  let band;
  if (axis.bandMetric) {
    const metric = axisChecks.find((c) => c.id === axis.bandMetric);
    if (!metric || metric.value === null || metric.value === undefined) {
      // Exception: a failed gate is still a real reading even without the metric.
      return gateFailed ? rubric.gateFailCap : null;
    }
    band = bandForValue(metric.value, axis.direction, axis.bandThresholds);
  } else {
    const allOk = live.every((c) => c.ok !== false);
    band = allOk ? rubric.fallbackBands.allOk : rubric.fallbackBands.anyFail;
  }
  if (gateFailed) band = Math.min(band, rubric.gateFailCap);
  return band;
}

/** Weighted 0–100 score over the non-null axis bands; null when every axis skipped. */
export function scorePct(axes, rubric) {
  let num = 0;
  let den = 0;
  for (const axis of rubric.axes) {
    const band = axes[axis.key]?.band;
    if (band === null || band === undefined) continue;
    num += (axis.weight ?? 1) * (band / 4);
    den += axis.weight ?? 1;
  }
  return den > 0 ? Math.round((num / den) * 100) : null;
}

/** healthy | degraded | critical from rubric.statusCutpoints; null score → "critical". */
export function statusFor(score, rubric) {
  const cuts = rubric.statusCutpoints;
  if (score === null || score === undefined) return "critical";
  if (score >= cuts.healthy) return "healthy";
  if (score >= cuts.degraded) return "degraded";
  return "critical";
}

// Ordered improvement targets — the aem.mjs TARGET_REQS analogue, but derived from
// rubric DATA (bandThresholds) rather than a parallel hand-written table, so it can
// never drift from what axisBand() actually rewards. The anti-drift test bumps each
// reported blocker's metric to its neededValue and asserts the axis band advances.
export const TARGETS = ["degraded", "healthy"];

/**
 * The metric moves that would advance each non-null axis to its NEXT band.
 * @param {Record<string, {band:?number}>} axes  per-axis {band}
 * @param {Array<{id:string, ok:boolean, value:*}>} checks all evaluated checks
 * @param {object} rubric
 * @returns {Array<{axis:string, metric:string, current:number, currentBand:number,
 *   neededBand:number, neededValue:number}>}
 */
export function nextTargetBlockers(axes, checks, rubric) {
  const blockers = [];
  for (const axis of rubric.axes) {
    const band = axes[axis.key]?.band;
    if (band === null || band === undefined || band >= 4) continue;
    if (!axis.bandMetric || !Array.isArray(axis.bandThresholds)) continue;
    const metric = checks.find((c) => c.id === axis.bandMetric);
    if (!metric || metric.value === null || metric.value === undefined) continue;
    // Gate-capped axes advance by fixing the gate, not by moving the metric.
    const gateFailed = (axis.gates || []).some((id) =>
      checks.some((c) => c.id === id && c.value !== null && c.ok === false)
    );
    if (gateFailed) continue;
    const neededBand = band + 1;
    // thresholds = [t4, t3, t2, t1]; the edge for band b (1–4) sits at index 4 - b.
    const neededValue = axis.bandThresholds[4 - neededBand];
    if (neededValue === undefined) continue;
    blockers.push({
      axis: axis.key,
      metric: axis.bandMetric,
      current: metric.value,
      currentBand: band,
      neededBand,
      neededValue,
    });
  }
  return blockers;
}
