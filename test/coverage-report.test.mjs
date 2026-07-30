// test/coverage-report.test.mjs — the folded AIO-531 producer (AIO-605 prerequisite).
//
// Asserts the detection precedence (pre-normalized → istanbul → lcov), the null/exit-0
// default-deny observable, and the scalars-only output shape.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCoverageReport } from "../scripts/coverage-report.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCER = path.join(ROOT, "scripts", "coverage-report.mjs");

function repoWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-report-"));
  mkdirSync(path.join(dir, "coverage"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, "coverage", rel), content);
  }
  return dir;
}

const ISTANBUL = JSON.stringify({
  total: {
    lines: { pct: 81.2 },
    statements: { pct: 80.9 },
    functions: { pct: 77.1 },
    branches: { pct: 72.4 },
  },
});

const LCOV = [
  "TN:",
  "SF:some/file.mjs",
  "FNF:10",
  "FNH:8",
  "LF:100",
  "LH:75",
  "BRF:20",
  "BRH:10",
  "end_of_record",
].join("\n");

const PRE_NORMALIZED = JSON.stringify({
  lines_pct: 90.5,
  statements_pct: 90,
  functions_pct: 88,
  branches_pct: 70,
  measured_at: "2026-07-01",
});

test("no coverage artifact → null (and the CLI prints `null`, exit 0)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coverage-report-empty-"));
  try {
    assert.equal(readCoverageReport(dir), null);
    const r = spawnSync(process.execPath, [PRODUCER, dir], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("precedence 2: istanbul coverage-summary.json is normalized", () => {
  const dir = repoWith({ "coverage-summary.json": ISTANBUL });
  try {
    const report = readCoverageReport(dir);
    assert.equal(report.source, "istanbul");
    assert.equal(report.lines_pct, 81.2);
    assert.equal(report.branches_pct, 72.4);
    assert.equal(report.schema_version, 1);
    assert.match(report.measured_at, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("precedence 3: lcov.info aggregates LF/LH, FNF/FNH, BRF/BRH", () => {
  const dir = repoWith({ "lcov.info": LCOV });
  try {
    const report = readCoverageReport(dir);
    assert.equal(report.source, "lcov");
    assert.equal(report.lines_pct, 75);
    assert.equal(report.functions_pct, 80);
    assert.equal(report.branches_pct, 50);
    assert.equal(report.statements_pct, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("precedence 1 wins over 2 wins over 3", () => {
  const dir = repoWith({
    "coverage-report.json": PRE_NORMALIZED,
    "coverage-summary.json": ISTANBUL,
    "lcov.info": LCOV,
  });
  try {
    const report = readCoverageReport(dir);
    assert.equal(report.source, "normalized");
    assert.equal(report.lines_pct, 90.5);
    assert.equal(report.measured_at, "2026-07-01");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed pre-normalized artifact falls through to the next source", () => {
  const dir = repoWith({
    "coverage-report.json": JSON.stringify({ lines_pct: "not-a-number" }),
    "coverage-summary.json": ISTANBUL,
  });
  try {
    assert.equal(readCoverageReport(dir).source, "istanbul");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("output carries scalars only — no file paths", () => {
  const dir = repoWith({ "coverage-summary.json": ISTANBUL });
  try {
    const report = readCoverageReport(dir);
    for (const [key, value] of Object.entries(report)) {
      if (typeof value === "string") {
        assert.ok(!value.includes("/"), `${key} leaked a path-like value: ${value}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
