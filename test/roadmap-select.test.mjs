#!/usr/bin/env node
// test/roadmap-select.test.mjs — selectNextIssue picks the top unblocked/unassigned/Todo
// candidate by priority (ties → oldest), using the PROVEN blockedBy. Provably skips a candidate
// whose blocker isn't Done, and skips assigned / non-Todo. Run: node test/roadmap-select.test.mjs

import { selectNextIssue, isUnblocked, skipReason } from "../scripts/roadmap-run.mjs";
import { normalizeBlockedBy } from "../scripts/linear-client.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

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

const fixture = JSON.parse(
  readFileSync(path.join(DIR, "fixtures", "linear", "roadmap-candidates.json"), "utf8")
);
// Normalize raw nodes → the shape selectNextIssue consumes (blockedBy via normalizeBlockedBy).
const candidates = fixture.candidates.map((n) => ({
  identifier: n.identifier,
  title: n.title,
  priority: n.priority,
  createdAt: n.createdAt,
  state: n.state,
  assignee: n.assignee,
  blockedBy: normalizeBlockedBy(n),
}));

const byId = (id) => candidates.find((c) => c.identifier === id);

console.log("selectNextIssue");
{
  const winner = selectNextIssue(candidates, { now: () => new Date("2026-07-03T00:00:00Z") });
  // AIO-2 & AIO-3 are both unblocked/unassigned/Todo priority 2; AIO-3 is older → wins.
  check("selects AIO-3 (priority tie → oldest)", winner?.identifier === "AIO-3");
}

console.log("skips");
{
  check(
    "AIO-1 provably blocked (blocker AIO-9 not completed)",
    isUnblocked(byId("AIO-1")) === false
  );
  check("AIO-1 skip reason names blocker", /blocked by AIO-9/.test(skipReason(byId("AIO-1"))));
  check("AIO-4 assigned → skipped", skipReason(byId("AIO-4")) === "assigned");
  check("AIO-5 non-Todo → skipped", /not-Todo/.test(skipReason(byId("AIO-5"))));
  check("AIO-6 unblocked (blocker AIO-8 completed)", isUnblocked(byId("AIO-6")) === true);
}

console.log("empty pool → null");
{
  check("no candidates → null", selectNextIssue([], {}) === null);
  const allBlocked = [byId("AIO-1"), byId("AIO-4"), byId("AIO-5")];
  check("no eligible → null", selectNextIssue(allBlocked, {}) === null);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
