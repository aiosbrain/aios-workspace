#!/usr/bin/env node
// test/ergonomics-calibrate.test.mjs — AIO-216 W5 Phase B: the CE shadow-band
// calibration harness. Asserts the pure statistics (tie-corrected Spearman,
// two-tailed Student-t p, point-biserial), every verdict branch on constructed
// integer pairs, the degenerate / not-enough-data guards (never NaN, never a
// false PROMOTE), the outcome-metric resolver, rubric↔code drift, and the
// read-only CLI branch. Synthetic fixtures only. Zero network, zero deps.
// Run: node test/ergonomics-calibrate.test.mjs

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  averageRanks,
  spearmanRho,
  studentTwoTailedP,
  pointBiserial,
  outcomeValue,
  buildPairs,
  verdictFromPairs,
  calibrate,
  renderVerdict,
  verdictArtifact,
  MERGE_RHO,
  PROMOTE_RHO,
  SIG_P,
  MIN_PAIRED_DAYS,
  OUTCOME_METRIC,
} from "../scripts/analyze/ergonomics-calibrate.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

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
const approx = (a, b, tol = 1e-3) => a != null && b != null && Math.abs(a - b) <= tol;

// ── fixtures ────────────────────────────────────────────────────────────────

/** A pair row as buildPairs/verdictFromPairs consume: {band, autonomy, outcome}. */
const mk = (bands, auts, outs) =>
  bands.map((band, i) => ({ band, autonomy: auts[i], outcome: outs ? outs[i] : null }));

// ── Spearman + tie averaging ────────────────────────────────────────────────

