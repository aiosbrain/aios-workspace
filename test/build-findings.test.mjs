#!/usr/bin/env node
// test/build-findings.test.mjs — pure exports from build.mjs for feeding consolidated
// findings into the fix round: parseBuildArgs --findings, extractMustFix (keep all
// Critical/High + plan-conformance Medium, drop untagged Medium/Low), and the
// escalation-ladder interaction (a consolidated [High] resolves to fix_escalated via the
// extended bracket matcher). Run: node test/build-findings.test.mjs

import {
  parseBuildArgs,
  extractMustFix,
  selectBuilderStep,
  hasActionableFindings,
} from "../scripts/build.mjs";

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

console.log("parseBuildArgs --findings");
{
  const a = parseBuildArgs(["plan.md", "feat/x", "--findings", "f.md"]);
  check("findingsFile parsed", a.findingsFile === "f.md");
  check("plan positional not eaten by --findings", a.planSource === "plan.md");
  check("branch positional survives", a.branch === "feat/x");
  check("default findingsFile null", parseBuildArgs(["p.md"]).findingsFile === null);
}

console.log("extractMustFix");
{
  const consolidated = [
    "## Bot Findings (synthesized)",
    "[Critical] a.mjs:1 — data loss (source: Bugbot)",
    "[High] b.mjs:2 — unbounded loop (source: GPT-5.5)",
    "[Medium] c.mjs:3 — naming nit (source: CodeRabbit)",
    "[Medium] d.mjs:4 — drifts from the plan (plan-conformance)",
    "[Low] e.mjs:5 — typo (source: CodeRabbit)",
    "",
    "## Verdict",
    "BLOCKED",
  ].join("\n");
  const out = extractMustFix(consolidated);
  check("keeps Critical", out.includes("[Critical] a.mjs:1"));
  check("keeps High", out.includes("[High] b.mjs:2"));
  check("keeps plan-conformance Medium", out.includes("[Medium] d.mjs:4"));
  check("drops untagged Medium", !out.includes("naming nit"));
  check("drops Low", !out.includes("typo"));
  check("preserves section headers", out.includes("## Bot Findings"));
}

console.log("hasActionableFindings (M3 seed gate)");
{
  check(
    "Critical is actionable",
    hasActionableFindings("[Critical] a.mjs:1 — data loss (source: Bugbot)")
  );
  check("High is actionable", hasActionableFindings("[High] b.mjs:2 — loop (source: GPT-5.5)"));
  check(
    "plan-conformance Medium is actionable",
    hasActionableFindings("[Medium] d.mjs:4 — drifts from the plan (plan-conformance)")
  );
  check(
    "untagged Medium is NOT actionable",
    !hasActionableFindings("[Medium] c.mjs:3 — naming nit (source: CodeRabbit)")
  );
  check("Low is NOT actionable", !hasActionableFindings("[Low] e.mjs:5 — typo"));
  check(
    "a CLEAR file (headers + verdict + only Low) is NOT actionable",
    !hasActionableFindings(
      "## Bot Findings\n[Low] README.md:1 — typo\n\n## Verdict\nCLEAR\n\nBUGBOT_CLEAR"
    )
  );
  check(
    "empty / null is NOT actionable",
    !hasActionableFindings("") && !hasActionableFindings(null)
  );
}

console.log("selectBuilderStep — consolidated [High] escalates");
{
  const review = "[High] b.mjs:2 — unbounded loop (source: GPT-5.5)";
  check(
    "prior feedback + [High] → fix_escalated",
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: review }) ===
      "fix_escalated"
  );
  check(
    "prior feedback, no crit/high, attempt 1 → fix",
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: "[Medium] x — nit" }) ===
      "fix"
  );
  check(
    "no prior feedback → build",
    selectBuilderStep({ hasPriorFeedback: false, fixAttempt: 0, reviewText: null }) === "build"
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
