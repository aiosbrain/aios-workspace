#!/usr/bin/env node
/**
 * Merges the root c8 coverage-summary.json with gui/client's vitest coverage-summary.json
 * into a single root coverage/coverage-summary.json, and concatenates both lcov.info files.
 * Both tools emit istanbul-shaped json-summary output, so this is arithmetic merging, not
 * format conversion. Run after both `test:coverage` scripts have produced their reports.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ROOT_SUMMARY = path.join(ROOT, "coverage", "coverage-summary.json");
const CLIENT_SUMMARY = path.join(ROOT, "gui", "client", "coverage", "coverage-summary.json");
const ROOT_LCOV = path.join(ROOT, "coverage", "lcov.info");
const CLIENT_LCOV = path.join(ROOT, "gui", "client", "coverage", "lcov.info");

const METRICS = ["lines", "statements", "functions", "branches"];

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function mergeTotals(a, b) {
  const merged = {};
  for (const metric of METRICS) {
    const covered = (a[metric]?.covered ?? 0) + (b[metric]?.covered ?? 0);
    const skipped = (a[metric]?.skipped ?? 0) + (b[metric]?.skipped ?? 0);
    const total = (a[metric]?.total ?? 0) + (b[metric]?.total ?? 0);
    merged[metric] = { total, covered, skipped, pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)) };
  }
  return merged;
}

if (!existsSync(ROOT_SUMMARY)) {
  console.error(`merge-coverage: missing ${ROOT_SUMMARY} — did the root test:coverage run first?`);
  process.exit(1);
}

const rootReport = readJson(ROOT_SUMMARY);
if (existsSync(CLIENT_SUMMARY)) {
  const clientReport = readJson(CLIENT_SUMMARY);
  rootReport.total = mergeTotals(rootReport.total, clientReport.total);
  Object.assign(rootReport, clientReport, { total: rootReport.total });
  writeFileSync(ROOT_SUMMARY, JSON.stringify(rootReport, null, 2));
  console.log("merge-coverage: merged gui/client coverage into root coverage-summary.json");
} else {
  console.warn(`merge-coverage: ${CLIENT_SUMMARY} not found — leaving root summary as-is (root suite only)`);
}

if (existsSync(CLIENT_LCOV) && existsSync(ROOT_LCOV)) {
  appendFileSync(ROOT_LCOV, `\n${readFileSync(CLIENT_LCOV, "utf8")}`);
  console.log("merge-coverage: appended gui/client lcov.info onto root lcov.info");
}
