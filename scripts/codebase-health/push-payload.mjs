/**
 * push-payload.mjs — pure mapper from the codebase-health CLI JSON v1/v2 object
 * (`aios codebase-health --json`, scripts/codebase-health.mjs#toHealthJson) to the
 * Brain API `metrics.codebase_health` contract object. V1 is pinned in
 * docs/contract/codebase-payload-1.15.schema.json; v2 in codebase-health-v2.schema.json.
 *
 * Contract stance: the health object is CLOSED and every field is required, so this
 * mapper FAILS (throws) rather than ever emitting a partial object — a sparse or
 * incomplete `codebase_health` would 422 at the brain (and a health-only payload is
 * forbidden anyway: the metrics upsert REPLACES the (codebase_id, head_sha) row).
 * The caller (scan-on-merge.yml) attaches the mapped object to the one FULL-metrics
 * scan payload; on any mapping error it must push the base payload without health.
 *
 * Field mapping (CLI v1 → contract):
 *   schema_version   number|string → string (contract requires a string)
 *   rubric_version   passthrough
 *   head_sha         passthrough (must be 7–40 hex; the CLI's "unknown" fallback throws)
 *   score_pct        passthrough; a null (unscored) run throws — never guessed
 *   status           healthy→pass, degraded→warn, critical→fail
 *   axes             → dimensions {passed,total}; a null-band (skipped) axis is OMITTED
 *   failed_invariant_ids  passthrough (short rubric ids only — path-like ids throw)
 *   measured_at      full ISO passthrough; the CLI's bare date (deliberate day-level
 *                    redaction) widens to midnight UTC (YYYY-MM-DDT00:00:00Z)
 *
 * Zero dependencies; pure (no clock, no fs, no git) so tests are deterministic.
 */

import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATUS_MAP = { healthy: "pass", degraded: "warn", critical: "fail" };
const SHA_RE = /^[0-9a-f]{7,40}$/;
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const INVARIANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIMENSION_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REQUIRED_CLI_FIELDS = [
  "schema_version",
  "rubric_version",
  "head_sha",
  "score_pct",
  "status",
  "axes",
  "failed_invariant_ids",
  "measured_at",
];
const REQUIRED_V2_FIELDS = [
  "profile_id",
  "profile_version",
  "evidence_status",
  "quality_gate",
  "automation_eligible",
  "findings",
];
const EVIDENCE_STATES = new Set(["complete", "partial", "missing", "stale", "error"]);
const QUALITY_GATES = new Set(["pass", "fail", "unknown"]);
const FINDING_KIND = new Set(["quality_issue", "evidence_gap"]);
const FINDING_SEVERITY = new Set(["low", "medium", "high", "critical"]);

/** Thrown on any input that cannot map to a COMPLETE contract object. */
export class HealthMappingError extends Error {}

function fail(msg) {
  throw new HealthMappingError(
    `codebase_health mapping: ${msg} — refusing to emit a partial contract object ` +
      "(the Brain API contract requires a complete health object; push the base payload without health instead)"
  );
}

function mapMeasuredAt(raw) {
  if (typeof raw !== "string") fail(`measured_at must be a string, got ${typeof raw}`);
  if (DATETIME_RE.test(raw)) return raw;
  if (BARE_DATE_RE.test(raw)) return `${raw}T00:00:00Z`; // CLI's day-precision reading
  return fail(`measured_at "${raw}" is neither a bare date nor an ISO datetime`);
}

function mapDimension(key, axis, schemaVersion) {
  if (!DIMENSION_KEY_RE.test(key)) fail(`axis key "${key}" violates the dimension-name pattern`);
  if (typeof axis !== "object" || axis === null) fail(`axis "${key}" must be an object`);
  if ((axis.band === null || axis.band === undefined) && schemaVersion !== "2") return null;
  for (const field of ["passed", "total"]) {
    if (!Number.isInteger(axis[field]) || axis[field] < 0) {
      fail(`axis "${key}".${field} must be a non-negative integer, got ${axis[field]}`);
    }
  }
  const dimension = { passed: axis.passed, total: axis.total };
  if (schemaVersion !== "2") return dimension;
  if (axis.band !== null && (!Number.isInteger(axis.band) || axis.band < 0 || axis.band > 4)) {
    fail(`axis "${key}".band must be null or an integer in [0,4]`);
  }
  if (!EVIDENCE_STATES.has(axis.evidence_status)) {
    fail(`axis "${key}".evidence_status is invalid`);
  }
  dimension.band = axis.band ?? null;
  dimension.evidence_status = axis.evidence_status;
  return dimension;
}

