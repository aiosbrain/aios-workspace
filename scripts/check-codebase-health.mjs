#!/usr/bin/env node
/**
 * check-codebase-health.mjs — ADVISORY codebase-health delta vs the committed baseline
 * (AIO-605 PR2; spec docs/v1-operator-loop/domains/codebase-health.md).
 *
 * Runs the composed scorer (scripts/codebase-health.mjs, full mode) against the cwd
 * repo and prints score / per-axis band deltas against
 * validation/codebase-health-baseline.json.
 *
 * ALWAYS exits 0 in v0.9.0 — it cannot fail the release. A regressed score is
 * information, printed loudly, never a gate; flipping advisory→ratchet is a separate
 * later decision (the check-modularity.mjs Hashimoto pattern — observe first, then
 * lock; the mode flag would live in the rubric JSON, not here).
 *
 * Usage:
 *   node scripts/check-codebase-health.mjs                    # advisory delta report
 *   node scripts/check-codebase-health.mjs --write-baseline   # regenerate the baseline
 *                                                             # (the ONLY write path)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { computeCodebaseHealth, toHealthJson } from "./codebase-health.mjs";

const ROOT = process.cwd();
const BASELINE_PATH = path.join(ROOT, "validation", "codebase-health-baseline.json");
const WRITE = process.argv.includes("--write-baseline");

const arrow = (from, to) => (to > from ? "↑" : to < from ? "↓" : "=");

function fmtBand(b) {
  return b === null || b === undefined ? "–" : `${b}/4`;
}

const result = await computeCodebaseHealth(ROOT, { mode: "full" });
const current = toHealthJson(result, ROOT);

if (WRITE) {
  const baseline = {
    _comment:
      "Committed codebase-health baseline (AIO-605). Regenerate deliberately with `node scripts/check-codebase-health.mjs --write-baseline` after a structural change lands — never by hand. Compared ADVISORY-only by the CI step (always exit 0 in v0.9.0).",
    generated_at: current.measured_at,
    schema_version: current.schema_version,
    rubric_version: current.rubric_version,
    profile_id: current.profile_id,
    profile_version: current.profile_version,
    score_pct: current.score_pct,
    status: current.status,
    evidence_status: current.evidence_status,
    quality_gate: current.quality_gate,
    automation_eligible: current.automation_eligible,
    axes: current.axes,
    failed_invariant_ids: current.failed_invariant_ids,
    checks: current.checks,
    findings: current.findings,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(
    `codebase-health baseline written: ${current.status} ${current.score_pct}% → validation/codebase-health-baseline.json`
  );
  process.exit(0);
}

let baseline = null;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
} catch {
  console.log(
    "codebase-health (advisory): no committed baseline at validation/codebase-health-baseline.json — " +
      "current reading only. Generate one with --write-baseline."
  );
}

console.log(
  `codebase-health (ADVISORY): ${result.status} ${result.score_pct ?? "–"}% · ` +
    `evidence ${result.evidence_status} · gate ${result.quality_gate}` +
    (baseline
      ? `  (baseline: ${baseline.status} ${baseline.score_pct}% @ ${baseline.generated_at})`
      : "")
);

for (const [key, axis] of Object.entries(current.axes)) {
  const base = baseline?.axes?.[key];
  const delta =
    base && axis.band !== null && base.band !== null
      ? ` ${arrow(base.band, axis.band)} (baseline ${fmtBand(base.band)})`
      : base
        ? ` (baseline ${fmtBand(base.band)})`
        : "";
  console.log(`  ${key.padEnd(22)} ${fmtBand(axis.band).padEnd(4)}${delta}`);
}

if (baseline && current.score_pct !== null && baseline.score_pct !== null) {
  const diff = current.score_pct - baseline.score_pct;
  if (diff < 0) {
    console.log(
      `\n  ⚠ score regressed ${baseline.score_pct}% → ${current.score_pct}% vs baseline — advisory only, ` +
        "the job stays green. Investigate before the ratchet flips."
    );
  } else if (diff > 0) {
    console.log(`\n  ✓ score improved ${baseline.score_pct}% → ${current.score_pct}% vs baseline.`);
  } else {
    console.log("\n  = score unchanged vs baseline.");
  }
}
if (result.failed_invariant_ids.length) {
  console.log(`  ⚠ failing invariant gate(s): ${result.failed_invariant_ids.join(", ")}`);
}

// ADVISORY: always green in v0.9.0.
process.exit(0);
