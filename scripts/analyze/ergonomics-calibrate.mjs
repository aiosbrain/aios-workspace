/**
 * ergonomics-calibrate.mjs — AIO-216 W5 Phase B: the statistical test that
 * decides the fate of the Cognitive Ergonomics (CE) SHADOW band.
 *
 * AIO-190 Phase A records a per-day CE band for a calibration corpus but never
 * enters it into placement.axes, never renders it as a verdict, and never syncs
 * it. Phase B (this module) reads those shadow bands (via the `shadowBands`
 * helper in report.mjs) and the already-computed daily autonomy axis, computes a
 * tie-corrected Spearman rank correlation between them, and emits a deterministic
 * verdict — MERGE (band duplicates autonomy), PROMOTE (band is independent AND
 * predicts outcome quality), or HOLD (inconclusive / not enough data).
 *
 * ANALYSIS-ONLY. This module changes no shipped scoring:
 *  - It does NOT import ./aem.mjs directly (hard rail carried from AIO-190). It
 *    reads autonomy/verification only from the already-computed
 *    result.days[i].placement.axes.*. A transitive load of aem via report.mjs
 *    (imported here for shadowBands) is acceptable; a direct import is not.
 *  - The --calibrate CLI branch is read-only: it never touches gatherCostData or
 *    saveAnalyzeState, and never emits a toJson body.
 *
 * Zero dependencies (Node >= 18). All statistics are pure, offline, and hand
 * implemented so the harness stays dependency-free.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { shadowBands } from "./report.mjs";

// ── Verdict constants (the rubric mirrors these; the drift test asserts ===) ──

/** |rho| >= this → MERGE (band is redundant with autonomy). */
export const MERGE_RHO = 0.7;
/** |rho| < this → PROMOTE candidate, gated on a significant point-biserial. */
export const PROMOTE_RHO = 0.5;
/** point-biserial significant when p < this. */
export const SIG_P = 0.05;
/** fewer than this many paired non-null days → NOT_ENOUGH_DATA (no rho printed). */
export const MIN_PAIRED_DAYS = 14;
/**
 * The outcome-quality series the PROMOTE point-biserial correlates the band
 * against. `axes.verification` is the maximally autonomy-independent single axis:
 * since the Spearman gate already tests band-vs-autonomy, an outcome that
 * re-embeds autonomy (like `overall`, the mean of all five axes) would weaken the
 * independence claim for a candidate NEW axis. Resolved via `outcomeValue()`.
 */
export const OUTCOME_METRIC = "axes.verification";

// ── Pure statistics ─────────────────────────────────────────────────────────

/**
 * Fractional ranks with tie averaging: tied values share the mean of the ranks
 * they span. Required because CE bands and autonomy are discrete 0–4 → ties are
 * pervasive, and the naive 1 − 6Σd²/(n(n²−1)) Spearman formula is invalid under
 * ties. Ranks are 1-based. Returns a new array aligned to `values`.
 */
export function averageRanks(values) {
  const n = values.length;
  const idx = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    // positions i..j (0-based) are tied → shared rank = mean of (i+1 .. j+1)
    const shared = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k++) ranks[idx[k]] = shared;
    i = j + 1;
  }
  return ranks;
}

/** Pearson correlation of two equal-length series. Returns null on n<2 or zero variance. */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  let sx = 0,
    sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n,
    my = sy / n;
  let sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx,
      dy = ys[i] - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  if (sxx === 0 || syy === 0) return null; // constant series → correlation undefined
  const r = sxy / Math.sqrt(sxx * syy);
  // Guard against tiny FP drift outside [-1, 1].
  return Math.max(-1, Math.min(1, r));
}

/**
 * Tie-correct Spearman rank correlation: the Pearson correlation of the
 * average-ranks of xs and ys. Returns null when n<2 or either ranked series has
 * zero variance (a constant series → correlation undefined). Never NaN.
 */
export function spearmanRho(xs, ys) {
  const n = xs.length;
  if (n < 2 || ys.length !== n) return null;
  return pearson(averageRanks(xs), averageRanks(ys));
}

