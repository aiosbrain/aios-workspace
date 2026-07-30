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
 * @param {{mode?: "full"|"cheap", rubricPath?: string}} opts
 *   mode "cheap" (the analyze shadow-card path) skips the expensive evaluators
 *   (eslint, tsc, gh, graph metrics) — those checks report null (skipped).
 */
export async function computeCodebaseHealth(repoPath, opts = {}) {
  const rubric = loadHealthRubric(opts.rubricPath);
  const evaluated = await evaluateChecks(repoPath, rubric, { mode: opts.mode ?? "full" });

  const checks = [];
  for (const [id, spec] of Object.entries(rubric.checks)) {
    if (id === "invariant_gate_failures") continue; // derived below
    const r = evaluated.get(id) ?? { value: null, detail: "not evaluated (skipped)" };
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
    });
  }

  const axes = {};
  for (const axis of rubric.axes) {
    const axisChecks = checks.filter((c) => c.axis === axis.key);
    const liveChecks = axisChecks.filter((c) => c.value !== null);
    axes[axis.key] = {
      band: axisBand(axis, rubric, axisChecks),
      passed: liveChecks.filter((c) => c.ok).length,
      total: liveChecks.length,
    };
  }

  const score = scorePct(axes, rubric);
  const status = statusFor(score, rubric);
  const skipped = checks.filter((c) => c.value === null).length;
  const summary =
    `${status} — ${score === null ? "unscored" : `${score}%`}` +
    ` (${rubric.axes.filter((a) => axes[a.key].band !== null).length}/${rubric.axes.length} axes scored` +
    `${skipped ? `, ${skipped} check(s) skipped` : ""})` +
    (failedInvariants.length ? ` · failing invariants: ${failedInvariants.join(", ")}` : "");

  return {
    rubric_id: rubric.id,
    rubric_version: rubric.version,
    mode: opts.mode ?? "full",
    checks,
    axes,
    score_pct: score,
    status,
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
    schema_version: 1,
    rubric_version: result.rubric_version,
    head_sha: headSha(repoPath),
    measured_at: new Date().toISOString().slice(0, 10),
    score_pct: result.score_pct,
    status: result.status,
    axes: Object.fromEntries(
      Object.entries(result.axes).map(([key, a]) => [
        key,
        { band: a.band, passed: a.passed, total: a.total },
      ])
    ),
    failed_invariant_ids: result.failed_invariant_ids,
    checks: result.checks.map((c) => ({ id: c.id, ok: c.ok, value: c.value })),
  };
}

const BAND_BAR = (band) => (band === null ? "░░░░" : "█".repeat(band) + "░".repeat(4 - band));

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
        (a.total ? `(${a.passed}/${a.total} checks ok)` : "(skipped — no inputs here)")
    );
  }
  lines.push("");
  for (const chk of result.checks) {
    const mark =
      chk.value === null
        ? id(colors.yellow, "·")
        : chk.ok
          ? id(colors.green, "✓")
          : id(colors.red, "✗");
    lines.push(`  ${mark} ${chk.title} — ${chk.detail}`);
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
