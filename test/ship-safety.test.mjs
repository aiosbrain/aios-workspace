#!/usr/bin/env node
// test/ship-safety.test.mjs — touchesSafetySurface + detectSafetyToken.
// Run: node test/ship-safety.test.mjs

import {
  touchesSafetySurface,
  detectSafetyToken,
  SAFETY_PATHS,
  SAFETY_APPROVED_TOKEN,
} from "../scripts/ship.mjs";

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

console.log("touchesSafetySurface — true for each SAFETY_PATHS entry");
{
  for (const s of SAFETY_PATHS) {
    // A dir prefix matches a file under it; a file entry matches itself.
    const sample = s.endsWith("/") ? `${s}some/file.ext` : s;
    check(`matches ${s}`, touchesSafetySurface([sample]) === true);
  }
}

console.log("touchesSafetySurface — false for non-safety paths");
{
  check("scripts/ship.mjs not safety", touchesSafetySurface(["scripts/ship.mjs"]) === false);
  check("docs/workflows.md not safety", touchesSafetySurface(["docs/workflows.md"]) === false);
  check("empty list → false", touchesSafetySurface([]) === false);
  // A file that merely shares a prefix string but isn't under the dir must not match.
  check("hooks-like filename not matched", touchesSafetySurface(["hooks-readme.md"]) === false);
}

console.log("detectSafetyToken");
{
  check("token alone on last line → true", detectSafetyToken(`review ok\n${SAFETY_APPROVED_TOKEN}`) === true);
  check("token with trailing blank lines → true", detectSafetyToken(`ok\n${SAFETY_APPROVED_TOKEN}\n\n`) === true);
  check("no token → false", detectSafetyToken("looks fine but unsafe") === false);
  check("token not on last line → false", detectSafetyToken(`${SAFETY_APPROVED_TOKEN}\nmore text`) === false);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
