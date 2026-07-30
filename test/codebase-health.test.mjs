// test/codebase-health.test.mjs — the composed codebase-health scorer (AIO-605).
//
// Covers, per the spec's Acceptance section:
//   - rubric shape: exactly the seven axes, thresholds/cut-points all in DATA;
//   - thresholds-in-data proof: perturbing a fixture rubric copy moves the band with
//     zero scorer-code change;
//   - composition over a synthetic repo (config-derived counts, the ONE normalized
//     coverage artifact, mutation group reports, gate exit codes);
//   - the JSON v1 redaction invariant (exact field set, scalars only, no paths);
//   - anti-drift: bumping each reported blocker to its neededValue advances the band;
//   - the one-artifact rule: the scorer contains no coverage/lcov parser of its own;
//   - analyze shadow card null-tolerance + pinned placement byte-stability.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeCodebaseHealth,
  toHealthJson,
  loadHealthRubric,
  bandForValue,
  axisBand,
  nextTargetBlockers,
  DEFAULT_RUBRIC_PATH,
} from "../scripts/codebase-health.mjs";
import { codebaseHealthCard } from "../scripts/analyze/aem.mjs";
import { toJson } from "../scripts/analyze/report.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(ROOT, "scripts", "aios.mjs");

const AXIS_KEYS = [
  "modularity",
  "boundaries",
  "test_rigor",
  "lint_type",
  "docs_parity",
  "invariants",
  "contributor_friction",
];

/** A synthetic repo carrying config-derived inputs but none of the gate scripts. */
function syntheticRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "codebase-health-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, "coverage"), { recursive: true });
  mkdirSync(path.join(dir, "reports", "mutation"), { recursive: true });
  writeFileSync(
    path.join(dir, "scripts", "size-caps.json"),
    JSON.stringify({
      defaultCap: 500,
      include: ["**/*.mjs"],
      exclude: [],
      grandfathered: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`big-${i}.mjs`, 600])),
    })
  );
  writeFileSync(
    path.join(dir, "scripts", "boundaries.json"),
    JSON.stringify({
      rules: [],
      grandfathered: [
        { from: "a.mjs", to: "b/c.mjs" },
        { from: "d.mjs", to: "b/e.mjs" },
      ],
    })
  );
  writeFileSync(
    path.join(dir, "coverage", "coverage-summary.json"),
    JSON.stringify({
      total: {
        lines: { pct: 81.2 },
        statements: { pct: 80.9 },
        functions: { pct: 77.1 },
        branches: { pct: 72.4 },
      },
    })
  );
  writeFileSync(
    path.join(dir, "coverage-baseline.json"),
    JSON.stringify({ version: 1, minimum: { lines: 79.7 } })
  );
  writeFileSync(
    path.join(dir, "reports", "mutation", "group-a.json"),
    JSON.stringify({
      files: {
        "a.mjs": {
          mutants: [
            { status: "Killed" },
            { status: "Timeout" },
            { status: "Survived" },
            { status: "Ignored" },
          ],
        },
      },
    })
  );
  return dir;
}

const findCheck = (result, id) => result.checks.find((c) => c.id === id);

// ── rubric shape ─────────────────────────────────────────────────────────────

test("rubric declares exactly the seven axes with thresholds in data", () => {
  const rubric = loadHealthRubric();
  assert.equal(rubric.id, "aios.codebase-health");
  assert.deepEqual(
    rubric.axes.map((a) => a.key),
    AXIS_KEYS
  );
  const checkIds = Object.keys(rubric.checks);
  for (const axis of rubric.axes) {
    if (axis.bandMetric !== null) {
      assert.ok(checkIds.includes(axis.bandMetric), `${axis.key} bandMetric unknown`);
      assert.equal(axis.bandThresholds.length, 4, `${axis.key} needs 4 band edges`);
      for (const t of axis.bandThresholds) assert.equal(typeof t, "number");
      assert.ok(["lowerIsBetter", "higherIsBetter"].includes(axis.direction));
    }
    for (const gate of axis.gates) assert.ok(checkIds.includes(gate), `${axis.key} gate unknown`);
    assert.ok((axis.weight ?? 1) > 0);
  }
  for (const [id, spec] of Object.entries(rubric.checks)) {
    assert.ok(AXIS_KEYS.includes(spec.axis), `check ${id} names unknown axis ${spec.axis}`);
    assert.ok(["gate", "metric"].includes(spec.kind), `check ${id} kind`);
  }
  for (const id of rubric.invariants) {
    assert.ok(checkIds.includes(id), `invariants enumeration names unknown check ${id}`);
    assert.equal(rubric.checks[id].kind, "gate", "invariants enumerate gate checks");
  }
  assert.equal(typeof rubric.statusCutpoints.healthy, "number");
  assert.equal(typeof rubric.statusCutpoints.degraded, "number");
});

