import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildBaseline,
  changedLineCoverage,
  coverageDiffArgs,
  isCoverageSource,
  missingCoverageFiles,
  parseArgs,
  parseChangedLines,
  parseLcov,
  resolveBase,
  unquoteGitPath,
} from "../scripts/check-coverage.mjs";
import { mergeTotals, prefixRelativeLcov, prefixSummaryFiles } from "../scripts/merge-coverage.mjs";
import {
  collectShardFiles,
  parseArgs as parseRunCoverageArgs,
  shardDirectory,
} from "../scripts/run-coverage.mjs";

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

test("an added source line rendered as '+++ b/…' inside a hunk is never a file header", () => {
  // With --unified=0, adding the literal source line "++ b/evil.mjs" renders as
  // "+++ b/evil.mjs" inside the hunk body. It must not open a new file: later
  // hunks still belong to the real file from the diff header block.
  const changed = parseChangedLines(
    [
      "diff --git a/scripts/real.mjs b/scripts/real.mjs",
      "index 111..222 100644",
      "--- a/scripts/real.mjs",
      "+++ b/scripts/real.mjs",
      "@@ -0,0 +1 @@",
      "+++ b/evil.mjs",
      "@@ -4,0 +5,2 @@",
      "+more",
      "+more",
    ].join("\n")
  );
  assert.deepEqual([...changed.keys()], ["scripts/real.mjs"]);
  assert.deepEqual(
    [...changed.get("scripts/real.mjs")].sort((a, b) => a - b),
    [1, 5, 6]
  );
});

test("git-quoted non-ASCII headers attribute hunks to the decoded path, not the previous file", () => {
  const changed = parseChangedLines(
    [
      "diff --git a/scripts/plain.mjs b/scripts/plain.mjs",
      "--- a/scripts/plain.mjs",
      "+++ b/scripts/plain.mjs",
      "@@ -0,0 +1 @@",
      "+x",
      'diff --git "a/scripts/caf\\303\\251.mjs" "b/scripts/caf\\303\\251.mjs"',
      '--- "a/scripts/caf\\303\\251.mjs"',
      '+++ "b/scripts/caf\\303\\251.mjs"',
      "@@ -0,0 +10,2 @@",
      "+y",
      "+y",
    ].join("\n")
  );
  assert.deepEqual([...changed.get("scripts/plain.mjs")], [1]);
  assert.deepEqual(
    [...changed.get("scripts/café.mjs")].sort((a, b) => a - b),
    [10, 11]
  );
});

test("deleted files ('+++ /dev/null') do not attach hunks to the previous file", () => {
  const changed = parseChangedLines(
    [
      "diff --git a/scripts/kept.mjs b/scripts/kept.mjs",
      "--- a/scripts/kept.mjs",
      "+++ b/scripts/kept.mjs",
      "@@ -0,0 +1 @@",
      "+x",
      "diff --git a/scripts/gone.mjs b/scripts/gone.mjs",
      "deleted file mode 100644",
      "--- a/scripts/gone.mjs",
      "+++ /dev/null",
      "@@ -1,3 +0,0 @@",
      "-a",
      "-b",
      "-c",
    ].join("\n")
  );
  assert.deepEqual([...changed.keys()], ["scripts/kept.mjs"]);
  assert.deepEqual([...changed.get("scripts/kept.mjs")], [1]);
});

test("git C-style quoted paths decode octal and simple escapes", () => {
  assert.equal(unquoteGitPath("b/plain.ts"), "b/plain.ts");
  assert.equal(unquoteGitPath('"b/caf\\303\\251.ts"'), "b/café.ts");
  assert.equal(unquoteGitPath('"b/a\\tb\\"c\\\\d.ts"'), 'b/a\tb"c\\d.ts');
});

test("coverage diff pathspecs include source files at every directory depth", () => {
  assert.deepEqual(coverageDiffArgs("merge-base-sha"), [
    "diff",
    "--default-prefix",
    "--unified=0",
    "--no-color",
    "merge-base-sha",
    "--",
    ":(glob)scripts/**/*.mjs",
    ":(glob)hooks/**/*.mjs",
    ":(glob)validation/**/*.mjs",
    ":(glob)packages/**/*.mjs",
    ":(glob)src/**/*.ts",
  ]);
});

test("coverage diff args pin the a/ b/ prefixes against a diff.noprefix git config", () => {
  // parseChangedLines keys on "+++ b/…" headers; a developer's
  // `diff.noprefix=true` would strip them and degrade the gate to 100% (0/0).
  assert.ok(coverageDiffArgs("merge-base-sha").includes("--default-prefix"));
});

test(".d.ts declaration files are never coverage sources", () => {
  for (const file of ["src/operator-loop/types.d.ts", "src/global.d.ts"]) {
    assert.equal(isCoverageSource(file), false, file);
  }
});

