#!/usr/bin/env node
// test/aios-yaml-placeholder.test.mjs — an aios.yaml copied straight from
// scaffold/aios.yaml.tmpl (unfilled {{PLACEHOLDER}} markers) must fail with an
// actionable error, not the generic "unknown sync tier" message. Regression for
// an onboarding report: a contributor copied the .tmpl in directly and got stuck
// on `unknown sync tier '{{OUTWARD_TIER}}'` with no clue what caused it.
// Run: node test/aios-yaml-placeholder.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AIOS = path.join(REPO, "scripts", "aios.mjs");

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

function run(dir) {
  const res = { code: 0, stderr: "" };
  try {
    execFileSync("node", [AIOS, "status", "--repo", dir], { encoding: "utf8" });
  } catch (e) {
    res.code = e.status ?? -1;
    res.stderr = e.stderr ?? "";
  }
  return res;
}

const dir = mkdtempSync(path.join(tmpdir(), "aios-tmplph-"));
try {
  writeFileSync(
    path.join(dir, "aios.yaml"),
    [
      "version: 1",
      'brain_url: ""',
      "sync_tiers:",
      "  - team",
      "  - {{OUTWARD_TIER}}",
      "sync_include:",
      "  - 2-work",
    ].join("\n") + "\n"
  );

  const res = run(dir);
  check("exits non-zero", res.code !== 0);
  check("mentions the unfilled placeholder", res.stderr.includes("{{OUTWARD_TIER}}"));
  check(
    "points at the fix, not just the symptom",
    /scaffold-project\.sh/.test(res.stderr) && /aios\.yaml\.example/.test(res.stderr)
  );
  check(
    "does not surface only the cryptic tier message",
    !/unknown sync tier/i.test(res.stderr) || /template placeholder/i.test(res.stderr)
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("================================================");
if (failed === 0) {
  console.log(`${GREEN}aios.yaml placeholder tests PASSED${NC}`);
  process.exit(0);
}
console.log(`${RED}aios.yaml placeholder tests FAILED (${failed})${NC}`);
process.exit(1);
