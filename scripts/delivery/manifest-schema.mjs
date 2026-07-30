/**
 * delivery/manifest-schema.mjs — pure schema validation for the durable split-delivery manifest
 * `.aios/delivery/split-manifest.json` (AIO-595, epic AIO-594: the multi-repo split program).
 *
 * Zero-dep plain functions over already-parsed JSON, in the same style as delivery/reconcile.mjs:
 * no subprocess/network/filesystem calls here (IO lives in delivery/manifest.mjs), so every rule
 * is exhaustively unit-testable with fixtures. The canonical instance this schema must accept is
 * the live AIO-594 program manifest (fixture: test/fixtures/delivery/split-manifest.canonical.json).
 *
 * Authority note (mirrors the manifest's own `authority` field): the manifest is evidence + state.
 * `verdict_log` entries are written ONLY by humans editing the file — no tool in this repo may
 * merge, delete, push, or record a verdict on the program's behalf. This module validates; it
 * never decides.
 */

export const SPLIT_MANIFEST_SCHEMA_VERSION = 1;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

/** `null` or a non-empty string (e.g. a not-yet-known SHA that a later human edit fills in). */
function isNullableString(v) {
  return v === null || isNonEmptyString(v);
}

function requireString(errors, obj, key, prefix = "") {
  if (!isNonEmptyString(obj[key])) errors.push(`${prefix}${key}: expected a non-empty string`);
}

function requireArray(errors, obj, key, prefix = "") {
  if (!Array.isArray(obj[key])) errors.push(`${prefix}${key}: expected an array`);
}

function requireObject(errors, obj, key, prefix = "") {
  if (!isPlainObject(obj[key])) errors.push(`${prefix}${key}: expected an object`);
}

/**
 * One verdict entry — used both for the top-level `verdict_log` and each cut's `verdicts`.
 * Human-authored only; the schema still insists every recorded verdict names its gate, decision,
 * actor, timestamp, and evidence so the log stays auditable.
 *
 * @param {unknown} entry
 * @param {string} where  error prefix, e.g. "verdict_log[0]."
 * @returns {string[]}
 */
export function validateVerdictEntry(entry, where) {
  const errors = [];
  if (!isPlainObject(entry)) return [`${where.replace(/\.$/, "")}: expected an object`];
  requireString(errors, entry, "gate", where);
  requireString(errors, entry, "decision", where);
  requireString(errors, entry, "actor", where);
  if (!isNonEmptyString(entry.decided_at) || Number.isNaN(Date.parse(entry.decided_at))) {
    errors.push(`${where}decided_at: expected an ISO-8601 timestamp string`);
  }
  if (!Array.isArray(entry.evidence_refs)) {
    errors.push(`${where}evidence_refs: expected an array`);
  } else {
    entry.evidence_refs.forEach((ref, i) => {
      if (!isNonEmptyString(ref)) {
        errors.push(`${where}evidence_refs[${i}]: expected a non-empty string`);
      }
    });
  }
  return errors;
}

function validateBaseline(baseline, errors) {
  const p = "baseline.";
  requireString(errors, baseline, "source_repo", p);
  if (!isNonEmptyString(baseline.source_sha) || !/^[0-9a-f]{7,40}$/.test(baseline.source_sha)) {
    errors.push(`${p}source_sha: expected a 7–40 char lowercase hex commit SHA`);
  }
  requireObject(errors, baseline, "ci_evidence", p);
  requireArray(errors, baseline, "open_prs", p);
  if (Array.isArray(baseline.open_prs)) {
    baseline.open_prs.forEach((pr, i) => {
      if (!isPlainObject(pr)) errors.push(`${p}open_prs[${i}]: expected an object`);
    });
  }
  requireArray(errors, baseline, "worktrees", p);
  if (Array.isArray(baseline.worktrees)) {
    baseline.worktrees.forEach((wt, i) => {
      if (!isPlainObject(wt)) errors.push(`${p}worktrees[${i}]: expected an object`);
    });
  }
  requireObject(errors, baseline, "tools", p);
  requireString(errors, baseline, "gates_on_baseline", p);
}