function mapDimensions(axes, schemaVersion) {
  if (typeof axes !== "object" || axes === null || Array.isArray(axes)) {
    fail("axes must be an object map");
  }
  const dimensions = {};
  for (const [key, axis] of Object.entries(axes)) {
    const dimension = mapDimension(key, axis, schemaVersion);
    if (dimension) dimensions[key] = dimension;
  }
  if (Object.keys(dimensions).length === 0) {
    fail("every axis was skipped (null band) — the contract requires at least one dimension");
  }
  return dimensions;
}

function mapFindings(findings) {
  if (!Array.isArray(findings) || findings.length > 500) {
    fail("findings must be an array with at most 500 entries");
  }
  return findings.map((finding, index) => {
    if (typeof finding !== "object" || finding === null || Array.isArray(finding)) {
      fail(`findings[${index}] must be an object`);
    }
    if (!/^[0-9a-f]{64}$/.test(finding.fingerprint))
      fail(`findings[${index}].fingerprint is invalid`);
    if (!INVARIANT_ID_RE.test(finding.check_id)) fail(`findings[${index}].check_id is invalid`);
    if (!DIMENSION_KEY_RE.test(finding.axis)) fail(`findings[${index}].axis is invalid`);
    if (!FINDING_KIND.has(finding.kind)) fail(`findings[${index}].kind is invalid`);
    if (!FINDING_SEVERITY.has(finding.severity)) fail(`findings[${index}].severity is invalid`);
    if (!EVIDENCE_STATES.has(finding.evidence_status)) {
      fail(`findings[${index}].evidence_status is invalid`);
    }
    if (
      !Number.isInteger(finding.remediation_tier) ||
      finding.remediation_tier < 0 ||
      finding.remediation_tier > 3
    ) {
      fail(`findings[${index}].remediation_tier must be an integer in [0,3]`);
    }
    return {
      fingerprint: finding.fingerprint,
      check_id: finding.check_id,
      axis: finding.axis,
      kind: finding.kind,
      severity: finding.severity,
      evidence_status: finding.evidence_status,
      remediation_tier: finding.remediation_tier,
    };
  });
}

// schema_version: only a string or FINITE number may stringify (String(null) → "null" and
// String({}) → "[object Object]" would smuggle malformed versions past the contract).
function mapSchemaVersion(sv) {
  if (typeof sv !== "string" && !(typeof sv === "number" && Number.isFinite(sv))) {
    fail(
      `schema_version must be a string or finite number, got ${sv === null ? "null" : typeof sv}`
    );
  }
  const schemaVersion = String(sv);
  if (schemaVersion.length < 1 || schemaVersion.length > 20) {
    fail(`schema_version "${schemaVersion}" is out of the contract's 1–20 char bounds`);
  }
  return schemaVersion;
}

function mapStatus(raw) {
  const status = STATUS_MAP[raw];
  if (!status) fail(`status "${raw}" is not one of ${Object.keys(STATUS_MAP).join("/")}`);
  return status;
}

function mapFailedInvariantIds(ids) {
  if (!Array.isArray(ids)) fail("failed_invariant_ids must be an array");
  if (ids.length > 200) fail("failed_invariant_ids exceeds 200 items");
  for (const id of ids) {
    if (typeof id !== "string" || !INVARIANT_ID_RE.test(id)) {
      fail(`failed_invariant_ids entry "${id}" is not a short rubric id (paths are forbidden)`);
    }
  }
  return [...ids];
}