test("bandForValue: both directions + null passthrough", () => {
  assert.equal(bandForValue(3, "lowerIsBetter", [10, 40, 80, 150]), 4);
  assert.equal(bandForValue(63, "lowerIsBetter", [10, 40, 80, 150]), 2);
  assert.equal(bandForValue(999, "lowerIsBetter", [10, 40, 80, 150]), 0);
  assert.equal(bandForValue(92, "higherIsBetter", [90, 80, 70, 50]), 4);
  assert.equal(bandForValue(49, "higherIsBetter", [90, 80, 70, 50]), 0);
  assert.equal(bandForValue(null, "lowerIsBetter", [10, 40, 80, 150]), null);
});

// ── thresholds-in-data proof ─────────────────────────────────────────────────

test("perturbing a rubric fixture copy moves the band with zero scorer-code change", async () => {
  const repo = syntheticRepo();
  const rubricCopy = path.join(repo, "rubric-perturbed.json");
  try {
    const before = await computeCodebaseHealth(repo, { mode: "cheap" });
    assert.equal(before.axes.modularity.band, 4, "8 grandfathers clear the shipped t4=10 edge");

    const rubric = JSON.parse(readFileSync(DEFAULT_RUBRIC_PATH, "utf8"));
    rubric.axes.find((a) => a.key === "modularity").bandThresholds = [5, 40, 80, 150];
    writeFileSync(rubricCopy, JSON.stringify(rubric));

    const after = await computeCodebaseHealth(repo, { mode: "cheap", rubricPath: rubricCopy });
    assert.equal(after.axes.modularity.band, 3, "tightening t4 to 5 drops the band to 3");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── composition over the synthetic repo ──────────────────────────────────────

test("cheap-mode scoring composes config counts, the ONE coverage artifact, and mutation reports", async () => {
  const repo = syntheticRepo();
  try {
    const result = await computeCodebaseHealth(repo, { mode: "cheap" });
    assert.equal(findCheck(result, "size_grandfather_count").value, 8);
    assert.equal(findCheck(result, "size_grandfather_max").value, 600);
    assert.equal(findCheck(result, "boundary_grandfather_count").value, 2);
    assert.equal(findCheck(result, "ratchet_debt_total").value, 10);
    assert.equal(findCheck(result, "coverage_lines_pct").value, 81.2);
    assert.equal(findCheck(result, "coverage_floor_headroom").value, 1.5);
    // 2 killed (Killed + Timeout) of 3 scored (Ignored excluded) = 66.7%
    assert.equal(findCheck(result, "mutation_score_pct").value, 66.7);
    // gate scripts absent → skipped, never failures
    assert.equal(findCheck(result, "file_size_gate").value, null);
    assert.equal(findCheck(result, "file_size_gate").ok, true);
    // axes with no live inputs stay unscored
    assert.equal(result.axes.lint_type.band, null);
    assert.equal(result.axes.docs_parity.band, null);
    // bands from rubric data: 8 ≤ 10 → 4; 2 ≤ 5 → 4; 81.2 ≥ 80 → 3
    assert.equal(result.axes.modularity.band, 4);
    assert.equal(result.axes.boundaries.band, 4);
    assert.equal(result.axes.test_rigor.band, 3);
    assert.equal(result.status, "healthy");
    assert.deepEqual(result.failed_invariant_ids, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a failing enumerated gate caps its axis and lands in failed_invariant_ids", async () => {
  const repo = syntheticRepo();
  try {
    // A repo-local boundary gate that fails: runGate composes the SCANNED repo's own gate.
    writeFileSync(path.join(repo, "scripts", "check-boundaries.mjs"), "process.exit(1);\n");
    const result = await computeCodebaseHealth(repo, { mode: "cheap" });
    const gate = findCheck(result, "boundary_gate");
    assert.equal(gate.ok, false);
    assert.deepEqual(result.failed_invariant_ids, ["boundary_gate"]);
    assert.equal(findCheck(result, "invariant_gate_failures").value, 1);
    // gateFailCap (rubric data) caps the boundaries band despite a healthy metric
    const rubric = loadHealthRubric();
    assert.equal(result.axes.boundaries.band, rubric.gateFailCap);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── JSON v1 redaction invariant ──────────────────────────────────────────────

test("toHealthJson: exact v1 field set, scalars only, no paths anywhere", async () => {
  const repo = syntheticRepo();
  try {
    const result = await computeCodebaseHealth(repo, { mode: "cheap" });
    const json = toHealthJson(result, repo);
    assert.deepEqual(Object.keys(json), [
      "schema_version",
      "rubric_version",
      "head_sha",
      "measured_at",
      "score_pct",
      "status",
      "axes",
      "failed_invariant_ids",
      "checks",
    ]);
    assert.equal(json.schema_version, 1);
    assert.deepEqual(Object.keys(json.axes), AXIS_KEYS);
    for (const axis of Object.values(json.axes)) {
      assert.deepEqual(Object.keys(axis), ["band", "passed", "total"]);
    }
    for (const chk of json.checks) {
      assert.deepEqual(Object.keys(chk), ["id", "ok", "value"], "checks carry id/ok/value ONLY");
      assert.ok(
        chk.value === null || ["number", "boolean"].includes(typeof chk.value),
        `${chk.id} value must be a scalar`
      );
    }
    // No value anywhere may look like a repo-relative path or carry evidence text.
    const walk = (v, at) => {
      if (typeof v === "string") {
        assert.ok(!v.includes("/"), `path-like string leaked at ${at}: ${v}`);
        assert.ok(!v.includes(" "), `evidence text leaked at ${at}: ${v}`);
      } else if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) walk(child, `${at}.${k}`);
      }
    };
    walk(json, "$");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── anti-drift: blockers come from the SAME rubric data the bander rewards ───

test("anti-drift: bumping each reported blocker to its neededValue advances the axis band", async () => {
  const repo = syntheticRepo();
  try {
    const rubric = loadHealthRubric();
    const result = await computeCodebaseHealth(repo, { mode: "cheap" });
    const blockers = nextTargetBlockers(result.axes, result.checks, rubric);
    assert.ok(blockers.length >= 1, "the synthetic repo has at least one sub-4 scorable axis");
    for (const b of blockers) {
      const axis = rubric.axes.find((a) => a.key === b.axis);
      const patched = result.checks.map((c) =>
        c.id === b.metric ? { ...c, value: b.neededValue } : c
      );
      const band = axisBand(
        axis,
        rubric,
        patched.filter((c) => c.axis === axis.key)
      );
      assert.equal(
        band,
        b.neededBand,
        `${b.axis}: bumping ${b.metric} ${b.current} → ${b.neededValue} must reach band ${b.neededBand}`
      );
      assert.ok(band > b.currentBand, `${b.axis} band must ADVANCE`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── one-artifact rule ────────────────────────────────────────────────────────

test("the scorer has no coverage parser of its own (grep lcov finds nothing)", () => {
  for (const rel of [
    "scripts/codebase-health.mjs",
    "scripts/codebase-health/checks.mjs",
    "scripts/codebase-health/banding.mjs",
  ]) {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!/lcov/i.test(src), `${rel} must read scripts/coverage-report.mjs, not parse lcov`);
  }
});

// ── analyze shadow card ──────────────────────────────────────────────────────

test("codebaseHealthCard: null in → null out; result in → scalars-only card", async () => {
  assert.equal(codebaseHealthCard(null), null);
  const repo = syntheticRepo();
  try {
    const result = await computeCodebaseHealth(repo, { mode: "cheap" });
    const card = codebaseHealthCard(result);
    assert.equal(card.label, "Codebase health");
    assert.equal(card.metrics.status, result.status);
    assert.equal(card.metrics.score_pct, result.score_pct);
    assert.equal(card.metrics.failed_invariants, 0);
    assert.equal(typeof card.reading, "string");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("toJson: codebase_health card present only when a scoring succeeded; placement byte-stable", async () => {
  const base = {
    window: { since: "2026-07-01", until: "2026-07-08" },
    tools: ["claude"],
    totals: { sessions: 0, tasks: 0, events: 0, total_tokens: 0 },
    signals: {},
    placement: { axes: {}, spine: "L1", overall: 0, weakest: "verification" },
    days: [],
  };
  const without = toJson(base, null, null, null);
  assert.ok(!("codebase_health" in without));
  const repo = syntheticRepo();
  try {
    const cbh = await computeCodebaseHealth(repo, { mode: "cheap" });
    const withCard = toJson(base, null, null, cbh);
    assert.equal(withCard.codebase_health.label, "Codebase health");
    assert.equal(
      JSON.stringify(withCard.placement),
      JSON.stringify(without.placement),
      "pinned placement must be byte-identical either way"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── CLI wiring (registry descriptor, zero lines in aios.mjs) ─────────────────

test("aios codebase-health --json emits the v1 object for an explicit path", () => {
  const repo = syntheticRepo();
  try {
    const r = spawnSync(process.execPath, [AIOS, "codebase-health", repo, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.schema_version, 1);
    assert.equal(typeof json.score_pct, "number");
    assert.deepEqual(Object.keys(json.axes), AXIS_KEYS);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