function validateBlockingAsks(asks, errors) {
  asks.forEach((ask, i) => {
    const p = `blocking_asks[${i}].`;
    if (!isPlainObject(ask)) {
      errors.push(`blocking_asks[${i}]: expected an object`);
      return;
    }
    for (const key of ["id", "status", "owner", "detail"]) requireString(errors, ask, key, p);
  });
}

// Keys a cut must carry even before the cut starts — `null` is the explicit "not yet" value,
// which is different from the key being absent (absent = the manifest author forgot the field).
const CUT_NULLABLE_EVIDENCE_KEYS = ["rehearsal", "parity", "fresh_clone_ci"];

function validateCut(name, cut, errors) {
  const p = `cuts.${name}.`;
  if (!isPlainObject(cut)) {
    errors.push(`cuts.${name}: expected an object`);
    return;
  }
  requireString(errors, cut, "state", p);
  requireString(errors, cut, "target_repo", p);
  for (const key of ["paths_manifest_sha", "frozen_sha"]) {
    if (!(key in cut) || !isNullableString(cut[key])) {
      errors.push(`${p}${key}: expected a non-empty string or null (key required)`);
    }
  }
  requireArray(errors, cut, "prerequisite_prs", p);
  for (const key of CUT_NULLABLE_EVIDENCE_KEYS) {
    if (!(key in cut)) errors.push(`${p}${key}: key required (use null when not yet produced)`);
  }
  // Optional blocks: only some cuts publish a package / define a smoke test.
  if ("package" in cut && cut.package !== null) {
    if (!isPlainObject(cut.package)) {
      errors.push(`${p}package: expected an object or null`);
    } else {
      requireString(errors, cut.package, "name", `${p}package.`);
    }
  }
  if (!Array.isArray(cut.verdicts)) {
    errors.push(`${p}verdicts: expected an array`);
  } else {
    cut.verdicts.forEach((v, i) => errors.push(...validateVerdictEntry(v, `${p}verdicts[${i}].`)));
  }
}

/**
 * Validate a parsed split-delivery manifest. Pure: returns the full list of error strings
 * (empty array = valid); never throws, never mutates `data`.
 *
 * @param {unknown} data  the JSON.parse'd candidate manifest
 * @returns {string[]}
 */
export function validateSplitManifest(data) {
  if (!isPlainObject(data)) return ["manifest: expected a JSON object"];
  const errors = [];

  if (!("schema_version" in data)) {
    errors.push("schema_version: required");
  } else if (data.schema_version !== SPLIT_MANIFEST_SCHEMA_VERSION) {
    errors.push(
      `schema_version: expected ${SPLIT_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(
        data.schema_version
      )}`
    );
  }

  requireString(errors, data, "program");
  requireString(errors, data, "authority");

  requireObject(errors, data, "baseline");
  if (isPlainObject(data.baseline)) validateBaseline(data.baseline, errors);

  requireArray(errors, data, "blocking_asks");
  if (Array.isArray(data.blocking_asks)) validateBlockingAsks(data.blocking_asks, errors);

  requireObject(errors, data, "cuts");
  if (isPlainObject(data.cuts)) {
    for (const [name, cut] of Object.entries(data.cuts)) validateCut(name, cut, errors);
  }

  requireArray(errors, data, "unresolved_constraints");
  if (Array.isArray(data.unresolved_constraints)) {
    data.unresolved_constraints.forEach((s, i) => {
      if (!isNonEmptyString(s)) errors.push(`unresolved_constraints[${i}]: expected a non-empty string`);
    });
  }

  requireObject(errors, data, "rollback");
  if (isPlainObject(data.rollback)) {
    for (const [key, value] of Object.entries(data.rollback)) {
      if (!isNonEmptyString(value)) errors.push(`rollback.${key}: expected a non-empty string`);
    }
  }

  requireArray(errors, data, "deletion_prs");

  requireArray(errors, data, "verdict_log");
  if (Array.isArray(data.verdict_log)) {
    data.verdict_log.forEach((v, i) =>
      errors.push(...validateVerdictEntry(v, `verdict_log[${i}].`))
    );
  }

  return errors;
}
