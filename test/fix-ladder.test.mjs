#!/usr/bin/env node
// test/fix-ladder.test.mjs — the pure fix-escalation ladder (selectBuilderStep) and the
// shared structural Critical/High matcher (hasCriticalOrHighFindings), plus a regression
// that detectBugbotClear is unchanged after the matcher extraction. Zero-dep.
//
// KEY INVARIANT: the ladder keys on hasPriorFeedback + a fixAttempt counter, NEVER the
// outer loop round, and NEVER detectBugbotClear. Round 1 (no feedback) → "build".

import { selectBuilderStep } from "../scripts/build.mjs";
import { hasCriticalOrHighFindings, detectBugbotClear } from "../scripts/review-bugbot.mjs";

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

const MEDIUM_ONLY = "## Findings\n\n- Medium: tidy this up.\n\nNot ready to merge.";
const CRIT_BULLET = "## Findings\n\n- Critical: unsafe eval on user input.\n";
const HIGH_ROW = "## Findings\n\n| Severity | Note |\n| High | missing auth check |\n";

console.log("selectBuilderStep");
{
  check(
    "no prior feedback → build (round 1 initial impl)",
    selectBuilderStep({ hasPriorFeedback: false, fixAttempt: 0, reviewText: null }) === "build"
  );
  check(
    "first fix attempt, Medium-only → fix",
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: MEDIUM_ONLY }) === "fix"
  );
  check(
    "first fix attempt with a Critical bullet → fix_escalated",
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: CRIT_BULLET }) ===
      "fix_escalated"
  );
  check(
    "first fix attempt with a High table row → fix_escalated",
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 1, reviewText: HIGH_ROW }) ===
      "fix_escalated"
  );
  check(
    "second fix attempt, Medium-only → fix_escalated",
    selectBuilderStep({ hasPriorFeedback: true, fixAttempt: 2, reviewText: MEDIUM_ONLY }) ===
      "fix_escalated"
  );
}

console.log("hasCriticalOrHighFindings (structural)");
{
  check("Medium-only body → false", hasCriticalOrHighFindings(MEDIUM_ONLY) === false);
  check("`- Critical:` bullet → true", hasCriticalOrHighFindings(CRIT_BULLET) === true);
  check("`| High |` table row → true", hasCriticalOrHighFindings(HIGH_ROW) === true);
  check(
    "prose 'no Critical or High findings' → false",
    hasCriticalOrHighFindings("There are no Critical or High findings here.") === false
  );
  check("empty/null → false", hasCriticalOrHighFindings(null) === false);
}

console.log("detectBugbotClear regression (unchanged after extraction)");
{
  check(
    "BUGBOT_CLEAR trailing token clears (no Crit/High)",
    detectBugbotClear("## Findings\n\nNone.\n\nBUGBOT_CLEAR") === true
  );
  check(
    "Critical bullet with no trailing token blocks",
    detectBugbotClear("## Findings\n\n- Critical: bad\n") === false
  );
  check(
    "trailing token wins even over a Critical bullet (unchanged semantics)",
    detectBugbotClear("- Critical: bad\n\nBUGBOT_CLEAR") === true
  );
  check(
    "mentions Critical in prose but ends with token → clear",
    detectBugbotClear("No Critical issues found.\n\nBUGBOT_CLEAR") === true
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
