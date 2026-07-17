/**
 * maturity.mjs — pure reshaper for the cockpit Maturity panel.
 *
 * `buildMaturityPayload(stdout)` parses the JSON emitted by `aios analyze --json`
 * (see scripts/analyze/report.mjs `toJson`) and flattens it into the friendly
 * `MaturityResponse` contract the client renders. It lives in its own module (not
 * in index.mjs, which self-boots an http server on import) so it can be unit-tested
 * without side effects — mirroring the sessions-search.mjs / .test.mjs pattern.
 *
 * Cognitive Ergonomics stays SHADOW / local-only here: it is surfaced as `ce_band`
 * for display only and never enters placement, never syncs (AIO-190 Phase A).
 *
 * Zero runtime dependencies beyond the two analyze modules it reshapes from.
 */

import { AXIS_GUIDE, ergonomicsTip } from "../../scripts/analyze/guidance.mjs";
import { AXIS_LABELS } from "../../scripts/analyze/aem.mjs";

// The shared analysis cache runs `aios analyze --since 35d` (the cost panel needs the
// whole calendar month), but the Maturity panel promises a "30-day trend" and must
// match the CLI's `aios analyze --since 30d`. Keep only the trailing 30 days here.
export const TREND_DAYS = 30;

/**
 * @param {string} stdout - raw stdout of `aios analyze --json`
 * @param {{AXIS_GUIDE?: object, AXIS_LABELS?: object, ergonomicsTip?: Function}} [deps]
 *   - test seam. `ergonomicsTip` may be omitted (the W2-absent case) → no CE tip.
 * @returns {object} the MaturityResponse payload
 */
export function buildMaturityPayload(stdout, deps = {}) {
  const guide = deps.AXIS_GUIDE ?? AXIS_GUIDE;
  const labels = deps.AXIS_LABELS ?? AXIS_LABELS;
  // Resolve via `in` so an explicit `{ ergonomicsTip: undefined }` disables the tip.
  const tip = "ergonomicsTip" in deps ? deps.ergonomicsTip : ergonomicsTip;

  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("maturity: analyze --json produced unparseable output");
  }

  const placement = data.placement ?? null;
  const axesScores = placement?.axes ?? {};
  const axes = Object.keys(axesScores).map((key) => ({
    key,
    label: labels[key] ?? key,
    score: axesScores[key] ?? 0,
    gloss: guide[key]?.gloss ?? "",
  }));

  const weakest = placement?.weakest ?? null;
  const days = Array.isArray(data.days)
    ? data.days.slice(-TREND_DAYS).map((d) => ({
        date: d.date,
        am: d.placement?.overall ?? null,
        ce: d.axes_shadow?.cognitive_ergonomics ?? null,
      }))
    : [];

  return {
    window: data.window ?? null,
    spine: placement?.spine ?? null,
    overall: placement?.overall ?? null,
    weakest,
    axes,
    ce_band: data.axes_shadow?.cognitive_ergonomics ?? null,
    days,
    guidance: {
      weakest: weakest ? (guide[weakest] ?? null) : null,
      ergonomics_tip: typeof tip === "function" ? tip(data.attention?.reading ?? "") : "",
    },
  };
}