function validateV2Admission(cli) {
  if (!EVIDENCE_STATES.has(cli.evidence_status)) fail("evidence_status is invalid");
  if (!QUALITY_GATES.has(cli.quality_gate)) fail("quality_gate is invalid");
  if (typeof cli.automation_eligible !== "boolean") fail("automation_eligible must be boolean");
  if (cli.quality_gate === "pass" && cli.evidence_status !== "complete") {
    fail("quality_gate pass requires complete evidence");
  }
  if (cli.quality_gate === "unknown" && cli.evidence_status === "complete") {
    fail("quality_gate unknown cannot claim complete evidence");
  }
  if (!cli.automation_eligible) return;
  const safeToAutomate =
    cli.quality_gate === "pass" && cli.evidence_status === "complete" && cli.status !== "critical";
  if (!safeToAutomate) {
    fail(
      "automation_eligible requires a non-critical status, complete evidence, and a passing gate"
    );
  }
}

function validateV2Metadata(cli) {
  for (const field of ["profile_id", "profile_version"]) {
    if (typeof cli[field] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(cli[field])) {
      fail(`${field} must be a short stable identifier`);
    }
  }
  validateV2Admission(cli);
}

/**
 * Map one CLI JSON v1 or v2 object to the contract `codebase_health` object.
 * @param {object} cli  parsed output of `aios codebase-health --json`
 * @returns {object} complete contract-shaped object for the requested schema version
 * @throws {HealthMappingError} on any input that cannot produce a complete object
 */
export function toContractCodebaseHealth(cli) {
  if (typeof cli !== "object" || cli === null || Array.isArray(cli)) {
    fail("input must be the CLI JSON v1 object");
  }
  const missing = REQUIRED_CLI_FIELDS.filter((f) => cli[f] === undefined);
  if (missing.length) fail(`input is missing field(s): ${missing.join(", ")}`);
  const schemaVersion = mapSchemaVersion(cli.schema_version);
  if (!["1", "1.0", "2"].includes(schemaVersion)) {
    fail(`unsupported schema_version "${schemaVersion}"`);
  }
  if (schemaVersion === "2") {
    const missingV2 = REQUIRED_V2_FIELDS.filter((field) => cli[field] === undefined);
    if (missingV2.length) fail(`v2 input is missing field(s): ${missingV2.join(", ")}`);
  }

  if (typeof cli.rubric_version !== "string" || !cli.rubric_version) {
    fail("rubric_version must be a non-empty string");
  }
  if (typeof cli.head_sha !== "string" || !SHA_RE.test(cli.head_sha)) {
    fail(`head_sha "${cli.head_sha}" is not 7–40 lowercase hex`);
  }
  if (typeof cli.score_pct !== "number" || cli.score_pct < 0 || cli.score_pct > 100) {
    fail(`score_pct must be a number in [0,100], got ${cli.score_pct} (null = unscored run)`);
  }

  const mapped = {
    schema_version: schemaVersion,
    rubric_version: cli.rubric_version,
    head_sha: cli.head_sha,
    score_pct: cli.score_pct,
    status: mapStatus(cli.status),
    dimensions: mapDimensions(cli.axes, schemaVersion),
    failed_invariant_ids: mapFailedInvariantIds(cli.failed_invariant_ids),
    measured_at: mapMeasuredAt(cli.measured_at),
  };
  if (schemaVersion !== "2") return mapped;

  validateV2Metadata(cli);

  return {
    ...mapped,
    profile_id: cli.profile_id,
    profile_version: cli.profile_version,
    evidence_status: cli.evidence_status,
    quality_gate: cli.quality_gate,
    automation_eligible: cli.automation_eligible,
    findings: mapFindings(cli.findings),
  };
}

// CLI: node scripts/codebase-health/push-payload.mjs <cli-json-file>
// Prints the contract object on stdout; exits 1 (with the reason on stderr) on any
// mapping failure so the workflow falls back to pushing the base payload.
// Main-module detection realpaths BOTH sides: process.argv[1] may be relative to the
// caller's cwd and either side may sit behind a symlink (e.g. a linked worktree).
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(process.argv[1]))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const file = process.argv[2];
    if (!file) throw new HealthMappingError("usage: push-payload.mjs <codebase-health-json-file>");
    const cli = JSON.parse(readFileSync(file, "utf8"));
    process.stdout.write(`${JSON.stringify(toContractCodebaseHealth(cli), null, 2)}\n`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
