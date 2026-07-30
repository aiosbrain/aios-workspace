#!/usr/bin/env node
// Back-compat shim (AIO-600 C2): the scanner body moved to packages/monorepo
// (@aios-alpha/monorepo/internal/skill-scan) so gui/server imports the package subpath
// instead of reaching into scripts/ (boundary R4). Re-exported by RELATIVE path (not
// the bare specifier) so the shim resolves on a bare checkout with no node_modules —
// CI guard jobs and the aios-update vendor snapshot execute scripts/ without an
// npm install. The CLI entry stays here, unchanged:
//
//   node scripts/skill-scan.mjs <skill-dir> [--json]
export * from "../packages/monorepo/src/internal/skill-scan.mjs";

import { scanSkill } from "../packages/monorepo/src/internal/skill-scan.mjs";

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const dir = args.find((a) => !a.startsWith("--"));
  if (!dir) {
    console.error("usage: node scripts/skill-scan.mjs <skill-dir> [--json]");
    process.exit(2);
  }
  const res = scanSkill(dir);
  if (json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(
    `risk: ${res.riskClass}  (${res.counts.high} high-severity of ${res.counts.total} findings; ${res.counts.code_files} code files)`
  );
  for (const f of res.findings)
    console.log(`  [${f.severity}] ${f.file}:${f.line}  ${f.rule}  — ${f.snippet}`);
  // Exit non-zero on high so it's CI-usable; advisory, so callers may ignore.
  process.exit(res.riskClass === "high" ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
