/**
 * codebase-health.mjs — composed, READ-ONLY codebase-health scorer (AIO-605; spec:
 * docs/v1-operator-loop/domains/codebase-health.md).
 *
 * Codebase health = structural maintainability + invariant compliance of the CODE
 * (module size/coupling, seam + domain isolation, test rigor, lint/type debt,
 * docs↔code drift, invariant compliance, inherited ratchet debt). It COMPOSES the
 * repo's existing deterministic gates (scripts/codebase-health/checks.mjs) and maps
 * their scalar outputs onto validation/codebase-health.rubric.json — seven axes,
 * 0–4 bands, every threshold in rubric DATA, never in this code.
 *
 * Deliberately NEITHER of the two adjacent scorers:
 *   - agent-readiness (validation/agent-readiness.rubric.json) scores the scaffolding
 *     AROUND the code (README/CI/config existence);
 *   - context-health (scripts/context-health.mjs) scores the agent-facing DOC layer.
 *
 * Redaction invariant (hard): the JSON v1 object (`toHealthJson`) carries scalars
 * only — no source text, no filenames/paths, no contributor identity, no raw
 * evidence. file:line evidence exists only in local text mode (`detail` strings).
 *
 * Export shape mirrors scripts/context-health.mjs: computeCodebaseHealth /
 * renderCodebaseHealth / runCodebaseHealthCli. Zero dependencies.
 */

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateChecks } from "./codebase-health/checks.mjs";
import {
  axisBand,
  bandForValue,
  scorePct,
  statusFor,
  nextTargetBlockers,
  TARGETS,
} from "./codebase-health/banding.mjs";

export { bandForValue, axisBand, scorePct, statusFor, nextTargetBlockers, TARGETS };

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUBRIC_PATH = path.join(
  SELF_DIR,
  "..",
  "validation",
  "codebase-health.rubric.json"
);

const EVIDENCE_STATES = new Set(["complete", "partial", "missing", "stale", "error"]);

function defaultProfile(rubric) {
  return {
    id: "aios.codebase-health.default",
    version: "1.0.0",
    required_checks: [
      ...new Set([
        ...rubric.invariants,
        ...rubric.axes.map((axis) => axis.bandMetric).filter(Boolean),
      ]),
    ],
    stale_after_days: {},
  };
}

/** Load a repository capability profile. Repos without one retain the strict rubric-derived default. */
export function loadHealthProfile(repoPath, rubric, profilePath) {
  const candidate =
    profilePath ?? path.join(repoPath, "validation", "codebase-health.profile.json");
  let profile;
  try {
    profile = JSON.parse(readFileSync(candidate, "utf8"));
  } catch (error) {
    if (profilePath || error?.code !== "ENOENT") throw error;
    return defaultProfile(rubric);
  }
  const profileId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
  const staleAfterDays = profile.stale_after_days ?? {};
  if (
    !profileId.test(profile.id) ||
    !profileId.test(profile.version) ||
    !Array.isArray(profile.required_checks) ||
    profile.required_checks.length === 0 ||
    profile.required_checks.some((id) => typeof id !== "string") ||
    typeof staleAfterDays !== "object" ||
    staleAfterDays === null ||
    Array.isArray(staleAfterDays)
  ) {
    throw new Error(`codebase-health profile ${candidate} is missing id/version/required_checks`);
  }
  const known = new Set(Object.keys(rubric.checks));
  const unknown = profile.required_checks.filter((id) => !known.has(id));
  if (unknown.length)
    throw new Error(`codebase-health profile ${candidate} has unknown checks: ${unknown}`);
  for (const [id, days] of Object.entries(staleAfterDays)) {
    if (!known.has(id) || !Number.isFinite(days) || days < 0) {
      throw new Error(`codebase-health profile ${candidate} has invalid staleness for ${id}`);
    }
  }
  return { ...profile, stale_after_days: staleAfterDays };
}