// log Γ(x) — Lanczos approximation (Numerical Recipes gammln).
function gammaln(x) {
  const cof = [
    76.18009172947146, -86.50532032941678, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log((2.5066282746310002 * ser) / x); // √(2π)
}

// Continued fraction for the incomplete beta function (Numerical Recipes betacf).
function betacf(a, b, x) {
  const MAXIT = 200;
  const EPS = 3e-12;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

// Regularized incomplete beta I_x(a, b) (Numerical Recipes betai).
function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(
    gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x)
  );
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/**
 * Two-tailed p-value for a Student-t statistic with df degrees of freedom:
 * p = I_{df/(df+t²)}(df/2, 1/2). Returns null when df < 1 or t is non-finite.
 * Never NaN.
 */
export function studentTwoTailedP(t, df) {
  if (!Number.isFinite(t) || df < 1) return null;
  return betai(0.5 * df, 0.5, df / (df + t * t));
}

/**
 * Point-biserial correlation of a binary column against an outcome series, plus
 * its two-tailed significance. `binary` is `band > 0 ? 1 : 0` per paired day;
 * `ys` is the outcome metric. Computed as Pearson(binary, ys) — the point-biserial
 * is just the Pearson of a 0/1 variable — with t = r·sqrt((n−2)/(1−r²)),
 * df = n−2, p = studentTwoTailedP(t, df).
 *
 * Returns { r: null, p: null, n } (never NaN) when the test cannot be run: n<3,
 * either column has zero variance (all-zero / all-positive bands, or a constant
 * outcome → Pearson undefined), or |r| === 1 (t is undefined).
 */
export function pointBiserial(binary, ys) {
  const n = binary.length;
  if (n < 3 || ys.length !== n) return { r: null, p: null, n };
  const r = pearson(binary, ys);
  if (r === null || Math.abs(r) === 1) return { r: null, p: null, n };
  const df = n - 2;
  const t = r * Math.sqrt(df / (1 - r * r));
  const p = studentTwoTailedP(t, df);
  return { r, p, n };
}

// ── Metric resolution + pairing ─────────────────────────────────────────────

/**
 * Resolve the configured OUTCOME_METRIC path against a placement object.
 * Supports "axes.verification" and "overall". Returns null when the placement or
 * the path is missing. Exported for tests.
 */
export function outcomeValue(placement) {
  if (!placement) return null;
  if (OUTCOME_METRIC === "overall") return placement.overall ?? null;
  if (OUTCOME_METRIC === "axes.verification") return placement.axes?.verification ?? null;
  return null;
}

/**
 * Build the paired analysis set from analyze `days`. Computes shadowBands once,
 * then keeps only rows where BOTH band and autonomy are non-null (the Spearman
 * pair set). Each row also carries the outcome metric (may be null — the
 * point-biserial uses only the outcome-non-null subset of these rows).
 */
export function buildPairs(days) {
  const list = days || [];
  const bands = shadowBands(list);
  const pairs = [];
  for (let i = 0; i < list.length; i++) {
    const band = bands[i]?.band ?? null;
    const autonomy = list[i].placement?.axes?.autonomy ?? null;
    if (band == null || autonomy == null) continue;
    pairs.push({ band, autonomy, outcome: outcomeValue(list[i].placement) });
  }
  return pairs;
}

/**
 * The deterministic decision. Short-circuit order matters:
 *  1. n < MIN_PAIRED_DAYS → NOT_ENOUGH_DATA, WITHOUT computing any correlation
 *     (never print a rho computed on under-minimum n).
 *  2. rho undefined (constant series) → HOLD (degenerate).
 *  3. |rho| >= MERGE_RHO → MERGE.
 *  4. |rho| < PROMOTE_RHO → test independence via the outcome point-biserial,
 *     computed on the outcome-bearing SUBSET (nOutcome): nOutcome below the
 *     same MIN_PAIRED_DAYS floor → HOLD (never PROMOTE off a handful of
 *     outcome days); zero-variance → HOLD; significant AND positive (band>0
 *     predicts HIGHER outcome quality) → PROMOTE; else HOLD (incl.
 *     significant-but-negative).
 *  5. buffer zone PROMOTE_RHO <= |rho| < MERGE_RHO → HOLD.
 */
export function verdictFromPairs(pairs) {
  const n = pairs.length;
  if (n < MIN_PAIRED_DAYS) {
    return { verdict: "NOT_ENOUGH_DATA", rho: null, pointBiserial: null, p: null, n };
  }

  const bands = pairs.map((r) => r.band);
  const autonomies = pairs.map((r) => r.autonomy);
  const rho = spearmanRho(bands, autonomies);
  if (rho === null) {
    return {
      verdict: "HOLD",
      rho: null,
      pointBiserial: null,
      p: null,
      n,
      note: "degenerate: constant series",
    };
  }

  if (Math.abs(rho) >= MERGE_RHO) {
    return { verdict: "MERGE", rho, pointBiserial: null, p: null, n };
  }

  if (Math.abs(rho) < PROMOTE_RHO) {
    // Independence gate: does the band predict outcome quality on its own?
    // The point-biserial runs on the outcome-bearing SUBSET, so it needs its
    // own floor — without it, PROMOTE could fire off a handful of outcome days
    // even when the window has MIN_PAIRED_DAYS+ paired days overall.
    const outRows = pairs.filter((r) => r.outcome != null);
    const nOutcome = outRows.length;
    if (nOutcome < MIN_PAIRED_DAYS) {
      return {
        verdict: "HOLD",
        rho,
        pointBiserial: null,
        p: null,
        n,
        nOutcome,
        note: `insufficient outcome-bearing days for point-biserial (n_outcome=${nOutcome} < ${MIN_PAIRED_DAYS})`,
      };
    }
    const binary = outRows.map((r) => (r.band > 0 ? 1 : 0));
    const outcomes = outRows.map((r) => r.outcome);
    const pb = pointBiserial(binary, outcomes);
    if (pb.r === null) {
      // nOutcome >= MIN_PAIRED_DAYS here, so a null r is genuinely zero variance.
      return {
        verdict: "HOLD",
        rho,
        pointBiserial: null,
        p: null,
        n,
        nOutcome,
        note: "degenerate: zero-variance point-biserial",
      };
    }
    // Directional gate: PROMOTE only on a significant POSITIVE point-biserial —
    // band>0 must track HIGHER outcome quality. A significant negative relation
    // (band>0 ↔ worse verification) does not "predict outcome quality" in the
    // sense the axis promotion requires, so it HOLDs rather than promotes.
    if (pb.p != null && pb.p < SIG_P && pb.r > 0) {
      return { verdict: "PROMOTE", rho, pointBiserial: pb.r, p: pb.p, n, nOutcome };
    }
    return { verdict: "HOLD", rho, pointBiserial: pb.r, p: pb.p, n, nOutcome };
  }

  // buffer zone: PROMOTE_RHO <= |rho| < MERGE_RHO
  return { verdict: "HOLD", rho, pointBiserial: null, p: null, n };
}

// ── Orchestration + rendering ───────────────────────────────────────────────

/** Full calibration result for an analyze `result`: verdict + metadata. */
export function calibrate(result) {
  const cal = verdictFromPairs(buildPairs(result?.days || []));
  return {
    ...cal,
    metric: OUTCOME_METRIC,
    window: result?.window,
    thresholds: { MERGE_RHO, PROMOTE_RHO, SIG_P, MIN_PAIRED_DAYS },
  };
}

// Format a number to fixed dp; null / non-finite → an em-dash (never NaN/null).
function fmt(v, dp = 3) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(dp);
}

