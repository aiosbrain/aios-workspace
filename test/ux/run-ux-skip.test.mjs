#!/usr/bin/env node
// test/ux/run-ux-skip.test.mjs — ZERO-DEPENDENCY test for the no-key skip path.
//
// With ANTHROPIC_API_KEY unset, run-ux.mjs must exit 0 and write
// test/ux/evidence/summary.json with status:"skipped_no_key" — BEFORE scaffolding a fixture
// or launching the cockpit, so it needs no node_modules and no live server. This guards the
// regression where the summary was written before the evidence dir existed (ENOENT → exit 2).
//
// Run: node test/ux/run-ux-skip.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_UX = path.join(HERE, "run-ux.mjs");
const SUMMARY = path.join(HERE, "evidence", "summary.json");

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

// Run with NO ANTHROPIC_API_KEY (cloned env, key removed).
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;

console.log("run-ux: no-key skip path exits 0 with skipped_no_key");
let exitCode = 0;
try {
  execFileSync(process.execPath, [RUN_UX, "--flow", "all"], { env, stdio: "pipe" });
} catch (e) {
  exitCode = typeof e.status === "number" ? e.status : 1;
}
check("exit code is 0", exitCode === 0);
check("summary.json written", existsSync(SUMMARY));

let summary = null;
try {
  summary = JSON.parse(readFileSync(SUMMARY, "utf8"));
} catch {
  /* leave null */
}
check("status is skipped_no_key", summary && summary.status === "skipped_no_key");
check(
  "flows is an empty array",
  summary && Array.isArray(summary.flows) && summary.flows.length === 0
);

// Clean up the evidence file this test wrote (gitignored, but keep the tree tidy).
try {
  rmSync(SUMMARY, { force: true });
} catch {
  /* */
}

console.log("");
if (failed) {
  console.log(`${RED}run-ux-skip.test: ${failed} check(s) failed${NC}`);
  process.exit(1);
}
console.log(`${GREEN}run-ux-skip.test: all checks passed${NC}`);
