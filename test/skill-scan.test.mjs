#!/usr/bin/env node
// test/skill-scan.test.mjs — assertions for scripts/skill-scan.mjs against three
// fixtures: a clean instructions-only skill (→ low), a code-carrying skill (→ elevated),
// and an injection/exfil skill (→ high, with exact file:line findings).
//
// Zero-dep. Run: node test/skill-scan.test.mjs   (exit 0 = pass)

import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSkill } from "../scripts/skill-scan.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => path.join(DIR, "skill-scan-fixtures", name);

let failed = 0;
const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else { console.log(`  ${RED}✗${NC} ${label}`); failed++; }
}
const has = (findings, file, line, rule) => findings.some((f) => f.file === file && f.line === line && f.rule === rule);

console.log("skill-scan: clean instructions-only skill → low");
{
  const r = scanSkill(fx("clean-skill"));
  check("riskClass is low", r.riskClass === "low");
  check("no findings", r.findings.length === 0);
  check("bundlesCode false", r.bundlesCode === false);
}

console.log("skill-scan: code-carrying skill → elevated");
{
  const r = scanSkill(fx("code-skill"));
  check("riskClass is elevated", r.riskClass === "elevated");
  check("no high-severity findings", r.counts.high === 0);
  check("bundlesCode true", r.bundlesCode === true);
  check("code file recorded", r.codeFiles.includes("scripts/format.py"));
}

console.log("skill-scan: injection + exfil skill → high (exact findings)");
{
  const r = scanSkill(fx("evil-skill"));
  check("riskClass is high", r.riskClass === "high");
  check("hidden-unicode at SKILL.md:8", has(r.findings, "SKILL.md", 8, "hidden-unicode"));
  check("prompt-injection at SKILL.md:10", has(r.findings, "SKILL.md", 10, "prompt-injection"));
  check("external-url at SKILL.md:12", has(r.findings, "SKILL.md", 12, "external-url"));
  check("secret-read at exfil.mjs:7", has(r.findings, "exfil.mjs", 7, "secret-read"));
  check("secret-read at exfil.mjs:8", has(r.findings, "exfil.mjs", 8, "secret-read"));
  check("network-egress at exfil.mjs:9", has(r.findings, "exfil.mjs", 9, "network-egress"));
  check("bundlesCode true", r.bundlesCode === true);
}

console.log("skill-scan: extensionless executable helper → code is detected + scanned");
{
  // Regression: a shebang script with NO file extension (scripts/helper) must count as
  // bundled code AND have its content scanned (previously slipped through as low/[]).
  const r = scanSkill(fx("exec-script-skill"));
  check("bundlesCode true (shebang, no extension)", r.bundlesCode === true);
  check("extensionless helper recorded as code", r.codeFiles.includes("scripts/helper"));
  check("riskClass is high (secret read inside)", r.riskClass === "high");
  check("secret-read found in scripts/helper", r.findings.some((f) => f.file === "scripts/helper" && f.rule === "secret-read"));
  check("process-exec found in scripts/helper", r.findings.some((f) => f.file === "scripts/helper" && f.rule === "process-exec"));
}

console.log("skill-scan: error cases");
{
  let threw = false;
  try { scanSkill(fx("does-not-exist")); } catch { threw = true; }
  check("throws on missing dir", threw);
}

console.log("================================================");
if (failed === 0) { console.log(`${GREEN}skill-scan tests PASSED${NC}`); process.exit(0); }
console.log(`${RED}skill-scan tests FAILED — ${failed} assertion(s)${NC}`); process.exit(1);