/** stdout string for `aios analyze --calibrate`: verdict + stats + thresholds. */
export function renderVerdict(cal) {
  const c = cal || {};
  const win = c.window ? `${c.window.since} → ${c.window.until}` : "(no window)";
  const L = [];
  L.push(`CE calibration verdict: ${c.verdict}`);
  L.push(`  window            ${win}`);
  L.push(`  paired days (n)   ${c.n}`);
  L.push(`  spearman rho      ${fmt(c.rho)}   (band vs autonomy)`);
  L.push(`  point-biserial r  ${fmt(c.pointBiserial)}   (band>0 vs ${c.metric})`);
  L.push(`  point-biserial p  ${fmt(c.p)}`);
  if (c.nOutcome != null) L.push(`  outcome days      ${c.nOutcome}   (point-biserial n)`);
  if (c.note) L.push(`  note              ${c.note}`);
  L.push(
    `  thresholds        MERGE |rho|≥${MERGE_RHO} · PROMOTE |rho|<${PROMOTE_RHO} & p<${SIG_P} (r>0) · ` +
      `min-days ${MIN_PAIRED_DAYS}`
  );
  L.push(
    `                    HOLD when ${PROMOTE_RHO}≤|rho|<${MERGE_RHO}, or inconclusive/degenerate`
  );
  return L.join("\n");
}

