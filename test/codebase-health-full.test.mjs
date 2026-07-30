// test/codebase-health-full.test.mjs — FULL-mode evaluator coverage for the composed
// codebase-health scorer (AIO-605), over an "equipped" synthetic repo that stubs every
// expensive surface (eslint bin, npm build:loop, gh, OGR13 metrics, §8 registry).
//
// Includes the Bugbot regression fixture: validation/check-modularity.mjs exiting
// NON-ZERO while printing a valid --json breaches payload (ratchet mode) must be read
// as a real breach count — never skipped as "unavailable".

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeCodebaseHealth,
  renderCodebaseHealth,
  toHealthJson,
} from "../scripts/codebase-health.mjs";
import { codebaseHealthCard } from "../scripts/analyze/aem.mjs";
import { codebaseHealthTip } from "../scripts/analyze/guidance.mjs";
import { renderText } from "../scripts/analyze/report.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = path.join(ROOT, "scripts", "check-codebase-health.mjs");

const write = (dir, rel, content) => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), content);
};

const executable = (dir, rel, content) => {
  write(dir, rel, content);
  chmodSync(path.join(dir, rel), 0o755);
};

const GH_RUNS = JSON.stringify([
  { conclusion: "success", createdAt: "2026-07-30T08:00:00Z", updatedAt: "2026-07-30T08:04:00Z" },
  { conclusion: "success", createdAt: "2026-07-30T09:00:00Z", updatedAt: "2026-07-30T09:06:00Z" },
  { conclusion: "failure", createdAt: "2026-07-30T10:00:00Z", updatedAt: "2026-07-30T11:00:00Z" },
]);

const CONSTITUTION = `# Engineering constitution (fixture)

## 8. Invariant registry

| Invariant | Enforcer | Runs in |
|---|---|---|
| Size gate | \`scripts/check-file-size.mjs\` | CI |
| Ghost gate | \`scripts/does-not-exist.mjs\` | CI |
| Future gate | \`scripts/also-missing.mjs\` | pending AIO-999 |

## 9. Something else
`;

/**
 * A synthetic repo where EVERY full-mode evaluator has a working (stubbed) input:
 * gate scripts that pass, an eslint bin emitting JSON, a build:loop script, an OGR13
 * stub that exits 1 WITH a valid breaches payload, a §8 registry with one missing
 * enforcer, coverage + mutation artifacts, and a ci.yml for the gh lane.
 */
function equippedRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "codebase-health-full-"));
  write(
    dir,
    "scripts/size-caps.json",
    JSON.stringify({ defaultCap: 500, include: [], exclude: [], grandfathered: { "a.mjs": 600 } })
  );
  write(dir, "scripts/boundaries.json", JSON.stringify({ rules: [], grandfathered: [] }));
  write(dir, "scripts/check-file-size.mjs", "console.log('ok');\n");
  write(dir, "scripts/check-boundaries.mjs", "console.log('ok');\n");
  write(dir, "scripts/check-domain-isolation.mjs", "console.log('ok');\n");
  mkdirSync(path.join(dir, "src", "operator-loop"), { recursive: true });
  write(dir, "docs/v1-operator-loop/README.md", "# fixture\n");
  write(dir, "scripts/check-docs-drift.mjs", "console.log('ok');\n");
  // Bugbot fixture: ratchet/breach mode — NON-ZERO exit + valid --json payload.
  write(
    dir,
    "validation/check-modularity.mjs",
    'console.log(JSON.stringify({ mode: "ratchet", breaches: [{ metric: "deadCode" }] }));\nprocess.exit(1);\n'
  );
  write(dir, "docs/ENGINEERING-CONSTITUTION.md", CONSTITUTION);
  write(
    dir,
    "coverage/coverage-summary.json",
    JSON.stringify({ total: { lines: { pct: 84 }, branches: { pct: 70 } } })
  );
  write(dir, "coverage-baseline.json", JSON.stringify({ minimum: { lines: 80 } }));
  write(
    dir,
    "reports/mutation/g.json",
    JSON.stringify({
      files: { "a.mjs": { mutants: [{ status: "Killed" }, { status: "Survived" }] } },
    })
  );
  write(
    dir,
    "package.json",
    JSON.stringify({
      name: "fixture",
      scripts: { lint: "eslint .", "build:loop": 'node -e "process.exit(0)"' },
    })
  );
  executable(
    dir,
    "node_modules/.bin/eslint",
    '#!/usr/bin/env node\nconsole.log(JSON.stringify([{ filePath: "a.mjs", errorCount: 0, warningCount: 7 }]));\n'
  );
  mkdirSync(path.join(dir, "node_modules", "typescript"), { recursive: true });
  write(dir, ".github/workflows/ci.yml", "name: ci\n");
  executable(dir, "stub-bin/gh", `#!/usr/bin/env node\nconsole.log(${JSON.stringify(GH_RUNS)});\n`);
  return dir;
}

