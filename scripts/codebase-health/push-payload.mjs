/**
 * push-payload.mjs — pure mapper from the codebase-health CLI JSON v1 object
 * (`aios codebase-health --json`, scripts/codebase-health.mjs#toHealthJson) to the
 * Brain API 1.15 `metrics.codebase_health` contract object
 * (docs/contract/codebase-payload-1.15.schema.json → $defs.codebaseHealth). AIO-608.
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

import { readFileSync } from "node:fs";
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

/** Thrown on any input that cannot map to a COMPLETE contract object. */
export class HealthMappingError extends Error {}

function fail(msg) {
  throw new HealthMappingError(
    `codebase_health mapping: ${msg} — refusing to emit a partial contract object ` +
      "(the 1.15 contract requires all 8 fields; push the base payload without health instead)"
  );
}

function mapMeasuredAt(raw) {
  if (typeof raw !== "string") fail(`measured_at must be a string, got ${typeof raw}`);
  if (DATETIME_RE.test(raw)) return raw;
  if (BARE_DATE_RE.test(raw)) return `${raw}T00:00:00Z`; // CLI's day-precision reading
  return fail(`measured_at "${raw}" is neither a bare date nor an ISO datetime`);
}

function mapDimensions(axes) {
  if (typeof axes !== "object" || axes === null || Array.isArray(axes)) {
    fail("axes must be an object map");
  }
  const dimensions = {};
  for (const [key, axis] of Object.entries(axes)) {
    if (!DIMENSION_KEY_RE.test(key)) fail(`axis key "${key}" violates the dimension-name pattern`);
    if (typeof axis !== "object" || axis === null) fail(`axis "${key}" must be an object`);
    if (axis.band === null || axis.band === undefined) continue; // skipped axis → omit
    for (const field of ["passed", "total"]) {
      if (!Number.isInteger(axis[field]) || axis[field] < 0) {
        fail(`axis "${key}".${field} must be a non-negative integer, got ${axis[field]}`);
      }
    }
    dimensions[key] = { passed: axis.passed, total: axis.total };
  }
  if (Object.keys(dimensions).length === 0) {
    fail("every axis was skipped (null band) — the contract requires at least one dimension");
  }
  return dimensions;
}

/**
 * Map one CLI JSON v1 object to the contract `codebase_health` object.
 * @param {object} cli  parsed output of `aios codebase-health --json`
 * @returns {object} contract-shaped object (exactly the 8 required fields)
 * @throws {HealthMappingError} on any input that cannot produce a complete object
 */
export function toContractCodebaseHealth(cli) {
  if (typeof cli !== "object" || cli === null || Array.isArray(cli)) {
    fail("input must be the CLI JSON v1 object");
  }
  const missing = REQUIRED_CLI_FIELDS.filter((f) => cli[f] === undefined);
  if (missing.length) fail(`input is missing field(s): ${missing.join(", ")}`);

  const schemaVersion = String(cli.schema_version);
  if (schemaVersion.length < 1 || schemaVersion.length > 20) {
    fail(`schema_version "${schemaVersion}" is out of the contract's 1–20 char bounds`);
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
  const status = STATUS_MAP[cli.status];
  if (!status) fail(`status "${cli.status}" is not one of ${Object.keys(STATUS_MAP).join("/")}`);
  if (!Array.isArray(cli.failed_invariant_ids)) fail("failed_invariant_ids must be an array");
  if (cli.failed_invariant_ids.length > 200) fail("failed_invariant_ids exceeds 200 items");
  for (const id of cli.failed_invariant_ids) {
    if (typeof id !== "string" || !INVARIANT_ID_RE.test(id)) {
      fail(`failed_invariant_ids entry "${id}" is not a short rubric id (paths are forbidden)`);
    }
  }

  return {
    schema_version: schemaVersion,
    rubric_version: cli.rubric_version,
    head_sha: cli.head_sha,
    score_pct: cli.score_pct,
    status,
    dimensions: mapDimensions(cli.axes),
    failed_invariant_ids: [...cli.failed_invariant_ids],
    measured_at: mapMeasuredAt(cli.measured_at),
  };
}

// CLI: node scripts/codebase-health/push-payload.mjs <cli-json-file>
// Prints the contract object on stdout; exits 1 (with the reason on stderr) on any
// mapping failure so the workflow falls back to pushing the base payload.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
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
