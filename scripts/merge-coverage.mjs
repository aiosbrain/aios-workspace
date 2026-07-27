#!/usr/bin/env node
/**
 * Merge production-only c8 and Vitest reports into the stable PR artifacts.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const ROOT_SUMMARY = path.join(ROOT, "coverage", "root", "coverage-summary.json");
const CLIENT_SUMMARY = path.join(ROOT, "gui", "client", "coverage", "coverage-summary.json");
const OUTPUT_SUMMARY = path.join(ROOT, "coverage", "coverage-summary.json");
const ROOT_LCOV = path.join(ROOT, "coverage", "root", "lcov.info");
const CLIENT_LCOV = path.join(ROOT, "gui", "client", "coverage", "lcov.info");
const OUTPUT_LCOV = path.join(ROOT, "coverage", "lcov.info");
const METRICS = ["lines", "statements", "functions", "branches"];

export function mergeTotals(a, b) {
  const merged = {};
  for (const metric of METRICS) {
    const covered = (a[metric]?.covered ?? 0) + (b[metric]?.covered ?? 0);
    const skipped = (a[metric]?.skipped ?? 0) + (b[metric]?.skipped ?? 0);
    const total = (a[metric]?.total ?? 0) + (b[metric]?.total ?? 0);
    merged[metric] = {
      total,
      covered,
      skipped,
      pct: total === 0 ? 100 : Number(((covered / total) * 100).toFixed(2)),
    };
  }
  return merged;
}

export function prefixRelativeLcov(text, prefix) {
  return text.replace(/^SF:(.+)$/gm, (_line, file) =>
    file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file) ? `SF:${file}` : `SF:${prefix}/${file}`
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function main() {
  if (!existsSync(ROOT_SUMMARY) || !existsSync(CLIENT_SUMMARY)) {
    const missing = [ROOT_SUMMARY, CLIENT_SUMMARY].filter((file) => !existsSync(file));
    throw new Error(`merge-coverage: missing required report(s): ${missing.join(", ")}`);
  }

  const rootReport = readJson(ROOT_SUMMARY);
  const clientReport = readJson(CLIENT_SUMMARY);
  const total = mergeTotals(rootReport.total, clientReport.total);
  const merged = { ...rootReport, ...clientReport, total };
  writeFileSync(OUTPUT_SUMMARY, `${JSON.stringify(merged, null, 2)}\n`);

  writeFileSync(OUTPUT_LCOV, readFileSync(ROOT_LCOV, "utf8"));
  appendFileSync(
    OUTPUT_LCOV,
    `\n${prefixRelativeLcov(readFileSync(CLIENT_LCOV, "utf8"), "gui/client")}`
  );

  console.log(
    `merge-coverage: lines ${total.lines.pct}% · branches ${total.branches.pct}% · ` +
      `${Object.keys(merged).length - 1} production files`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
