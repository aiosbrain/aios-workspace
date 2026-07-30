/**
 * checks.mjs — the deterministic check evaluators behind the codebase-health scorer
 * (AIO-605). Every evaluator COMPOSES an existing gate or committed config — it shells
 * the gate or reads its machine artifact, and re-implements none of its logic (the
 * spec's rejected-default rule). Each returns `{ value, detail, ok? }`:
 *   - `value: null` = skipped (input unavailable in this repo/environment) — never a failure.
 *   - gates set `ok` themselves (exit code); metric checks get `ok` from the rubric's
 *     `okWhen` in the orchestrator (thresholds stay in data).
 *   - `detail` is LOCAL text-mode evidence only; it never enters the JSON v1 object.
 *
 * Expensive evaluators (eslint, tsc, gh, codebase-memory graph) run only in
 * `mode: "full"` — `mode: "cheap"` (the `aios analyze` shadow-card path) skips them so
 * the card never adds minutes to an analyze run.
 *
 * Zero dependencies (node:* builtins + sibling toolkit barrels only).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { readCoverageReport } from "../coverage-report.mjs";

const GATE_TIMEOUT_MS = 120_000;
const HEAVY_TIMEOUT_MS = 420_000;

function readJsonIf(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const skip = (detail) => ({ value: null, detail: `${detail} (skipped)` });

/** Run a repo-local node gate script; ok = exit 0. Missing script/crash → skipped. */
function runGate(repo, relScript, extraArgs = []) {
  const abs = path.join(repo, relScript);
  if (!existsSync(abs)) return skip(`no ${relScript}`);
  const r = spawnSync(process.execPath, [abs, ...extraArgs], {
    cwd: repo,
    encoding: "utf8",
    timeout: GATE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status === null)
    return skip(`${relScript} did not run (${r.error?.code ?? "timeout"})`);
  const ok = r.status === 0;
  const firstBad = ok
    ? ""
    : ` — ${(r.stderr || r.stdout || "").split("\n").find((l) => l.trim()) ?? ""}`;
  return { ok, value: ok, detail: `${relScript} exit ${r.status}${firstBad}` };
}

// ── modularity ───────────────────────────────────────────────────────────────

function sizeCaps(repo) {
  return readJsonIf(path.join(repo, "scripts", "size-caps.json"));
}

function checkSizeGrandfatherCount(repo) {
  const caps = sizeCaps(repo);
  if (!caps?.grandfathered) return skip("no scripts/size-caps.json grandfather list");
  const n = Object.keys(caps.grandfathered).length;
  return { value: n, detail: `${n} grandfathered oversize file(s) in scripts/size-caps.json` };
}

function checkSizeGrandfatherMax(repo) {
  const caps = sizeCaps(repo);
  const values = Object.values(caps?.grandfathered ?? {});
  if (!values.length) return skip("no grandfathered size ceilings");
  const max = Math.max(...values);
  return { value: max, detail: `largest grandfathered ceiling is ${max} lines` };
}

function checkModularityBreaches(repo) {
  const script = path.join(repo, "validation", "check-modularity.mjs");
  if (!existsSync(script)) return skip("no validation/check-modularity.mjs");
  const r = spawnSync(process.execPath, [script, repo, "--json"], {
    cwd: repo,
    encoding: "utf8",
    timeout: HEAVY_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status !== 0) return skip("OGR13 metrics unavailable (codebase-memory graph)");
  const parsed = readJsonSafe(r.stdout);
  if (!Array.isArray(parsed?.breaches)) return skip("OGR13 output had no breaches array");
  return {
    value: parsed.breaches.length,
    detail: `${parsed.breaches.length} OGR13 ratchet breach(es) vs committed baseline`,
  };
}

function readJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── boundaries ───────────────────────────────────────────────────────────────

function checkBoundaryGrandfatherCount(repo) {
  const rules = readJsonIf(path.join(repo, "scripts", "boundaries.json"));
  if (!Array.isArray(rules?.grandfathered)) return skip("no scripts/boundaries.json");
  const n = rules.grandfathered.length;
  return { value: n, detail: `${n} grandfathered seam coupling(s) in scripts/boundaries.json` };
}

// ── test rigor (all inputs read the ONE normalized artifact / committed floors) ──

function checkCoverageLines(repo) {
  const report = readCoverageReport(repo);
  if (!report) return skip("no coverage artifact (run npm run test:coverage)");
  return {
    value: report.lines_pct,
    detail: `line coverage ${report.lines_pct}% (${report.source}, measured ${report.measured_at})`,
  };
}

function checkCoverageHeadroom(repo) {
  const report = readCoverageReport(repo);
  const baseline = readJsonIf(path.join(repo, "coverage-baseline.json"));
  const floor = baseline?.minimum?.lines;
  if (!report || typeof floor !== "number") {
    return skip("needs both a coverage artifact and coverage-baseline.json floors");
  }
  const headroom = Math.round((report.lines_pct - floor) * 10) / 10;
  return { value: headroom, detail: `${headroom}pp above the committed ${floor}% line floor` };
}

function checkMutationScore(repo) {
  const dir = path.join(repo, "reports", "mutation");
  if (!existsSync(dir)) return skip("no reports/mutation/ group reports");
  let killed = 0;
  let valid = 0;
  let groups = 0;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const report = readJsonIf(path.join(dir, name));
    if (!report?.files) continue;
    groups++;
    for (const file of Object.values(report.files)) {
      for (const mutant of file.mutants ?? []) {
        if (mutant.status === "Killed" || mutant.status === "Timeout") {
          killed++;
          valid++;
        } else if (mutant.status === "Survived" || mutant.status === "NoCoverage") {
          valid++;
        }
      }
    }
  }
  if (valid === 0) return skip("mutation reports present but carried no scored mutants");
  const pct = Math.round((killed / valid) * 1000) / 10;
  return {
    value: pct,
    detail: `${pct}% mutation score (${killed}/${valid} across ${groups} group report(s))`,
  };
}

// ── lint & type debt (full mode only; tolerant of pre/post-AIO-598 lint configs) ──

/** One shared eslint run feeding both lint_gate and eslint_warning_count. */
function runEslint(repo) {
  const bin = path.join(repo, "node_modules", ".bin", "eslint");
  const pkg = readJsonIf(path.join(repo, "package.json"));
  const lintScript = pkg?.scripts?.lint;
  if (!existsSync(bin) || typeof lintScript !== "string" || !lintScript.startsWith("eslint")) {
    return null; // no local eslint surface → both checks skip
  }
  // Reuse the repo's OWN lint target list (post-AIO-598 configs may widen it — we follow).
  const targets = lintScript
    .split(/\s+/)
    .slice(1)
    .filter((a) => !a.startsWith("-"));
  const r = spawnSync(bin, ["--format", "json", ...(targets.length ? targets : ["."])], {
    cwd: repo,
    encoding: "utf8",
    timeout: HEAVY_TIMEOUT_MS,
    maxBuffer: 128 * 1024 * 1024,
  });
  const parsed = readJsonSafe(r.stdout);
  if (!Array.isArray(parsed)) return null; // config error / crash → skip, never a fake fail
  let errors = 0;
  let warnings = 0;
  for (const file of parsed) {
    errors += file.errorCount ?? 0;
    warnings += file.warningCount ?? 0;
  }
  return { errors, warnings };
}

function checkTsBuild(repo) {
  const pkg = readJsonIf(path.join(repo, "package.json"));
  if (typeof pkg?.scripts?.["build:loop"] !== "string") return skip("no build:loop script");
  if (!existsSync(path.join(repo, "node_modules", "typescript"))) {
    return skip("typescript not installed");
  }
  const r = spawnSync("npm", ["run", "build:loop"], {
    cwd: repo,
    encoding: "utf8",
    timeout: HEAVY_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error || r.status === null) return skip("build:loop did not run");
  const ok = r.status === 0;
  return { ok, value: ok, detail: `npm run build:loop exit ${r.status}` };
}

// ── docs parity ──────────────────────────────────────────────────────────────

function checkDocsDrift(repo) {
  if (!existsSync(path.join(repo, "docs", "v1-operator-loop", "README.md"))) {
    return skip("no docs/v1-operator-loop/README.md drift surface");
  }
  return runGate(repo, path.join("scripts", "check-docs-drift.mjs"));
}

// ── invariants (AIO-607 registry parser, imported defensively) ───────────────

async function checkInvariantRegistry(repo) {
  let mod;
  try {
    mod = await import("../invariant-registry.mjs");
  } catch {
    return skip("invariant-registry parser not present (pre-AIO-607 tree)");
  }
  let rows;
  try {
    rows = mod.loadInvariantRegistry(repo);
  } catch {
    return skip("no parseable §8 invariant registry in this repo");
  }
  let missing = 0;
  const examples = [];
  for (const row of rows) {
    if (row.pending) continue;
    for (const rel of row.enforcerPaths) {
      if (!existsSync(path.join(repo, rel))) {
        missing++;
        if (examples.length < 3) examples.push(rel);
      }
    }
  }
  return {
    value: missing,
    detail:
      missing === 0
        ? `${rows.length} registry row(s), every non-pending enforcer file present`
        : `${missing} missing enforcer file(s): ${examples.join(", ")}`,
  };
}

// ── contributor friction ─────────────────────────────────────────────────────

function checkCiWallClock(repo) {
  if (!existsSync(path.join(repo, ".github", "workflows", "ci.yml"))) {
    return skip("no .github/workflows/ci.yml");
  }
  const r = spawnSync(
    "gh",
    [
      "run",
      "list",
      "--workflow",
      "ci.yml",
      "--limit",
      "15",
      "--json",
      "conclusion,createdAt,updatedAt",
    ],
    { cwd: repo, encoding: "utf8", timeout: 15_000 }
  );
  if (r.error || r.status !== 0) return skip("gh run data unavailable (offline / no auth)");
  const runs = readJsonSafe(r.stdout);
  if (!Array.isArray(runs)) return skip("gh returned no run list");
  const minutes = runs
    .filter((run) => run.conclusion === "success")
    .map((run) => (new Date(run.updatedAt) - new Date(run.createdAt)) / 60_000)
    .filter((m) => Number.isFinite(m) && m > 0)
    .sort((a, b) => a - b);
  if (!minutes.length) return skip("no recent successful CI runs to measure");
  const median = minutes[Math.floor(minutes.length / 2)];
  const value = Math.round(median * 10) / 10;
  return {
    value,
    detail: `median CI wall-clock ${value}m over ${minutes.length} successful run(s)`,
  };
}

function checkRatchetDebtTotal(repo) {
  const caps = sizeCaps(repo);
  const rules = readJsonIf(path.join(repo, "scripts", "boundaries.json"));
  const size = caps?.grandfathered ? Object.keys(caps.grandfathered).length : null;
  const seams = Array.isArray(rules?.grandfathered) ? rules.grandfathered.length : null;
  if (size === null && seams === null) return skip("no ratchet lists in this repo");
  const total = (size ?? 0) + (seams ?? 0);
  return {
    value: total,
    detail: `${total} inherited ratchet entr(ies) (size ${size ?? 0} + seams ${seams ?? 0})`,
  };
}

// ── evaluator table ──────────────────────────────────────────────────────────

/**
 * Evaluate every rubric check except the derived `invariant_gate_failures`
 * (the orchestrator computes that from the gate results + the rubric's
 * invariants enumeration). Returns `Map<id, {ok?, value, detail}>`.
 */
export async function evaluateChecks(repo, rubric, { mode = "full" } = {}) {
  const out = new Map();
  const cheap = mode !== "full";
  const put = (id, result) => out.set(id, result);
  const cheapSkip = skip("expensive check in cheap mode");

  put(
    "file_size_gate",
    cheap ? cheapSkip : runGate(repo, path.join("scripts", "check-file-size.mjs"))
  );
  put("size_grandfather_count", checkSizeGrandfatherCount(repo));
  put("size_grandfather_max", checkSizeGrandfatherMax(repo));
  put("modularity_breaches", cheap ? cheapSkip : checkModularityBreaches(repo));

  put("boundary_gate", runGate(repo, path.join("scripts", "check-boundaries.mjs")));
  put(
    "domain_isolation_gate",
    existsSync(path.join(repo, "src", "operator-loop"))
      ? runGate(repo, path.join("scripts", "check-domain-isolation.mjs"))
      : skip("no src/operator-loop domain tree")
  );
  put("boundary_grandfather_count", checkBoundaryGrandfatherCount(repo));

  put("coverage_lines_pct", checkCoverageLines(repo));
  put("coverage_floor_headroom", checkCoverageHeadroom(repo));
  put("mutation_score_pct", checkMutationScore(repo));

  if (cheap) {
    put("lint_gate", cheapSkip);
    put("eslint_warning_count", cheapSkip);
    put("ts_build_gate", cheapSkip);
  } else {
    const eslint = runEslint(repo);
    if (eslint) {
      put("lint_gate", {
        ok: eslint.errors === 0,
        value: eslint.errors === 0,
        detail: `${eslint.errors} eslint error(s)`,
      });
      put("eslint_warning_count", {
        value: eslint.warnings,
        detail: `${eslint.warnings} eslint warning(s)`,
      });
    } else {
      put("lint_gate", skip("eslint not runnable here"));
      put("eslint_warning_count", skip("eslint not runnable here"));
    }
    put("ts_build_gate", checkTsBuild(repo));
  }

  put("docs_drift_gate", checkDocsDrift(repo));
  put("invariant_registry_missing_enforcers", await checkInvariantRegistry(repo));

  put("ci_wall_clock_minutes", cheap ? cheapSkip : checkCiWallClock(repo));
  put("ratchet_debt_total", checkRatchetDebtTotal(repo));

  return out;
}
