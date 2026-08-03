// test/invariant-registry.test.mjs — the §8 invariant registry is wired, not aspirational.
//
// Parses the |Invariant|Enforcer|Runs in| table in docs/ENGINEERING-CONSTITUTION.md via
// scripts/invariant-registry.mjs (the same parser the codebase-health rubric's invariants
// axis will import — AIO-605) and asserts, for every row NOT marked pending:
//   1. every backticked enforcer path in the row exists on disk; and
//   2. the enforcer is actually reachable from the gates: referenced (directly, or through
//      transitive `npm run <script>` expansion) from package.json's `test:prepare` or from a
//      .github/workflows/*.yml. Enforcers that are themselves test files (test/*.test.mjs)
//      count as wired when the test-suite runner (scripts/test-suite.mjs) is reachable —
//      the suite discovers test/*.test.mjs dynamically, so filenames never appear in CI yml.
//
// Rows marked "pending" name the issue/PR that wires them and are exempt from both checks.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadInvariantRegistry, parseInvariantRegistry } from "../scripts/invariant-registry.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// referenceCorpus() → one string containing test:prepare + every workflow, with every
// reachable `npm run <script>` expanded to its package.json command (to a fixpoint), so
// `check:size` in test:prepare resolves to `node scripts/check-file-size.mjs`.
function referenceCorpus() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const parts = [scripts["test:prepare"] ?? ""];
  const workflowsDir = path.join(ROOT, ".github", "workflows");
  for (const entry of readdirSync(workflowsDir)) {
    if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
      parts.push(readFileSync(path.join(workflowsDir, entry), "utf8"));
    }
  }
  const expanded = new Set(["test:prepare"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const match of parts.join("\n").matchAll(/npm run ([\w:.-]+)/g)) {
      const name = match[1];
      if (!expanded.has(name) && scripts[name]) {
        expanded.add(name);
        parts.push(scripts[name]);
        changed = true;
      }
    }
  }
  return parts.join("\n");
}

const rows = loadInvariantRegistry(ROOT);
const corpus = referenceCorpus();

test("registry parses with the expected shape", () => {
  assert.ok(rows.length >= 11, `expected at least 11 invariant rows, got ${rows.length}`);
  for (const row of rows) {
    assert.ok(row.invariant, "every row names its invariant");
    assert.ok(row.enforcer, `row "${row.invariant}" names an enforcer`);
    assert.ok(row.runsIn, `row "${row.invariant}" says where it runs`);
  }
  const pendingRows = rows.filter((r) => r.pending);
  for (const row of pendingRows) {
    assert.match(
      row.runsIn,
      /AIO-\d+|#\d+/,
      `pending row "${row.invariant}" must name the issue/PR that wires it`
    );
  }
});

test("every non-pending enforcer file exists", () => {
  for (const row of rows) {
    if (row.pending) continue;
    assert.ok(
      row.enforcerPaths.length >= 1,
      `row "${row.invariant}" carries no backticked enforcer path`
    );
    for (const p of row.enforcerPaths) {
      assert.ok(
        existsSync(path.join(ROOT, p)),
        `enforcer ${p} ("${row.invariant}") does not exist`
      );
    }
  }
});

test("every non-pending enforcer is reachable from test:prepare or a CI workflow", () => {
  for (const row of rows) {
    if (row.pending) continue;
    const isSuiteTest = (p) => p.startsWith("test/") && p.endsWith(".test.mjs");
    const wired = row.enforcerPaths.some((p) =>
      isSuiteTest(p) ? corpus.includes("scripts/test-suite.mjs") : corpus.includes(p)
    );
    assert.ok(
      wired,
      `row "${row.invariant}": none of [${row.enforcerPaths.join(", ")}] is referenced from ` +
        `test:prepare or .github/workflows/*.yml — wire the enforcer or mark the row pending`
    );
  }
});

test("brain-api revision registry names the checker owner and invocation chain", () => {
  const row = rows.find((candidate) => candidate.invariant.startsWith("brain-api revision label"));
  assert.ok(row, "brain-api revision label invariant is registered");
  assert.deepEqual(row.enforcerPaths, [
    "scripts/context-version-labels.mjs",
    "scripts/context-health.mjs",
    "scripts/check-context.mjs",
  ]);

  const wrapper = readFileSync(path.join(ROOT, "scripts/context-health.mjs"), "utf8");
  assert.match(wrapper, /from "\.\/context-version-labels\.mjs"/);
  assert.match(wrapper, /checkVersionLabels\(repoPath\)/);
});

test("parser is strict about malformed registries", () => {
  assert.throws(
    () => parseInvariantRegistry("# no registry here"),
    /no "## 8\. Invariant registry"/
  );
  assert.throws(
    () => parseInvariantRegistry("## 8. Invariant registry\n\nprose but no table\n"),
    /no \|Invariant\|Enforcer\|Runs in\| table/
  );
});