function evidenceState(result, staleAfterDays) {
  const explicit = result.evidence_status;
  let state = "complete";
  if (EVIDENCE_STATES.has(explicit)) state = explicit;
  else if (result.value == null) state = "missing";
  if (state === "complete" && result.observed_at && Number.isFinite(staleAfterDays)) {
    const ageMs = Date.now() - Date.parse(result.observed_at);
    if (Number.isFinite(ageMs) && ageMs > staleAfterDays * 86_400_000) state = "stale";
  }
  return state;
}

function aggregateEvidence(requiredChecks) {
  if (requiredChecks.length === 0) return "missing";
  const states = requiredChecks.map((check) => check.evidence_status);
  if (states.every((state) => state === "complete")) return "complete";
  if (states.includes("error")) return "error";
  if (states.every((state) => state === "missing")) return "missing";
  if (states.includes("stale") && states.every((state) => ["complete", "stale"].includes(state))) {
    return "stale";
  }
  return "partial";
}

function findingFingerprint(rubric, profile, check) {
  return createHash("sha256")
    .update([rubric.id, rubric.version, profile.id, check.id].join("\0"))
    .digest("hex");
}

function findingsFor(rubric, profile, checks) {
  return checks
    .filter(
      (check) => (check.required && check.evidence_status !== "complete") || check.ok === false
    )
    .map((check) => ({
      fingerprint: findingFingerprint(rubric, profile, check),
      check_id: check.id,
      axis: check.axis,
      kind:
        check.required && check.evidence_status !== "complete" ? "evidence_gap" : "quality_issue",
      severity: rubric.invariants.includes(check.id) || check.required ? "high" : "medium",
      evidence_status: check.evidence_status,
      remediation_tier: 0,
    }));
}

function qualityGateFor(evidenceStatus, requiredFailure) {
  if (requiredFailure) return "fail";
  if (evidenceStatus === "complete") return "pass";
  return "unknown";
}

function healthSummary({ status, score, evidenceStatus, rubric, axes, skipped, failedInvariants }) {
  const scoreText = score === null ? "unscored" : `${score}%`;
  const scoredAxes = rubric.axes.filter((axis) => axes[axis.key].band !== null).length;
  const skippedText = skipped ? `, ${skipped} check(s) skipped` : "";
  const invariantText = failedInvariants.length
    ? ` · failing invariants: ${failedInvariants.join(", ")}`
    : "";
  return (
    `${status} — ${scoreText} · evidence ${evidenceStatus}` +
    ` (${scoredAxes}/${rubric.axes.length} axes scored${skippedText})${invariantText}`
  );
}

/** Load + minimally validate the rubric (throws on a malformed rubric — it is a contract). */
export function loadHealthRubric(rubricPath = DEFAULT_RUBRIC_PATH) {
  const rubric = JSON.parse(readFileSync(rubricPath, "utf8"));
  if (!Array.isArray(rubric.axes) || !rubric.checks || !Array.isArray(rubric.invariants)) {
    throw new Error(`codebase-health rubric ${rubricPath} is missing axes/checks/invariants`);
  }
  return rubric;
}

