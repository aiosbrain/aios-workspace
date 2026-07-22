#!/usr/bin/env node
// test/ship-args.test.mjs — parseShipArgs + resolveGates + validateShipArgs.
// Run: node test/ship-args.test.mjs

import { parseShipArgs, resolveGates, validateShipArgs } from "../scripts/ship.mjs";

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

console.log("parseShipArgs defaults");
{
  const o = parseShipArgs(["AIO-163"]);
  check("issue parsed", o.issue === "AIO-163");
  check("gates default on (auto false)", o.auto === false && o.autoMerge === false);
  check(
    "reviewers default gpt-5.5 only (Local Bugbot is outside selection)",
    JSON.stringify(o.reviewers) === JSON.stringify(["gpt-5.5"])
  );
  check("max-fix-rounds default 3", o.maxFixRounds === 3);
  check("plan-runner default cli", o.planRunner === "cli");
  check("loop default full", o.loop === "full");
  check("dry-run off", o.dryRun === false);
  check("skip-spec-gate off by default", o.skipSpecGate === false);
  check("spec-gate unset by default (null)", o.specGate === null);
}

console.log("parseShipArgs --spec-gate");
{
  check(
    "advisory parsed",
    parseShipArgs(["AIO-9", "--spec-gate", "advisory"]).specGate === "advisory"
  );
  check("off parsed", parseShipArgs(["AIO-9", "--spec-gate", "off"]).specGate === "off");
  check("block parsed", parseShipArgs(["AIO-9", "--spec-gate", "block"]).specGate === "block");
}

console.log("parseShipArgs overrides");
{
  const o = parseShipArgs([
    "AIO-9",
    "--auto",
    "--auto-merge",
    "--reviewers",
    "bugbot,coderabbit",
    "--max-fix-rounds",
    "5",
    "--plan-runner",
    "sdk",
    "--loop",
    "light",
    "--dry-run",
  ]);
  check("--auto", o.auto === true);
  check("--auto-merge", o.autoMerge === true);
  check(
    "--reviewers list",
    JSON.stringify(o.reviewers) === JSON.stringify(["bugbot", "coderabbit"])
  );
  check("--max-fix-rounds 5", o.maxFixRounds === 5);
  check("--plan-runner sdk", o.planRunner === "sdk");
  check("--loop light", o.loop === "light");
  check("--dry-run", o.dryRun === true);
  check("bugbot alias is marked deprecated", o.deprecatedBugbotReviewer === true);
  check("issue still first positional", o.issue === "AIO-9");
}

console.log("parseShipArgs --skip-spec-gate");
{
  const o = parseShipArgs(["AIO-9", "--skip-spec-gate"]);
  check("--skip-spec-gate", o.skipSpecGate === true);
}

console.log("validateShipArgs");
{
  check("missing issue → error", validateShipArgs(parseShipArgs([])) !== null);
  check("bad id → error", validateShipArgs(parseShipArgs(["not-an-issue"])) !== null);
  check("valid id → null", validateShipArgs(parseShipArgs(["AIO-1"])) === null);
  check(
    "bad plan-runner → error",
    validateShipArgs(parseShipArgs(["AIO-1", "--plan-runner", "wat"])) !== null
  );
  check(
    "cli plan-runner → null (default, supported)",
    validateShipArgs(parseShipArgs(["AIO-1", "--plan-runner", "cli"])) === null
  );
  check(
    "sdk plan-runner → null (documented alternative, supported)",
    validateShipArgs(parseShipArgs(["AIO-1", "--plan-runner", "sdk"])) === null
  );
  check(
    "light loop → null",
    validateShipArgs(parseShipArgs(["AIO-1", "--loop", "light"])) === null
  );
  check(
    "unknown loop → error",
    validateShipArgs(parseShipArgs(["AIO-1", "--loop", "turbo"])) !== null
  );
  check(
    "light loop cannot skip its spec gate",
    validateShipArgs(parseShipArgs(["AIO-1", "--loop", "light", "--skip-spec-gate"])) !== null
  );
  check(
    "bad --spec-gate value → error",
    validateShipArgs(parseShipArgs(["AIO-1", "--spec-gate", "wat"])) !== null
  );
  check(
    "--spec-gate advisory → null (supported)",
    validateShipArgs(parseShipArgs(["AIO-1", "--spec-gate", "advisory"])) === null
  );
  check(
    "--spec-gate off → null on full loop",
    validateShipArgs(parseShipArgs(["AIO-1", "--spec-gate", "off"])) === null
  );
  check(
    "light loop + --spec-gate off → error (gate is the entry contract)",
    validateShipArgs(parseShipArgs(["AIO-1", "--loop", "light", "--spec-gate", "off"])) !== null
  );
  check(
    "light loop + --spec-gate advisory → null (advisory still runs + records)",
    validateShipArgs(parseShipArgs(["AIO-1", "--loop", "light", "--spec-gate", "advisory"])) ===
      null
  );
  check(
    "coderabbit + deprecated bugbot alias are accepted",
    validateShipArgs(parseShipArgs(["AIO-1", "--reviewers", "bugbot,coderabbit"])) === null
  );
  check(
    "known reviewers subset → null",
    validateShipArgs(parseShipArgs(["AIO-1", "--reviewers", "bugbot"])) === null
  );
  check(
    "unknown reviewer → error",
    validateShipArgs(parseShipArgs(["AIO-1", "--reviewers", "cursor-bot"])) !== null
  );
  check(
    "reviewers that normalize to empty (',') → error (never silently disable gates)",
    validateShipArgs(parseShipArgs(["AIO-1", "--reviewers", ","])) !== null
  );
  check(
    "reviewers of only whitespace (' ') → error",
    validateShipArgs(parseShipArgs(["AIO-1", "--reviewers", " "])) !== null
  );
}

console.log("resolveGates — non-TTY logic");
{
  // Gate active (no auto flag) + non-TTY → blocked (never hang).
  const g1 = resolveGates({ auto: false, autoMerge: false, isTty: false });
  check("plan blocked non-TTY without --auto", g1.plan === "blocked");
  check("merge blocked non-TTY without --auto-merge", g1.merge === "blocked");

  // Auto flags → skip regardless of TTY.
  const g2 = resolveGates({ auto: true, autoMerge: true, isTty: false });
  check("plan skip with --auto", g2.plan === "skip");
  check("merge skip with --auto-merge", g2.merge === "skip");

  // TTY, no auto → prompt.
  const g3 = resolveGates({ auto: false, autoMerge: false, isTty: true });
  check("plan prompt on TTY", g3.plan === "prompt");
  check("merge prompt on TTY", g3.merge === "prompt");
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
