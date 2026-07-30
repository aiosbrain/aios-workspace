// AIO-608 — mapper guard for scripts/codebase-health/push-payload.mjs: the pure
// CLI-JSON-v1 → Brain API 1.15 `metrics.codebase_health` mapper the scan-on-merge
// workflow uses on its opt-in path (AIOS_PUSH_CODEBASE_HEALTH=1).
//
// Sibling of test/codebase-payload-contract.test.mjs and reuses its oracle: the vendored
// docs/contract/codebase-payload-1.15.schema.json compiled with ajv. Every mapped object
// is validated BOTH standalone (against $defs.codebaseHealth) and embedded into a full
// valid metrics payload (never-sparse: health only ever rides on the full block).
//
// Two input fixtures (BOTH fully synthetic — the examples-are-synthetic rule forbids real
// workspace data, shas, or metrics in fixtures):
//   - test/fixtures/codebase-health/cli-run.v1.json — a shape-faithful synthetic sample of
//     the full `aios codebase-health --json` output (all seven rubric axes incl. null-band
//     skipped ones, number schema_version, bare-date measured_at, trailing checks array);
//   - a minimal synthetic in-file object covering every mapped field precisely.
// Failure-path invariants: any input that cannot yield a COMPLETE 8-field contract object
// throws HealthMappingError — the mapper never emits a partial/sparse health object.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import {
  toContractCodebaseHealth,
  HealthMappingError,
} from "../scripts/codebase-health/push-payload.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/codebase-payload-1.15.schema.json"), "utf8")
);
const contractFixtures = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/codebase-payload-1.15-fixtures.json"), "utf8")
);
const fullCliRun = JSON.parse(
  readFileSync(path.join(ROOT, "test/fixtures/codebase-health/cli-run.v1.json"), "utf8")
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePayload = ajv.compile(schema);
const validateHealth = ajv.compile(schema.$defs.codebaseHealth);

// A full valid metrics payload WITHOUT health, to embed mapper output into (never sparse).
const carrier = contractFixtures.valid.find((f) => !f.payload.metrics.codebase_health).payload;

function assertContractValid(health, label) {
  assert.equal(
    validateHealth(health),
    true,
    `${label}: standalone — ${ajv.errorsText(validateHealth.errors)}`
  );
  const p = structuredClone(carrier);
  p.metrics.codebase_health = structuredClone(health);
  assert.equal(
    validatePayload(p),
    true,
    `${label}: embedded — ${ajv.errorsText(validatePayload.errors)}`
  );
}

// Synthetic CLI JSON v1 input — every field exercised, includes one skipped (null-band) axis.
function syntheticCli() {
  return {
    schema_version: 1,
    rubric_version: "1.0.0",
    head_sha: "abc123def456abc123def456abc123def456abc1",
    measured_at: "2026-07-30",
    score_pct: 55,
    status: "degraded",
    axes: {
      modularity: { band: 2, passed: 1, total: 4 },
      test_rigor: { band: null, passed: 0, total: 0 },
      invariants: { band: 4, passed: 2, total: 2 },
    },
    failed_invariant_ids: ["file_size_gate", "OGR04.tier-coverage"],
    checks: [{ id: "file_size_gate", ok: false, value: false }],
  };
}

test("full CLI-shape fixture maps to a contract-valid codebase_health object", () => {
  const health = toContractCodebaseHealth(fullCliRun);
  assertContractValid(health, "cli-run fixture");
  assert.equal(health.head_sha, fullCliRun.head_sha);
  assert.equal(health.rubric_version, fullCliRun.rubric_version);
  // The two skipped (null-band) axes must be omitted; the five scored ones kept.
  assert.deepEqual(Object.keys(health.dimensions).sort(), [
    "boundaries",
    "contributor_friction",
    "docs_parity",
    "invariants",
    "modularity",
  ]);
});

test("synthetic run maps field-for-field to the contract shape", () => {
  const health = toContractCodebaseHealth(syntheticCli());
  assertContractValid(health, "synthetic fixture");
  assert.deepEqual(health, {
    schema_version: "1", // number → string
    rubric_version: "1.0.0",
    head_sha: "abc123def456abc123def456abc123def456abc1",
    score_pct: 55,
    status: "warn", // degraded → warn
    dimensions: {
      // null-band test_rigor omitted; band key stripped from the rest
      modularity: { passed: 1, total: 4 },
      invariants: { passed: 2, total: 2 },
    },
    failed_invariant_ids: ["file_size_gate", "OGR04.tier-coverage"],
    measured_at: "2026-07-30T00:00:00Z", // bare date widened to midnight UTC
  });
});

test("output carries exactly the 8 contract fields (closed object)", () => {
  const health = toContractCodebaseHealth(syntheticCli());
  assert.deepEqual(Object.keys(health).sort(), [...schema.$defs.codebaseHealth.required].sort());
});

test("status maps healthy→pass, degraded→warn, critical→fail; anything else throws", () => {
  for (const [cliStatus, contractStatus] of [
    ["healthy", "pass"],
    ["degraded", "warn"],
    ["critical", "fail"],
  ]) {
    const cli = syntheticCli();
    cli.status = cliStatus;
    assert.equal(toContractCodebaseHealth(cli).status, contractStatus);
  }
  const cli = syntheticCli();
  cli.status = "amber";
  assert.throws(() => toContractCodebaseHealth(cli), HealthMappingError);
});

test("a full ISO measured_at passes through unchanged", () => {
  const cli = syntheticCli();
  cli.measured_at = "2026-07-30T09:15:00.123Z";
  const health = toContractCodebaseHealth(cli);
  assert.equal(health.measured_at, "2026-07-30T09:15:00.123Z");
  assertContractValid(health, "full ISO measured_at");
});

test("error, never sparse: any incomplete or unmappable input throws HealthMappingError", () => {
  const cases = [
    ["not an object", () => null],
    ...[
      "schema_version",
      "rubric_version",
      "head_sha",
      "score_pct",
      "status",
      "axes",
      "failed_invariant_ids",
      "measured_at",
    ].map((field) => [
      `missing ${field}`,
      () => {
        const cli = syntheticCli();
        delete cli[field];
        return cli;
      },
    ]),
    ["null score_pct (unscored run)", () => ({ ...syntheticCli(), score_pct: null })],
    ["score_pct out of range", () => ({ ...syntheticCli(), score_pct: 101 })],
    ["head_sha = CLI 'unknown' fallback", () => ({ ...syntheticCli(), head_sha: "unknown" })],
    [
      "every axis skipped (dimensions would be empty)",
      () => ({ ...syntheticCli(), axes: { test_rigor: { band: null, passed: 0, total: 0 } } }),
    ],
    [
      "non-integer axis counters",
      () => ({ ...syntheticCli(), axes: { modularity: { band: 2, passed: 1.5, total: 4 } } }),
    ],
    [
      "path-like failed_invariant_id",
      () => ({ ...syntheticCli(), failed_invariant_ids: ["3-log/decision-log.md"] }),
    ],
    ["garbage measured_at", () => ({ ...syntheticCli(), measured_at: "yesterday" })],
    ["empty rubric_version", () => ({ ...syntheticCli(), rubric_version: "" })],
    ["null schema_version", () => ({ ...syntheticCli(), schema_version: null })],
    ["object schema_version", () => ({ ...syntheticCli(), schema_version: {} })],
    ["non-finite schema_version", () => ({ ...syntheticCli(), schema_version: Infinity })],
  ];
  for (const [name, make] of cases) {
    assert.throws(() => toContractCodebaseHealth(make()), HealthMappingError, name);
  }
});

test("CLI entry runs when invoked via a RELATIVE script path (main-module guard)", () => {
  const out = execFileSync(
    process.execPath,
    ["scripts/codebase-health/push-payload.mjs", "test/fixtures/codebase-health/cli-run.v1.json"],
    { cwd: ROOT, encoding: "utf8" }
  );
  const health = JSON.parse(out);
  assert.equal(health.head_sha, fullCliRun.head_sha);
  assertContractValid(health, "relative-path CLI invocation");
});

test("mapper is pure: the input object is never mutated", () => {
  const cli = syntheticCli();
  const before = structuredClone(cli);
  toContractCodebaseHealth(cli);
  assert.deepEqual(cli, before);
});