/**
 * Markdown artifact — DERIVED STATISTICS ONLY (verdict, rho, n, point-biserial
 * r/p, metric name, thresholds, window, note). No raw signals, no per-day rows,
 * no per-session detail: this file is safe for the Phase C promotion issue to cite.
 */
export function verdictArtifact(cal) {
  const c = cal || {};
  const win = c.window ? `${c.window.since} → ${c.window.until}` : "(no window)";
  const th = c.thresholds || {};
  const L = [];
  L.push(`# CE calibration verdict — ${c.verdict}`);
  L.push("");
  L.push("Phase B statistical test for the Cognitive Ergonomics shadow band");
  L.push("(AIO-190 → AIO-216). Derived statistics only — no raw signals.");
  L.push("");
  L.push("| Field | Value |");
  L.push("|-------|-------|");
  L.push(`| Verdict | **${c.verdict}** |`);
  L.push(`| Window | ${win} |`);
  L.push(`| Paired days (n) | ${c.n} |`);
  L.push(`| Spearman rho (band vs autonomy) | ${fmt(c.rho)} |`);
  L.push(`| Point-biserial r (band>0 vs ${c.metric}) | ${fmt(c.pointBiserial)} |`);
  L.push(`| Point-biserial p | ${fmt(c.p)} |`);
  if (c.nOutcome != null) L.push(`| Outcome-bearing days (point-biserial n) | ${c.nOutcome} |`);
  L.push(`| Outcome metric | ${c.metric} |`);
  if (c.note) L.push(`| Note | ${c.note} |`);
  L.push("");
  L.push("## Thresholds");
  L.push("");
  L.push("| Constant | Value | Rule |");
  L.push("|----------|-------|------|");
  L.push(`| MERGE_RHO | ${th.MERGE_RHO} | MERGE when \\|rho\\| ≥ ${th.MERGE_RHO} |`);
  L.push(
    `| PROMOTE_RHO | ${th.PROMOTE_RHO} | PROMOTE when \\|rho\\| < ${th.PROMOTE_RHO} and point-biserial p < ${th.SIG_P} with r > 0 |`
  );
  L.push(`| SIG_P | ${th.SIG_P} | point-biserial significant when p < ${th.SIG_P} |`);
  L.push(
    `| MIN_PAIRED_DAYS | ${th.MIN_PAIRED_DAYS} | NOT_ENOUGH_DATA when n < ${th.MIN_PAIRED_DAYS} |`
  );
  L.push("");
  L.push(
    `HOLD applies in the buffer zone (${th.PROMOTE_RHO} ≤ \\|rho\\| < ${th.MERGE_RHO}), when the outcome ` +
      "point-biserial is not significant (or significant but negative), or when a series is " +
      "degenerate (constant / zero-variance)."
  );
  L.push("");
  L.push(
    "_Analysis-only artifact. Regenerated on each `aios analyze --calibrate` run; " +
      "same-day re-runs overwrite (latest run wins)._"
  );
  L.push("");
  return L.join("\n");
}

/**
 * Write the artifact to `<repo>/.aios/calibration-verdict-<YYYY-MM-DD>.md`
 * (mirrors roadmap-run.mjs:defaultWriteDigest). `isoDateFn` maps a Date → an
 * ISO yyyy-mm-dd string (injected so tests stay deterministic). Same-day re-runs
 * overwrite. Returns the written path.
 */
export function writeVerdictArtifact(repo, cal, isoDateFn) {
  const dir = path.join(repo, ".aios");
  mkdirSync(dir, { recursive: true });
  const date = isoDateFn(new Date());
  const p = path.join(dir, `calibration-verdict-${date}.md`);
  writeFileSync(p, verdictArtifact(cal));
  return p;
}
