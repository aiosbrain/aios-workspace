import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBaseline,
  changedLineCoverage,
  coverageDiffArgs,
  parseArgs,
  parseChangedLines,
  parseLcov,
  resolveBase,
} from "../scripts/check-coverage.mjs";
import { mergeTotals, prefixRelativeLcov } from "../scripts/merge-coverage.mjs";

test("coverage merge recomputes percentages from production totals", () => {
  const metric = (total, covered) => ({ total, covered, skipped: 0, pct: covered });
  const merged = mergeTotals(
    {
      lines: metric(10, 8),
      statements: metric(10, 8),
      functions: metric(5, 4),
      branches: metric(4, 2),
    },
    {
      lines: metric(10, 6),
      statements: metric(10, 6),
      functions: metric(5, 3),
      branches: metric(6, 4),
    }
  );
  assert.deepEqual(merged.lines, { total: 20, covered: 14, skipped: 0, pct: 70 });
  assert.equal(merged.branches.pct, 60);
});

test("changed-line coverage considers only executable lines", () => {
  const changed = parseChangedLines(
    [
      "diff --git a/scripts/example.mjs b/scripts/example.mjs",
      "+++ b/scripts/example.mjs",
      "@@ -1,0 +2,3 @@",
    ].join("\n")
  );
  const lcov = parseLcov(
    ["SF:/repo/scripts/example.mjs", "DA:2,1", "DA:4,0", "end_of_record"].join("\n"),
    "/repo"
  );
  assert.deepEqual(changedLineCoverage(changed, lcov), {
    total: 2,
    covered: 1,
    pct: 50,
    files: [{ file: "scripts/example.mjs", total: 2, covered: 1 }],
  });
});

test("coverage diff pathspecs include source files at every directory depth", () => {
  assert.deepEqual(coverageDiffArgs("merge-base-sha"), [
    "diff",
    "--unified=0",
    "--no-color",
    "merge-base-sha",
    "--",
    ":(glob)**/*.mjs",
    ":(glob)**/*.js",
    ":(glob)**/*.ts",
    ":(glob)**/*.tsx",
  ]);
});

test("unimported production files remain zero in merged c8 summaries", () => {
  const merged = mergeTotals(
    {
      lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
      statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
      functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
      branches: { total: 2, covered: 2, skipped: 0, pct: 100 },
    },
    {
      lines: { total: 10, covered: 0, skipped: 0, pct: 0 },
      statements: { total: 10, covered: 0, skipped: 0, pct: 0 },
      functions: { total: 2, covered: 0, skipped: 0, pct: 0 },
      branches: { total: 2, covered: 0, skipped: 0, pct: 0 },
    }
  );
  assert.equal(merged.lines.pct, 50);
});

test("client LCOV paths are rooted before reports are merged", () => {
  assert.equal(
    prefixRelativeLcov("TN:\nSF:src/lib/api.ts\nDA:1,1\nend_of_record\n", "gui/client"),
    "TN:\nSF:gui/client/src/lib/api.ts\nDA:1,1\nend_of_record\n"
  );
  assert.equal(
    prefixRelativeLcov("SF:/absolute/src/lib/api.ts\n", "gui/client"),
    "SF:/absolute/src/lib/api.ts\n"
  );
  assert.equal(
    prefixRelativeLcov("SF:C:\\repo\\src\\lib\\api.ts\n", "gui/client"),
    "SF:C:\\repo\\src\\lib\\api.ts\n"
  );
});

test("coverage CLI rejects missing values and local baseline overwrite shortcuts", () => {
  assert.throws(() => parseArgs(["--base"]), /--base requires a value/);
  assert.throws(() => parseArgs(["--base="]), /--base requires a value/);
  assert.throws(
    () => parseArgs(["--write-baseline"]),
    /requires --output <path>.*CI-generated candidate/
  );
  assert.throws(
    () =>
      parseArgs(["--write-baseline", "--output=coverage/candidate.json"], {
        GITHUB_ACTIONS: "false",
      }),
    /restricted to GitHub Actions/
  );
  assert.deepEqual(
    parseArgs(["--write-baseline", "--output=coverage/candidate.json", "--base", "upstream/main"], {
      GITHUB_ACTIONS: "true",
    }),
    {
      writeBaseline: true,
      output: "coverage/candidate.json",
      base: "upstream/main",
    }
  );
});

test("coverage diff base fails closed instead of silently narrowing to HEAD^", () => {
  const missingGit = () => {
    throw new Error("missing ref");
  };
  assert.throws(
    () => resolveBase(null, missingGit, {}),
    /cannot resolve coverage diff base.*fetch the base branch/
  );
});

test("coverage baseline floors CI metrics to one decimal place", () => {
  const summary = {
    total: {
      lines: { pct: 51.49 },
      statements: { pct: 51.42 },
      functions: { pct: 65.81 },
      branches: { pct: 67.92 },
    },
  };
  assert.deepEqual(buildBaseline(summary), {
    version: 1,
    minimum: { lines: 51.4, statements: 51.4, functions: 65.8, branches: 67.9 },
    changedLines: 80,
  });
});