check("spearman: perfectly monotone → 1", spearmanRho([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]) === 1);
check("spearman: reversed → -1", spearmanRho([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) === -1);
check("spearman: n<2 → null", spearmanRho([1], [1]) === null);
check(
  "spearman: constant series → null (not NaN)",
  spearmanRho([2, 2, 2, 2], [1, 2, 3, 4]) === null
);

// average ranks with ties: [1,1,2,3,3,3] → 1.5,1.5 share ranks 1&2; 2→3; three 3s share 4,5,6→5
check(
  "averageRanks ties: [1,1,2,3,3,3] → [1.5,1.5,3,5,5,5]",
  JSON.stringify(averageRanks([1, 1, 2, 3, 3, 3])) === JSON.stringify([1.5, 1.5, 3, 5, 5, 5])
);

// Hand-computed tied Spearman (discrete 0–4). x and y both carry ties, so the
// naive 1−6Σd²/(n(n²−1)) formula is invalid; the tie-corrected value is the
// average-rank Pearson. By hand: rx = [1.5,1.5,3,4.5,4.5,6,7],
// ry = [1,2.5,2.5,4,5.5,5.5,7], both mean 4 → r = 25.5/27 = 0.94444…
{
  const x = [0, 0, 1, 2, 2, 3, 4];
  const y = [0, 1, 1, 2, 3, 3, 4];
  check(
    "spearman tied series ≈ 25.5/27 = 0.94444 (hand-computed)",
    approx(spearmanRho(x, y), 25.5 / 27, 1e-9)
  );
}

// ── Student-t two-tailed p — external cross-check vs standard t-table criticals ──
// Critical values are from any standard Student's t distribution table; each is
// the t for which the two-tailed p equals the stated target. (Also matches
// scipy stats.t.sf(t, df)*2 / R 2*pt(-t, df).)
check("p(t=2.10092, df=18) ≈ 0.05", approx(studentTwoTailedP(2.10092, 18), 0.05));
check("p(t=2.22814, df=10) ≈ 0.05", approx(studentTwoTailedP(2.22814, 10), 0.05));
check("p(t=3.16927, df=10) ≈ 0.01", approx(studentTwoTailedP(3.16927, 10), 0.01));
check("p(t=2.04227, df=30) ≈ 0.05", approx(studentTwoTailedP(2.04227, 30), 0.05));
check("p(t=1.95996, df=1e7) ≈ 0.05 (normal limit)", approx(studentTwoTailedP(1.95996, 1e7), 0.05));
check("p(t=0, df=10) === 1", studentTwoTailedP(0, 10) === 1);
check("p: df<1 → null", studentTwoTailedP(2, 0) === null);
check("p: non-finite t → null", studentTwoTailedP(Infinity, 10) === null);

// ── point-biserial ──────────────────────────────────────────────────────────
// Hand-computed r: binary = 5 zeros then 5 ones, ys = 1..10.
//   cov = 4 − 0.5·5.5 = 1.25 ; sd_x = 0.5 ; sd_y = sqrt(8.25) ; r = 1.25/(0.5·√8.25) = 0.87039
{
  const pb = pointBiserial([0, 0, 0, 0, 0, 1, 1, 1, 1, 1], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  check("point-biserial r ≈ 0.87039 (hand-computed)", approx(pb.r, 0.87039, 1e-4));
  check("point-biserial p < 0.05 for that r", pb.p != null && pb.p < 0.05);
  check("point-biserial n === 10", pb.n === 10);
}
check(
  "point-biserial: all-ones binary → {r:null,p:null} (zero variance)",
  (() => {
    const pb = pointBiserial([1, 1, 1, 1, 1, 1], [1, 2, 3, 2, 1, 4]);
    return pb.r === null && pb.p === null;
  })()
);
check(
  "point-biserial: constant outcome → {r:null,p:null}",
  (() => {
    const pb = pointBiserial([0, 1, 0, 1, 0, 1], [3, 3, 3, 3, 3, 3]);
    return pb.r === null && pb.p === null;
  })()
);
check(
  "point-biserial: n<3 → {r:null,p:null}",
  (() => {
    const pb = pointBiserial([0, 1], [1, 2]);
    return pb.r === null && pb.p === null && pb.n === 2;
  })()
);

// ── outcomeValue resolver ───────────────────────────────────────────────────
// OUTCOME_METRIC is axes.verification in this build; that path resolves and a
// missing path returns null. (The "overall" branch activates if the constant is
// switched — covered structurally below.)
check(
  "outcomeValue: axes.verification resolves",
  outcomeValue({ axes: { verification: 3 } }) === 3
);
check("outcomeValue: missing placement → null", outcomeValue(null) === null);
check("outcomeValue: missing axis → null", outcomeValue({ axes: {} }) === null);
check("outcomeValue: current metric is axes.verification", OUTCOME_METRIC === "axes.verification");

// ── verdict branches on constructed integer pairs ───────────────────────────

// MERGE: band === autonomy → rho 1.0 (≥ 0.7)
{
  const b = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 0, 1, 2, 3];
  const v = verdictFromPairs(mk(b, b, b));
  check("MERGE when |rho| ≥ 0.7", v.verdict === "MERGE" && Math.abs(v.rho) >= MERGE_RHO);
  check("MERGE: pointBiserial not computed (null)", v.pointBiserial === null);
}

// PROMOTE: |rho| < 0.5 AND significant point-biserial (band>0 predicts outcome)
{
  const band = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 2, 3, 1];
  const aut = [2, 3, 4, 1, 4, 2, 3, 0, 1, 4, 0, 2, 1, 3];
  const out = [0, 1, 0, 1, 0, 1, 0, 3, 4, 4, 3, 4, 3, 4];
  const v = verdictFromPairs(mk(band, aut, out));
  check(
    "PROMOTE when |rho| < 0.5 and point-biserial p < 0.05",
    v.verdict === "PROMOTE" && Math.abs(v.rho) < PROMOTE_RHO && v.p < SIG_P
  );
}

// HOLD buffer zone: 0.5 ≤ |rho| < 0.7
{
  const band = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 1, 2, 0, 4];
  const aut = [0, 2, 1, 3, 1, 2, 4, 2, 3, 4, 1, 3, 0, 2];
  const v = verdictFromPairs(mk(band, aut, band));
  check(
    "HOLD in buffer zone 0.5 ≤ |rho| < 0.7",
    v.verdict === "HOLD" && Math.abs(v.rho) >= PROMOTE_RHO && Math.abs(v.rho) < MERGE_RHO
  );
}