/** Run fn with the repo's stub-bin prepended to PATH (so `gh` resolves to the stub). */
async function withStubPath(repo, fn) {
  const prev = process.env.PATH;
  process.env.PATH = `${path.join(repo, "stub-bin")}${path.delimiter}${prev}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prev;
  }
}

test("full mode: every expensive evaluator reads its stubbed surface", async () => {
  const repo = equippedRepo();
  try {
    const result = await withStubPath(repo, () => computeCodebaseHealth(repo, { mode: "full" }));
    const check = (id) => result.checks.find((c) => c.id === id);

    // Bugbot regression: non-zero exit + valid JSON payload = a REAL breach reading.
    assert.equal(check("modularity_breaches").value, 1, "breach-exit must not read as skipped");
    assert.equal(check("modularity_breaches").ok, false);

    assert.equal(check("file_size_gate").ok, true);
    assert.equal(check("boundary_gate").ok, true);
    assert.equal(check("domain_isolation_gate").ok, true);
    assert.equal(check("docs_drift_gate").ok, true);
    assert.equal(check("lint_gate").ok, true);
    assert.equal(check("eslint_warning_count").value, 7);
    assert.equal(check("ts_build_gate").ok, true);
    // gh stub: two successful runs of 4m and 6m → median (upper) 6m.
    assert.equal(check("ci_wall_clock_minutes").value, 6);
    // §8 registry: one live enforcer present, one missing, pending row exempt.
    assert.equal(check("invariant_registry_missing_enforcers").value, 1);
    assert.equal(check("invariant_registry_missing_enforcers").ok, false);
    assert.equal(check("coverage_lines_pct").value, 84);
    assert.equal(check("mutation_score_pct").value, 50);
    // lint_type band comes from rubric data: 7 warnings sits in the second band edge.
    assert.equal(result.axes.lint_type.band, 3);
    assert.deepEqual(result.failed_invariant_ids, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("OGR13 with empty/unparseable stdout is skipped — only then unavailable", async () => {
  const repo = equippedRepo();
  try {
    write(repo, "validation/check-modularity.mjs", 'console.error("boom");\nprocess.exit(1);\n');
    const result = await withStubPath(repo, () => computeCodebaseHealth(repo, { mode: "full" }));
    const check = result.checks.find((c) => c.id === "modularity_breaches");
    assert.equal(check.value, null);
    assert.equal(check.ok, true);
    assert.match(check.detail, /unavailable/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("renderCodebaseHealth: axis bars, check marks, next band moves", async () => {
  const repo = equippedRepo();
  try {
    const result = await withStubPath(repo, () => computeCodebaseHealth(repo, { mode: "full" }));
    const text = renderCodebaseHealth(result, repo, {});
    assert.match(text, /Codebase health: /);
    assert.match(text, /modularity/);
    assert.match(text, /lint type/);
    assert.match(text, /Next band moves:/);
    assert.match(text, /eslint_warning_count 7 → 0 lifts band 3 → 4/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("check-codebase-health.mjs: write-baseline → compare → regression, ALWAYS exit 0", async () => {
  const repo = equippedRepo();
  try {
    await withStubPath(repo, async () => {
      const run = (...args) =>
        spawnSync(process.execPath, [CHECKER, ...args], {
          cwd: repo,
          encoding: "utf8",
          timeout: 240_000,
        });

      // No baseline yet: current reading only, still green.
      const first = run();
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /no committed baseline/);

      // Write the baseline (the ONLY write path).
      const wrote = run("--write-baseline");
      assert.equal(wrote.status, 0, wrote.stderr);
      const baselinePath = path.join(repo, "validation", "codebase-health-baseline.json");
      const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      assert.equal(typeof baseline.score_pct, "number");

      // Unchanged compare.
      const same = run();
      assert.equal(same.status, 0, same.stderr);
      assert.match(same.stdout, /score unchanged vs baseline/);

      // Regression: inflate the committed score — the delta prints, the job stays green
      // (the spec's advisory proof: exit 0 even when the score regresses).
      baseline.score_pct += 10;
      baseline.axes.modularity.band = 4;
      writeFileSync(baselinePath, JSON.stringify(baseline));
      const regressed = run();
      assert.equal(regressed.status, 0, "advisory step must NEVER fail the job");
      assert.match(regressed.stdout, /score regressed/);
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("analyze renderText shows the codebase-health card + tip branches", async () => {
  const repo = equippedRepo();
  try {
    const cbh = await withStubPath(repo, () => computeCodebaseHealth(repo, { mode: "full" }));
    const base = {
      window: { since: "2026-07-01", until: "2026-07-08" },
      tools: ["claude"],
      totals: { sessions: 0, tasks: 0, events: 0, total_tokens: 0 },
      signals: {},
      placement: {
        axes: { verification: 0, context_hygiene: 0, autonomy: 0, learning: 0, cost_governance: 0 },
        spine: "L1",
        overall: 0,
        weakest: "verification",
      },
      days: [],
    };
    const withCard = renderText(base, null, null, cbh);
    assert.match(withCard, /Codebase health — /);
    const withoutCard = renderText(base, null, null, null);
    assert.ok(!withoutCard.includes("Codebase health — "));

    // Guidance branches (data-driven nudges).
    assert.match(codebaseHealthTip("critical"), /critical/);
    assert.match(codebaseHealthTip("degraded"), /band moves/);
    assert.equal(codebaseHealthTip("healthy"), "");

    // JSON v1 stays redacted for the equipped repo too.
    const json = toHealthJson(cbh, repo);
    for (const chk of json.checks) {
      assert.deepEqual(Object.keys(chk), ["id", "ok", "value"]);
    }
    assert.equal(codebaseHealthCard(cbh).metrics.failed_invariants, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
