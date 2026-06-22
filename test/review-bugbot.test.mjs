#!/usr/bin/env node
import {
  detectBugbotClear,
  buildBugbotPrompt,
  BUGBOT_CLEAR_TOKEN,
} from "../scripts/review-bugbot.mjs";

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

console.log("detectBugbotClear");
{
  check("CLEAR token passes", detectBugbotClear(`## Findings\n\nNone.\n\n${BUGBOT_CLEAR_TOKEN}`));
  check("High finding blocks", detectBugbotClear("## Findings\n\n- High: bad thing\n") === false);
  check("Critical bullet blocks", detectBugbotClear("- Critical: leak in file\n") === false);
}

console.log("buildBugbotPrompt");
{
  const p = buildBugbotPrompt({
    skill: "/review-bugbot",
    branch: "feat/x",
    baseSha: "abc123",
    diffStat: " a | 1 +",
    diff: "+line",
    logOneline: "abc feat",
  });
  check("includes skill", p.startsWith("/review-bugbot"));
  check("includes diff", p.includes("+line"));
  check("asks for CLEAR token", p.includes(BUGBOT_CLEAR_TOKEN));
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