test("coverage source classification matches the core instrumentation scope", () => {
  for (const file of [
    "scripts/nested/example.mjs",
    "hooks/example.mjs",
    "validation/example.mjs",
    "src/nested/example.ts",
  ]) {
    assert.equal(isCoverageSource(file), true, file);
  }
  for (const file of [
    "test/example.test.mjs",
    "scripts/check-coverage.mjs",
    "scripts/ensure-loop-built.mjs",
    "scaffold/example.js",
  ]) {
    assert.equal(isCoverageSource(file), false, file);
  }
});

test("every .c8rc.json tool-script exclusion is also exempt from the fail-closed LCOV check", () => {
  const c8rc = JSON.parse(readFileSync(new URL("../.c8rc.json", import.meta.url), "utf8"));
  const toolScripts = c8rc.exclude.filter((entry) => /^scripts\/[^*]+\.mjs$/.test(entry));
  // Was >= 7 before scripts/run-rust-tests.mjs was deleted in the AIO-612 cut. The floor exists
  // so the exclusion list cannot be silently emptied; it tracks the real count, it is not a
  // constant to relax whenever a check goes red.
  assert.ok(toolScripts.length >= 6, "expected the coverage tool-script exclusions");
  for (const file of toolScripts) {
    assert.equal(isCoverageSource(file), false, `${file} must not trip the missing-LCOV gate`);
  }
});

