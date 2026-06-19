#!/usr/bin/env node
// check-agent-readiness.mjs — OGR10: Codebase Agent-Readiness (ADVISORY)
//
// Scores how ready a repo is for agents to work in it effectively and verifiably,
// against validation/agent-readiness.rubric.json (canonical source:
// agentic-engineering-maturity/rubric/agent-readiness.json). Prints the level,
// composite %, per-pillar rollup, and the ranked gaps to the next level.
//
// ADVISORY: always exits 0. A low score is information, not a governance failure —
// a brand-new repo should never fail validate-all just for not being agent-ready.
// Use `--json` for machine output (consumed by `aios assess-codebase`).
//
// Usage: ./validation/check-agent-readiness.mjs <repo-path> [--json]
// Wired into validate-all.sh as OGR10.

import { loadRubric, scoreRepo } from "./agent-readiness-lib.mjs";

const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", YELLOW = "\x1b[0;33m", BLUE = "\x1b[0;34m", NC = "\x1b[0m";

const args = process.argv.slice(2);
const json = args.includes("--json");
const repo = args.find((a) => !a.startsWith("--")) || ".";

let result;
try {
  result = scoreRepo(repo, loadRubric());
} catch (e) {
  console.error(`OGR10: could not score ${repo}: ${e.message}`);
  process.exit(0); // advisory — never fail the suite
}

if (json) {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(0);
}

const bar = (passed, total) => {
  const n = total ? Math.round((passed / total) * 10) : 0;
  return "█".repeat(n) + "░".repeat(10 - n);
};

console.log("OGR10: Codebase Agent-Readiness (advisory)");
console.log("================================================");
console.log(`  Level:  ${BLUE}${result.level} — ${result.levelName}${NC}  (${result.pct}% of all checks, ${result.passed}/${result.total})`);
console.log(`          ${result.levelBlurb}`);
if (result.capped) {
  console.log(`  ${YELLOW}⚠ Verification cap applied — no passing verification checks, so the level is held at the cap.${NC}`);
}
console.log("");
console.log("  Pillars:");
for (const p of result.pillars) {
  const ok = p.passed === p.total;
  const c = ok ? GREEN : p.passed === 0 ? RED : YELLOW;
  console.log(`    ${c}${bar(p.passed, p.total)}${NC}  ${p.title}  (${p.passed}/${p.total})`);
}

if (result.nextLevel && result.gaps.length) {
  console.log("");
  console.log(`  To reach ${BLUE}${result.nextLevel}${NC}, address (highest-leverage first):`);
  for (const g of result.gaps.slice(0, 6)) {
    console.log(`    ${YELLOW}○${NC} ${g.title}  ${BLUE}[${g.level} · ${g.pillar}]${NC}`);
  }
  if (result.gaps.length > 6) console.log(`    … and ${result.gaps.length - 6} more`);
} else if (!result.nextLevel) {
  console.log(`  ${GREEN}✓ Top level reached.${NC}`);
}

console.log("================================================");
console.log(`${GREEN}OGR10 ADVISORY${NC} — informational score, not a gate.`);
process.exit(0);
