#!/usr/bin/env node
/**
 * Merge production-only c8 and Vitest reports into the stable PR artifacts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
const ROOT_SUMMARY = path.join(ROOT, "coverage", "root", "coverage-summary.json");
const CLIENT_SUMMARY = path.join(ROOT, "gui", "client", "coverage", "coverage-summary.json");
const ROOT_LCOV = path.join(ROOT, "coverage", "root", "lcov.info");
const CLIENT_LCOV = path.join(ROOT, "gui", "client", "coverage", "lcov.info");
const METRICS = ["lines", "statements", "functions", "branches"];

/**
 * Where to write. `run-coverage.mjs` passes a STAGING directory, because the canonical names mean
 * "a run completed successfully" and this script runs long before that is known — see
 * scripts/coverage-outputs.mjs. Defaults to `coverage/` so a bare `node scripts/merge-coverage.mjs`
 * still behaves as it always did.
 */
function outputDirectory(argv) {
  const index = argv.indexOf("--out-dir");
  if (index === -1) return path.join(ROOT, "coverage");
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("--out-dir requires a value");
  return path.resolve(ROOT, value);
}

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

/**
 * Namespace the CLIENT summary's per-file keys the same way `prefixRelativeLcov` namespaces its
 * `SF:` records (AIO-514). Without this the merge was a bare `{...root, ...client}` spread, so
 * any path present in BOTH reports — `src/index.ts` is the obvious one — had its root entry
 * silently replaced by the client's. Totals stayed correct, which is exactly why it went
 * unnoticed: only the per-file rows were wrong.
 *
 * Root keys are left alone: they are already root-relative, and rewriting them would churn every
 * path in the artifact for no gain. Prefixing one side is enough to make a collision impossible.
 * `total` is not a file key and is re-derived by the caller, so it is dropped rather than
 * prefixed.
 */
export function prefixSummaryFiles(summary, prefix) {
  const out = {};
  for (const [file, entry] of Object.entries(summary)) {
    if (file === "total") continue;
    const absolute = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file);
    out[absolute || !prefix ? file : `${prefix}/${file}`] = entry;
  }
  return out;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

const EMPTY_TOTAL = Object.freeze(
  Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0, skipped: 0, pct: 100 }]))
);

function main(argv = []) {
  const outDir = outputDirectory(argv);
  const OUTPUT_SUMMARY = path.join(outDir, "coverage-summary.json");
  const OUTPUT_LCOV = path.join(outDir, "lcov.info");

  // Only the root report is required. The client report is OPTIONAL by design: `gui/` is being
  // cut to aiosbrain/aios-workspace-gui (AIO-612), and a hard requirement here meant the day the
  // in-tree GUI is deleted, `npm run test:coverage` throws → no coverage artifact → the scanner
  // reports test_coverage_pct null → the Codebases dashboard shows this repo at 0%. That is the
  // same false-zero already visible on scaffolded workspaces; there is no reason to walk into it
  // a second time on the flagship repo.
  if (!existsSync(ROOT_SUMMARY)) {
    throw new Error(`merge-coverage: missing required report: ${ROOT_SUMMARY}`);
  }

  const rootReport = readJson(ROOT_SUMMARY);
  const hasClient = existsSync(CLIENT_SUMMARY);
  const clientReport = hasClient ? readJson(CLIENT_SUMMARY) : null;

  const total = mergeTotals(rootReport.total, clientReport?.total ?? EMPTY_TOTAL);
  const merged = {
    ...prefixSummaryFiles(rootReport, ""),
    ...(clientReport ? prefixSummaryFiles(clientReport, "gui/client") : {}),
    total,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(OUTPUT_SUMMARY, `${JSON.stringify(merged, null, 2)}\n`);

  writeFileSync(OUTPUT_LCOV, readFileSync(ROOT_LCOV, "utf8"));
  if (hasClient && existsSync(CLIENT_LCOV)) {
    appendFileSync(
      OUTPUT_LCOV,
      `\n${prefixRelativeLcov(readFileSync(CLIENT_LCOV, "utf8"), "gui/client")}`
    );
  }

  console.log(
    `merge-coverage: lines ${total.lines.pct}% · branches ${total.branches.pct}% · ` +
      `${Object.keys(merged).length - 1} production files` +
      (hasClient ? "" : " (root only — no gui/client report)")
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
