#!/usr/bin/env node
// test/linear-blockedby.test.mjs — [R-Major-2] proven blockedBy direction.
// "AIO-X blocked by AIO-Y" lives on inverseRelations (type "blocks", relation.issue = Y);
// "AIO-X blocks AIO-Z" lives on relations (type "blocks", relatedIssue = Z) and is NOT a
// blocker of X. isUnblocked is false until every blockedBy blocker is completed.
// Run: node test/linear-blockedby.test.mjs

import { normalizeBlockedBy } from "../scripts/linear-client.mjs";
import { isUnblocked } from "../scripts/roadmap-run.mjs";
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
  readFileSync(path.join(DIR, "fixtures", "linear", "relations-both-directions.json"), "utf8")
);

console.log("normalizeBlockedBy — both directions");
{
  const blockedBy = normalizeBlockedBy(fixture);
  check("exactly one blocker", blockedBy.length === 1);
  check("blocker is AIO-200 (the inverseRelation)", blockedBy[0].identifier === "AIO-200");
  check("blocker state carried", blockedBy[0].stateType === "started");
  // AIO-300 (the forward "blocks" relation) must NOT appear — X blocks Z, Z does not block X.
  check(
    "AIO-300 (forward relation) is not a blocker",
    !blockedBy.some((b) => b.identifier === "AIO-300")
  );
}

console.log("isUnblocked follows blockedBy state");
{
  const blocked = { blockedBy: normalizeBlockedBy(fixture) };
  check("blocked while AIO-200 is started", isUnblocked(blocked) === false);

  // Same shape but the blocker is now completed.
  const doneBlocker = {
    inverseRelations: {
      nodes: [{ type: "blocks", issue: { identifier: "AIO-200", state: { type: "completed" } } }],
    },
  };
  const unblocked = { blockedBy: normalizeBlockedBy(doneBlocker) };
  check("unblocked once AIO-200 is completed", isUnblocked(unblocked) === true);

  check("no blockers → unblocked", isUnblocked({ blockedBy: [] }) === true);
}

console.log("forward-only blocks → not blocked");
{
  const forwardOnly = {
    relations: {
      nodes: [
        { type: "blocks", relatedIssue: { identifier: "AIO-Z", state: { type: "unstarted" } } },
      ],
    },
    inverseRelations: { nodes: [] },
  };
  const bb = normalizeBlockedBy(forwardOnly);
  check("forward 'blocks' yields empty blockedBy", bb.length === 0);
  check("isUnblocked true for a pure blocker", isUnblocked({ blockedBy: bb }) === true);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
