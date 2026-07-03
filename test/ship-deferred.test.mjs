#!/usr/bin/env node
// test/ship-deferred.test.mjs — parseDeferredScope. Run: node test/ship-deferred.test.mjs

import { parseDeferredScope } from "../scripts/ship.mjs";

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

console.log("parses items under the section");
{
  const plan = [
    "# Plan",
    "1. do the thing",
    "",
    "## Deferred (out of scope)",
    "- Add a --json flag later",
    "- Wire up the dashboard tile",
    "",
    "## Build order",
    "- not a deferred item",
  ].join("\n");
  const d = parseDeferredScope(plan);
  check("two items", d.length === 2);
  check("first item", d[0] === "Add a --json flag later");
  check("stops at next heading", !d.includes("not a deferred item"));
}

console.log("tolerates `## Deferred` without parenthetical + checkboxes + asterisks");
{
  const plan = ["## Deferred", "- [ ] task one", "* [x] task two", "plain prose line"].join("\n");
  const d = parseDeferredScope(plan);
  check("checkbox stripped", d[0] === "task one");
  check("asterisk bullet + checkbox stripped", d[1] === "task two");
  check("non-list prose ignored", d.length === 2);
}

console.log("empty / none");
{
  check("lone none → []", parseDeferredScope("## Deferred (out of scope)\n- none").length === 0);
  check("None. → []", parseDeferredScope("## Deferred\n- None.").length === 0);
  check("empty section → []", parseDeferredScope("## Deferred (out of scope)\n\n## Next").length === 0);
  check("no section → []", parseDeferredScope("# Plan\n- item").length === 0);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
