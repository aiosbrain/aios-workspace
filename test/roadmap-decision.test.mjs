#!/usr/bin/env node
// test/roadmap-decision.test.mjs — decideFromShipExit for EVERY SHIP_EXIT code + unknown → halt.
// Run: node test/roadmap-decision.test.mjs

import { decideFromShipExit } from "../scripts/roadmap-run.mjs";
import { SHIP_EXIT } from "../scripts/ship.mjs";

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

// The authoritative mapping from the plan's decision table (§4.4).
const EXPECTED = {
  OK: "continue",
  USAGE: "halt",
  RECON_FAILED: "skip",
  SPEC_NOT_READY: "skip",
  PLAN_UNAPPROVED: "skip",
  PLAN_REJECTED: "halt",
  PLAN_GATE_BLOCKED: "halt",
  BUILD_FAILED: "skip",
  BUILD_NONCONVERGENCE: "skip",
  PR_FAILED: "halt",
  REVIEW_NONCONVERGENCE: "skip",
  MERGE_BLOCKED: "skip",
  SAFETY_BLOCKED: "skip",
  MERGE_GATE_BLOCKED: "halt",
  MERGE_REJECTED: "halt",
  CLEANUP_FAILED: "halt",
};

console.log("every SHIP_EXIT code maps correctly");
{
  // Guard: the expected table must cover EVERY SHIP_EXIT code (no drift).
  check(
    "expected table covers all SHIP_EXIT codes",
    Object.keys(EXPECTED).length === Object.keys(SHIP_EXIT).length
  );
  for (const [name, action] of Object.entries(EXPECTED)) {
    check(
      `${name} (${SHIP_EXIT[name]}) → ${action}`,
      decideFromShipExit(SHIP_EXIT[name]) === action
    );
  }
}

console.log("unknown → halt (fail-safe)");
{
  check("999 → halt", decideFromShipExit(999) === "halt");
  check("undefined → halt", decideFromShipExit(undefined) === "halt");
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