// HOLD: low rho but point-biserial insignificant
{
  const band = [0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 2, 3, 1];
  const aut = [2, 3, 4, 1, 4, 2, 3, 0, 1, 4, 0, 2, 1, 3];
  const out = [2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3, 2, 3];
  const v = verdictFromPairs(mk(band, aut, out));
  check(
    "HOLD when |rho| < 0.5 but point-biserial insignificant",
    v.verdict === "HOLD" && Math.abs(v.rho) < PROMOTE_RHO && v.p >= SIG_P
  );
}

// ── degenerate point-biserial → HOLD, never NaN, never false PROMOTE ────────
{
  // all bands zero: rho undefined (constant band series) → HOLD via constant guard
  const n = MIN_PAIRED_DAYS + 2;
  const zeros = Array(n).fill(0);
  const aut = Array.from({ length: n }, (_, i) => i % 5);
  const out = Array.from({ length: n }, (_, i) => (i % 4) + 1);
  const v = verdictFromPairs(mk(zeros, aut, out));
  check(
    "all-band-zero → HOLD (degenerate, no NaN, no PROMOTE)",
    v.verdict === "HOLD" && !Number.isNaN(v.rho ?? 0) && v.pointBiserial === null
  );
}
{
  // all bands positive but VARYING (so band series is non-constant → rho defined,
  // small), yet binary column band>0 is all-ones → point-biserial zero-variance.
  const band = [1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 2, 3];
  const aut = [4, 1, 3, 2, 0, 4, 1, 3, 2, 0, 4, 1, 3, 2];
  const out = [3, 1, 4, 2, 3, 1, 4, 2, 3, 1, 4, 2, 1, 3];
  const v = verdictFromPairs(mk(band, aut, out));
  const smallRho = Math.abs(v.rho) < PROMOTE_RHO;
  check(
    "all-band-positive + small rho → HOLD (zero-variance point-biserial, no NaN)",
    smallRho
      ? v.verdict === "HOLD" && v.pointBiserial === null && v.p === null
      : v.verdict !== "PROMOTE" // if rho landed in buffer/merge, still never a false PROMOTE
  );
  check("all-band-positive: rho is finite (not NaN)", Number.isFinite(v.rho));
}

// ── NOT_ENOUGH_DATA short-circuit ───────────────────────────────────────────
{
  const n = MIN_PAIRED_DAYS - 1;
  const band = Array.from({ length: n }, (_, i) => i % 5);
  const aut = Array.from({ length: n }, (_, i) => (i * 2) % 5);
  const out = Array.from({ length: n }, (_, i) => (i % 4) + 1);
  const v = verdictFromPairs(mk(band, aut, out));
  check(
    "n = MIN−1 → NOT_ENOUGH_DATA (rho/pb/p all null, no throw)",
    v.verdict === "NOT_ENOUGH_DATA" &&
      v.rho === null &&
      v.pointBiserial === null &&
      v.p === null &&
      v.n === n
  );
}

// ── constant-series degeneracy (all-equal autonomy) → HOLD ──────────────────
{
  const n = MIN_PAIRED_DAYS + 1;
  const band = Array.from({ length: n }, (_, i) => i % 5);
  const aut = Array(n).fill(3); // constant autonomy → rho undefined
  const out = Array.from({ length: n }, (_, i) => (i % 4) + 1);
  const v = verdictFromPairs(mk(band, aut, out));
  check(
    "constant autonomy → HOLD, rho null (no NaN)",
    v.verdict === "HOLD" && v.rho === null && v.pointBiserial === null
  );
}

// ── buildPairs: drops rows with null band or null autonomy ──────────────────
{
  const days = [
    // baseline warm-up: shadowBands returns null band for the first MIN_BASELINE_DAYS
    ...Array.from({ length: 6 }, (_, i) => ({
      date: `2026-01-0${i + 1}`,
      signals: {
        active_hours: 6,
        focus_block_avg_min: 30,
        context_switch_rate: 10,
        interrupts_per_hour: 12,
        concurrent_sessions_peak: 6,
      },
      placement: { axes: { autonomy: 2, verification: 2 }, overall: 2 },
    })),
    // a day with null autonomy should be dropped even if band is non-null
    {
      date: "2026-01-07",
      signals: {
        active_hours: 6,
        focus_block_avg_min: 60,
        context_switch_rate: 4,
        interrupts_per_hour: 4,
        concurrent_sessions_peak: 3,
      },
      placement: { axes: { verification: 3 } }, // autonomy missing → dropped
    },
  ];
  const pairs = buildPairs(days);
  check(
    "buildPairs drops null-autonomy and warm-up null-band rows",
    pairs.every((p) => p.band != null && p.autonomy != null)
  );
}