function headSha(repoPath) {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Apply the rubric's okWhen (thresholds-in-data) to a metric value. Null value → ok. */
function okFromRubric(spec, value) {
  if (value === null || value === undefined) return true;
  const ok = spec.okWhen ?? {};
  if (typeof ok.lte === "number") return value <= ok.lte;
  if (typeof ok.gte === "number") return value >= ok.gte;
  return true;
}

/**
 * Compute codebase health for `repoPath`.
 * @param {string} repoPath
 * @param {{mode?: "full"|"cheap", rubricPath?: string, profilePath?: string}} opts
 *   mode "cheap" (the analyze shadow-card path) skips the expensive evaluators
 *   (eslint, tsc, gh, graph metrics) — those checks report null (skipped).
 */
export async function computeCodebaseHealth(repoPath, opts = {}) {
  const mode = opts.mode ?? "full";
  const rubric = loadHealthRubric(opts.rubricPath);
  const profile = loadHealthProfile(repoPath, rubric, opts.profilePath);
  const evaluated = await evaluateChecks(repoPath, rubric, { mode });
  const requiredIds = new Set(profile.required_checks);

  const checks = [];
  for (const [id, spec] of Object.entries(rubric.checks)) {
    if (id === "invariant_gate_failures") continue; // derived below
    const r = evaluated.get(id) ?? {
      value: null,
      detail: "not evaluated (skipped)",
      evidence_status: "missing",
    };
    const ok =
      spec.kind === "gate"
        ? r.value === null
          ? true
          : Boolean(r.ok)
        : okFromRubric(spec, r.value);
    checks.push({
      id,
      axis: spec.axis,
      title: spec.title,
      ok,
      value: r.value ?? null,
      detail: r.detail,
      required: requiredIds.has(id),
      evidence_status: evidenceState(r, profile.stale_after_days[id]),
    });
  }

  // Derived: how many of the rubric's enumerated invariant gates FAILED (skipped gates
  // are not failures; if every enumerated gate skipped, the metric itself is skipped).
  const enumerated = rubric.invariants.map((id) => checks.find((c) => c.id === id)).filter(Boolean);
  const live = enumerated.filter((c) => c.value !== null);
  const failedInvariants = live.filter((c) => c.ok === false).map((c) => c.id);
  {
    const spec = rubric.checks.invariant_gate_failures;
    const value = live.length === 0 ? null : failedInvariants.length;
    checks.push({
      id: "invariant_gate_failures",
      axis: spec.axis,
      title: spec.title,
      ok: okFromRubric(spec, value),
      value,
      detail:
        value === null
          ? "no enumerated invariant gate ran (skipped)"
          : value === 0
            ? `all ${live.length} enumerated invariant gate(s) pass`
            : `failing: ${failedInvariants.join(", ")}`,
      required: requiredIds.has("invariant_gate_failures"),
      evidence_status: live.length === 0 ? "missing" : "complete",
    });
  }

  const axes = {};
  for (const axis of rubric.axes) {
    const axisChecks = checks.filter((c) => c.axis === axis.key);
    const liveChecks = axisChecks.filter((c) => c.value !== null);
    const requiredAxisChecks = axisChecks.filter((c) => c.required);
    axes[axis.key] = {
      band: axisBand(axis, rubric, axisChecks),
      passed: liveChecks.filter((c) => c.ok).length,
      total: liveChecks.length,
      evidence_status: aggregateEvidence(
        requiredAxisChecks.length > 0 ? requiredAxisChecks : axisChecks
      ),
    };
  }

  const score = scorePct(axes, rubric);
  const status = statusFor(score, rubric);
  const requiredChecks = checks.filter((check) => check.required);
  const evidence_status = aggregateEvidence(requiredChecks);
  const requiredFailure = requiredChecks.some(
    (check) => check.evidence_status === "complete" && check.ok === false
  );
  const quality_gate = qualityGateFor(evidence_status, requiredFailure);
  const automation_eligible = mode === "full" && quality_gate === "pass" && status !== "critical";
  const findings = findingsFor(rubric, profile, checks);
  const skipped = checks.filter((c) => c.value === null).length;
  const summary = healthSummary({
    status,
    score,
    evidenceStatus: evidence_status,
    rubric,
    axes,
    skipped,
    failedInvariants,
  });

  return {
    rubric_id: rubric.id,
    rubric_version: rubric.version,
    profile_id: profile.id,
    profile_version: profile.version,
    mode,
    checks,
    axes,
    score_pct: score,
    status,
    evidence_status,
    quality_gate,
    automation_eligible,
    findings,
    failed_invariant_ids: failedInvariants,
    summary,
    // Local-only coaching (never in the JSON v1 object): the metric moves that
    // advance each scorable axis to its next band, straight from rubric data.
    next_moves: nextTargetBlockers(axes, checks, rubric),
  };
}

/**
 * The redacted JSON v1 object — this exact field set is the schema (spec §Contract).
 * Scalars only: no paths, no detail strings, no titles, no contributor identity.
 */
export function toHealthJson(result, repoPath) {
  return {
    schema_version: 2,
    rubric_version: result.rubric_version,
    profile_id: result.profile_id,
    profile_version: result.profile_version,
    head_sha: headSha(repoPath),
    measured_at: new Date().toISOString().slice(0, 10),
    score_pct: result.score_pct,
    status: result.status,
    evidence_status: result.evidence_status,
    quality_gate: result.quality_gate,
    automation_eligible: result.automation_eligible,
    axes: Object.fromEntries(
      Object.entries(result.axes).map(([key, a]) => [
        key,
        { band: a.band, passed: a.passed, total: a.total, evidence_status: a.evidence_status },
      ])
    ),
    failed_invariant_ids: result.failed_invariant_ids,
    checks: result.checks.map((c) => ({
      id: c.id,
      ok: c.ok,
      value: c.value,
      required: c.required,
      evidence_status: c.evidence_status,
    })),
    findings: result.findings,
  };
}

const BAND_BAR = (band) => (band === null ? "░░░░" : "█".repeat(band) + "░".repeat(4 - band));

function checkMark(check, colors, colorize) {
  if (check.value === null) return colorize(colors.yellow, "·");
  if (check.ok) return colorize(colors.green, "✓");
  return colorize(colors.red, "✗");
}

// Render a computeCodebaseHealth result for the CLI. `colors` is the caller's ANSI
// helper object ({ bold, green, red, yellow } — each string→string), as in context-health.
export function renderCodebaseHealth(result, target, colors = {}) {
  const id = (fn, s) => (typeof fn === "function" ? fn(s) : s);
  const lines = [`${id(colors.bold, "Codebase health")}: ${target} (${result.mode} mode)`];
  lines.push("");
  for (const [key, a] of Object.entries(result.axes)) {
    const label = key.replace(/_/g, " ");
    const bandTxt = a.band === null ? "–" : `${a.band}/4`;
    lines.push(
      `  ${label.padEnd(22)} ${BAND_BAR(a.band)} ${bandTxt.padEnd(4)} ` +
        (a.total
          ? `(${a.passed}/${a.total} checks ok; evidence ${a.evidence_status})`
          : `(no inputs; evidence ${a.evidence_status})`)
    );
  }
  lines.push("");
  for (const chk of result.checks) {
    const mark = checkMark(chk, colors, id);
    lines.push(
      `  ${mark} ${chk.title} [${chk.evidence_status}${chk.required ? ", required" : ""}] — ${chk.detail}`
    );
  }
  lines.push(`\n  Codebase health: ${result.summary}`);
  const blockers = result.next_moves ?? [];
  if (blockers.length) {
    lines.push("\n  Next band moves:");
    for (const b of blockers.slice(0, 5)) {
      lines.push(
        `    • ${b.axis}: ${b.metric} ${b.current} → ${b.neededValue} lifts band ${b.currentBand} → ${b.neededBand}`
      );
    }
  }
  return lines.join("\n");
}

// CLI entry for `aios codebase-health [path] [--json]` — kept here (not in aios.mjs)
// so the dispatcher stays at its size cap; aios.mjs passes its ANSI helper through.
// Read-only; exit 0 on any successful scoring (health is a reading, not a gate).
export async function runCodebaseHealthCli(repo, args = [], colors = {}) {
  const target = path.resolve(args.find((a) => !a.startsWith("--")) || repo);
  const result = await computeCodebaseHealth(target, { mode: "full" });
  if (args.includes("--json")) console.log(JSON.stringify(toHealthJson(result, target), null, 2));
  else console.log(renderCodebaseHealth(result, target, colors));
}