test("changed production files missing from LCOV fail closed", () => {
  const changed = new Map([
    ["scripts/nested/covered.mjs", new Set([1])],
    ["scripts/nested/missing.mjs", new Set([1])],
    ["scripts/nested/example.test.mjs", new Set([1])],
    ["scripts/check-coverage.mjs", new Set([1])],
  ]);
  const coverage = new Map([["scripts/nested/covered.mjs", new Map([[1, 1]])]]);
  assert.deepEqual(missingCoverageFiles(changed, coverage), ["scripts/nested/missing.mjs"]);
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

test("client summary keys are namespaced so a shared path cannot clobber the root entry", () => {
  // AIO-514: the merge used to be a bare `{...root, ...client}` spread. Both reports legitimately
  // contain `src/index.ts`, so the client's row silently replaced the root's — totals stayed
  // right, per-file rows did not.
  const root = { "src/index.ts": { lines: { pct: 90 } }, total: { lines: { pct: 90 } } };
  const client = { "src/index.ts": { lines: { pct: 10 } }, total: { lines: { pct: 10 } } };

  const merged = { ...prefixSummaryFiles(root, ""), ...prefixSummaryFiles(client, "gui/client") };

  assert.deepEqual(Object.keys(merged).sort(), ["gui/client/src/index.ts", "src/index.ts"]);
  assert.equal(merged["src/index.ts"].lines.pct, 90, "root entry must survive the merge");
  assert.equal(merged["gui/client/src/index.ts"].lines.pct, 10);
});

test("prefixSummaryFiles drops `total` and leaves absolute paths alone", () => {
  const summary = {
    "src/a.ts": { lines: { pct: 1 } },
    "/abs/b.ts": { lines: { pct: 2 } },
    "C:\\repo\\c.ts": { lines: { pct: 3 } },
    total: { lines: { pct: 4 } },
  };
  assert.deepEqual(Object.keys(prefixSummaryFiles(summary, "gui/client")).sort(), [
    "/abs/b.ts",
    "C:\\repo\\c.ts",
    "gui/client/src/a.ts",
  ]);
});

test("merge-coverage succeeds at the explicit staging path with no gui/client report", async () => {
  // The in-tree gui/ is scheduled for deletion (AIO-612). Requiring its coverage report meant the
  // day it goes, `npm run test:coverage` throws, no artifact is produced, and the scanner pushes
  // test_coverage_pct null — surfacing on the Codebases dashboard as a false 0%.
  const dir = mkdtempSync(path.join(tmpdir(), "merge-cov-"));
  try {
    const metric = { total: 10, covered: 8, skipped: 0, pct: 80 };
    mkdirSync(path.join(dir, "coverage", "root"), { recursive: true });
    writeFileSync(
      path.join(dir, "coverage", "root", "coverage-summary.json"),
      JSON.stringify({
        "scripts/a.mjs": { lines: metric },
        total: {
          lines: metric,
          statements: metric,
          functions: metric,
          branches: metric,
        },
      })
    );
    writeFileSync(
      path.join(dir, "coverage", "root", "lcov.info"),
      "TN:\nSF:scripts/a.mjs\nLF:10\nLH:8\nend_of_record\n"
    );

    const script = path.resolve("scripts/merge-coverage.mjs");
    const staged = path.join(dir, "coverage", ".staged");
    const { spawnSync } = await import("node:child_process");
    const run = spawnSync(
      process.execPath,
      [script, "--out-dir", path.join("coverage", ".staged")],
      {
        cwd: dir,
        encoding: "utf8",
      }
    );

    assert.equal(run.status, 0, `merge-coverage exited ${run.status}: ${run.stderr}`);
    assert.match(run.stdout, /root only — no gui\/client report/);

    const merged = JSON.parse(readFileSync(path.join(staged, "coverage-summary.json"), "utf8"));
    assert.equal(merged.total.lines.pct, 80, "root-only totals must pass through unchanged");
    assert.ok(merged["scripts/a.mjs"], "root per-file rows must survive");
    assert.equal(existsSync(path.join(dir, "coverage", "coverage-summary.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("standalone merge rejects every scanner-readable output directory before writing", async (t) => {
  const script = path.resolve("scripts/merge-coverage.mjs");
  const { spawnSync } = await import("node:child_process");
  for (const [name, args] of [
    ["bare invocation", []],
    ["canonical coverage directory", ["--out-dir", "coverage"]],
    ["repository root", ["--out-dir", "."]],
  ]) {
    await t.test(name, () => {
      const dir = mkdtempSync(path.join(tmpdir(), "merge-cov-guard-"));
      try {
        mkdirSync(path.join(dir, "coverage", "root"), { recursive: true });
        writeFileSync(
          path.join(dir, "coverage", "root", "coverage-summary.json"),
          JSON.stringify({ total: {} })
        );
        writeFileSync(path.join(dir, "coverage", "root", "lcov.info"), "TN:\n");

        const run = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });
        assert.notEqual(run.status, 0, "the side entrance must fail");
        assert.match(run.stderr, /--out-dir (?:is required|must resolve)/);
        assert.equal(existsSync(path.join(dir, "coverage", "coverage-summary.json")), false);
        assert.equal(existsSync(path.join(dir, "coverage-summary.json")), false);
        assert.equal(existsSync(path.join(dir, "coverage", ".staged")), false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
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

test("run-coverage CLI enforces the shard/merge contract syntax", () => {
  assert.deepEqual(parseRunCoverageArgs([]), { mode: "full", shard: null, merge: null });
  assert.deepEqual(parseRunCoverageArgs(["--shard", "2/3"]), {
    mode: "shard",
    shard: { index: 2, total: 3, raw: "2/3" },
    merge: null,
  });
  assert.deepEqual(parseRunCoverageArgs(["--merge=3"]), { mode: "merge", shard: null, merge: 3 });
  assert.throws(() => parseRunCoverageArgs(["--shard=4/3"]), /shard index 4 exceeds total 3/);
  assert.throws(() => parseRunCoverageArgs(["--shard=abc"]), /INDEX\/TOTAL/);
  assert.throws(() => parseRunCoverageArgs(["--shard=0/3"]), /positive integer/);
  assert.throws(() => parseRunCoverageArgs(["--merge=0"]), /positive integer/);
  assert.throws(() => parseRunCoverageArgs(["--shard=1/2", "--merge=2"]), /mutually exclusive/);
  assert.throws(() => parseRunCoverageArgs(["--frobnicate"]), /unknown run-coverage option/);
});

test("shard merge collects every shard's raw data and fails closed on a missing shard", () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-shards-"));
  try {
    for (const index of [1, 2]) {
      mkdirSync(shardDirectory(index, root), { recursive: true });
      writeFileSync(
        path.join(shardDirectory(index, root), `coverage-${index}00-1-0.json`),
        JSON.stringify({ result: [] })
      );
    }
    const files = collectShardFiles(2, root);
    assert.deepEqual(files.map((file) => file.name).sort(), [
      "coverage-s1-coverage-100-1-0.json",
      "coverage-s2-coverage-200-1-0.json",
    ]);
    assert.throws(() => collectShardFiles(3, root), /missing shard coverage data.*shard-3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shard merge fails loudly when shard data beyond the merge total exists", () => {
  // The shard total lives in three places (ci.yml matrix, --shard, --merge);
  // if it drifts, a stray coverage/shard-<k> with k > total must not be
  // silently ignored into an under-reported merge.
  const root = mkdtempSync(path.join(tmpdir(), "aios-shards-"));
  try {
    for (const index of [1, 2, 3]) {
      mkdirSync(shardDirectory(index, root), { recursive: true });
      writeFileSync(
        path.join(shardDirectory(index, root), `coverage-${index}00-1-0.json`),
        JSON.stringify({ result: [] })
      );
    }
    assert.throws(
      () => collectShardFiles(2, root),
      /shard data beyond --merge 2.*coverage\/shard-3/
    );
    // An empty stray directory is still drift — the data it should hold is gone.
    rmSync(path.join(shardDirectory(3, root), "coverage-300-1-0.json"));
    assert.throws(() => collectShardFiles(2, root), /coverage\/shard-3/);
    // With the total matching the shards on disk, collection succeeds.
    rmSync(shardDirectory(3, root), { recursive: true, force: true });
    assert.equal(collectShardFiles(2, root).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("coverage baseline floors CI metrics with jitter headroom", () => {
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
    minimum: { lines: 51.2, statements: 51.2, functions: 65.6, branches: 67.7 },
    changedLines: 80,
  });
});

test("coverage baseline floor never goes negative", () => {
  const summary = {
    total: {
      lines: { pct: 0.1 },
      statements: { pct: 0 },
      functions: { pct: 0.05 },
      branches: { pct: 0.35 },
    },
  };
  assert.deepEqual(buildBaseline(summary).minimum, {
    lines: 0,
    statements: 0,
    functions: 0,
    branches: 0.1,
  });
});