// ── calibrate() wraps verdict + metadata ────────────────────────────────────
{
  const cal = calibrate({ days: [], window: { since: "2026-01-01", until: "2026-01-14" } });
  check("calibrate: empty days → NOT_ENOUGH_DATA", cal.verdict === "NOT_ENOUGH_DATA");
  check("calibrate: carries metric name", cal.metric === OUTCOME_METRIC);
  check(
    "calibrate: carries thresholds",
    cal.thresholds.MERGE_RHO === MERGE_RHO && cal.thresholds.MIN_PAIRED_DAYS === MIN_PAIRED_DAYS
  );
}

// ── renderers never print NaN / null literally ──────────────────────────────
{
  const cal = calibrate({ days: [], window: { since: "2026-01-01", until: "2026-01-14" } });
  const text = renderVerdict(cal);
  const md = verdictArtifact(cal);
  check("renderVerdict header present", text.includes("CE calibration verdict: NOT_ENOUGH_DATA"));
  check("renderVerdict uses — for nulls, not NaN/null", !/NaN|null/.test(text));
  check("verdictArtifact derived-stats only (no NaN/null)", !/NaN|null/.test(md));
  check("verdictArtifact has thresholds table", md.includes("MIN_PAIRED_DAYS"));
}

// ── rubric ↔ code drift ─────────────────────────────────────────────────────
{
  const rubric = readFileSync(path.join(REPO, ".claude/rubrics/calibration-verdict.md"), "utf8");
  // Parse the CV\d+ threshold rows into { Constant: Value }.
  const map = {};
  for (const line of rubric.split("\n")) {
    const m = line.match(/^\|\s*CV\d+\s*\|\s*([A-Z_]+)\s*\|\s*([^|]+?)\s*\|/);
    if (m) map[m[1]] = m[2].trim();
  }
  check("rubric: CV1 MERGE_RHO matches code", Number(map.MERGE_RHO) === MERGE_RHO);
  check("rubric: CV2 PROMOTE_RHO matches code", Number(map.PROMOTE_RHO) === PROMOTE_RHO);
  check("rubric: CV3 SIG_P matches code", Number(map.SIG_P) === SIG_P);
  check(
    "rubric: CV4 MIN_PAIRED_DAYS matches code",
    Number(map.MIN_PAIRED_DAYS) === MIN_PAIRED_DAYS
  );
  check("rubric: CV5 OUTCOME_METRIC matches code", map.OUTCOME_METRIC === OUTCOME_METRIC);
}

// ── CLI harness: --calibrate is read-only and never emits a JSON body ────────
{
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      "node",
      ["scripts/aios.mjs", "analyze", "--since", "30d", "--calibrate", "--json"],
      { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout || "").toString();
  }
  check("CLI --calibrate --json exits 0", code === 0);
  check("CLI stdout carries the verdict line", out.includes("CE calibration verdict:"));
  // stdout must NOT be a toJson body (no placement key leaked).
  let leakedJson = false;
  try {
    const parsed = JSON.parse(out.trim());
    leakedJson = parsed && typeof parsed === "object" && "placement" in parsed;
  } catch {
    leakedJson = false; // not JSON at all → good
  }
  check("CLI --calibrate --json does NOT emit an analyze JSON body", !leakedJson);
}

// ── hard rail: no direct aem.mjs import in the module ────────────────────────
{
  const src = readFileSync(path.join(REPO, "scripts/analyze/ergonomics-calibrate.mjs"), "utf8");
  check("hard rail: no direct import of ./aem.mjs", !/from\s+["']\.\/aem\.mjs["']/.test(src));
}

console.log(failed ? `\n${RED}${failed} check(s) failed${NC}` : `\n${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
