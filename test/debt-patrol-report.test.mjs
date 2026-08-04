import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { buildPatrolReport } from "../scripts/debt-patrol/report.mjs";
import { stableDigest } from "../scripts/debt-patrol/policy.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(
  readFileSync(path.join(ROOT, "docs/contract/debt-patrol-report-v1.schema.json"), "utf8")
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
const REPORT_SCRIPT = path.join(ROOT, "scripts/debt-patrol/report.mjs");
const SHA = "a".repeat(40);
const FINDING = "f".repeat(64);

function decision(provisional = false) {
  return {
    repository: "aiosbrain/aios-workspace",
    slug: "aios-workspace",
    default_branch: "main",
    resolved_sha: SHA,
    schedule_name: provisional ? "manual" : "daily",
    provisional,
    decision: "run",
    reason_codes: [],
    budget_minutes: 30,
    open_pr_cap: 12,
    observed_open_pr_count: 6,
    decision_fingerprint: "d".repeat(64),
  };
}

const revalidation = {
  decision: "run",
  exact_head: true,
  observed_sha: SHA,
  reason_codes: [],
};
const health = {
  schema_version: "2",
  rubric_version: "1.1.0",
  profile_id: "aios.workspace",
  profile_version: "1.0.0",
  head_sha: SHA,
  measured_at: "2026-08-04T12:03:00.000Z",
  score_pct: 75,
  status: "warn",
  evidence_status: "complete",
  quality_gate: "pass",
  automation_eligible: true,
  findings: [
    {
      fingerprint: FINDING,
      check_id: "lint",
      axis: "lint_type",
      kind: "quality_issue",
      severity: "medium",
      evidence_status: "complete",
      remediation_tier: 0,
      path: "src/private.ts",
      source: "must never survive redaction",
    },
  ],
};
const run = {
  id: "12345",
  attempt: 1,
  event_name: "schedule",
  policy_version: "1.0.0",
};

test("trusted scheduled report validates and keeps only redacted finding metadata", () => {
  const report = buildPatrolReport({
    decision: decision(),
    revalidation,
    health,
    delivery: "succeeded",
    run,
    generated_at: "2026-08-04T12:04:00.000Z",
  });
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(report.run.calibration_eligible, true);
  assert.equal(report.run.automatic_filing_eligible, false);
  assert.equal(report.findings.length, 1);
  assert.deepEqual(Object.keys(report.findings[0]).sort(), [
    "axis",
    "check_id",
    "evidence_status",
    "fingerprint",
    "kind",
    "remediation_tier",
    "severity",
  ]);
  assert.doesNotMatch(JSON.stringify(report), /src\/private|must never survive/);
  assert.deepEqual(report.capabilities, {
    source_write: false,
    pull_request_write: false,
    linear_write: false,
    auto_merge: false,
  });
  const { report_fingerprint: fingerprint, ...unsigned } = report;
  assert.equal(fingerprint, stableDigest(unsigned));
});

test("manual reports remain provisional and never count toward filing or calibration", () => {
  const report = buildPatrolReport({
    decision: decision(true),
    revalidation,
    health,
    delivery: "succeeded",
    run: { ...run, event_name: "workflow_dispatch" },
    generated_at: "2026-08-04T12:04:00.000Z",
  });
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(report.run.provisional, true);
  assert.equal(report.run.calibration_eligible, false);
  assert.equal(report.run.automatic_filing_eligible, false);
});

test("moving-head or failed-delivery evidence is an auditable stopped report", () => {
  const report = buildPatrolReport({
    decision: decision(),
    revalidation: {
      decision: "stop",
      exact_head: false,
      observed_sha: "b".repeat(40),
      reason_codes: ["moving_head_detected"],
    },
    health,
    delivery: "skipped",
    run,
    generated_at: "2026-08-04T12:04:00.000Z",
  });
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(report.policy.decision, "stop");
  assert.ok(report.policy.reason_codes.includes("moving_head_detected"));
  assert.ok(report.policy.reason_codes.includes("brain_delivery_skipped"));
  assert.equal(report.run.calibration_eligible, false);
});

test("missing health remains explicit and cannot become trusted", () => {
  const report = buildPatrolReport({
    decision: decision(),
    revalidation,
    health: null,
    delivery: "skipped",
    run,
    generated_at: "2026-08-04T12:04:00.000Z",
  });
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(report.evidence, null);
  assert.ok(report.policy.reason_codes.includes("health_artifact_missing"));
  assert.equal(report.run.calibration_eligible, false);
});

test("finding-set fingerprint is stable across run metadata", () => {
  const first = buildPatrolReport({
    decision: decision(),
    revalidation,
    health,
    delivery: "succeeded",
    run,
    generated_at: "2026-08-04T12:04:00.000Z",
  });
  const second = buildPatrolReport({
    decision: decision(),
    revalidation,
    health,
    delivery: "succeeded",
    run: { ...run, id: "67890", attempt: 2 },
    generated_at: "2026-08-05T12:04:00.000Z",
  });
  assert.equal(first.finding_set_fingerprint, second.finding_set_fingerprint);
  assert.equal(first.findings[0].fingerprint, second.findings[0].fingerprint);
});

test("malformed and excess findings produce a bounded stopped report", () => {
  const findings = Array.from({ length: 501 }, (_, index) => ({
    ...health.findings[0],
    fingerprint: index.toString(16).padStart(64, "0"),
  }));
  findings.push({ ...health.findings[0], fingerprint: null });
  const report = buildPatrolReport({
    decision: decision(),
    revalidation,
    health: { ...health, findings },
    delivery: "succeeded",
    run,
    generated_at: "2026-08-04T12:04:00.000Z",
  });
  assert.equal(validate(report), true, JSON.stringify(validate.errors));
  assert.equal(report.findings.length, 500);
  assert.equal(report.policy.decision, "stop");
  assert.ok(report.policy.reason_codes.includes("health_findings_invalid"));
  assert.ok(report.policy.reason_codes.includes("health_findings_truncated"));
});

test("report CLI reads bounded inputs and writes a schema-valid redacted artifact", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "debt-patrol-report-cli-"));
  const revalidationPath = path.join(dir, "revalidation.json");
  const healthPath = path.join(dir, "health.json");
  const outputPath = path.join(dir, "report.json");
  writeFileSync(revalidationPath, `${JSON.stringify(revalidation)}\n`);
  writeFileSync(healthPath, `${JSON.stringify(health)}\n`);
  try {
    const result = spawnSync(
      process.execPath,
      [
        REPORT_SCRIPT,
        "--decision-env",
        "PATROL_DECISION_FIXTURE",
        "--revalidation",
        revalidationPath,
        "--health",
        healthPath,
        "--delivery",
        "succeeded",
        "--run-id",
        "12345",
        "--run-attempt",
        "1",
        "--event",
        "schedule",
        "--policy-version",
        "1.0.0",
        "--output",
        outputPath,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, PATROL_DECISION_FIXTURE: JSON.stringify(decision()) },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(validate(report), true, JSON.stringify(validate.errors));
    assert.doesNotMatch(JSON.stringify(report), /src\/private|must never survive/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
