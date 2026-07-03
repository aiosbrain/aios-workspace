#!/usr/bin/env node
// test/roadmap-args.test.mjs — [R-Major-5] the exactly-one-source rule + digest-target contract.
// Run: node test/roadmap-args.test.mjs

import { parseRoadmapArgs } from "../scripts/roadmap-run.mjs";

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

console.log("exactly one source");
{
  check("zero sources → error", parseRoadmapArgs([]).error !== null);
  check(
    "two sources → error",
    parseRoadmapArgs(["--label", "x", "--epic", "AIO-1"]).error !== null
  );
  check("one source (label) → ok", parseRoadmapArgs(["--label", "x"]).error === null);
  const e = parseRoadmapArgs(["--epic", "AIO-9"]);
  check("epic source parsed", e.sourceType === "epic" && e.sourceValue === "AIO-9");
  check("bad epic id → error", parseRoadmapArgs(["--epic", "nope"]).error !== null);
}

console.log("--max-issues default + override");
{
  check("default 3", parseRoadmapArgs(["--label", "x"]).maxIssues === 3);
  check("override", parseRoadmapArgs(["--label", "x", "--max-issues", "7"]).maxIssues === 7);
}

console.log("--comment-digest target resolution");
{
  // --comment-digest with --label/--project and NO --digest-target → usage error.
  const e1 = parseRoadmapArgs(["--label", "x", "--comment-digest"]);
  check("label + comment-digest, no target → error", e1.error !== null);
  const e2 = parseRoadmapArgs(["--project", "P", "--comment-digest"]);
  check("project + comment-digest, no target → error", e2.error !== null);

  // --comment-digest with --epic → target = the epic.
  const ep = parseRoadmapArgs(["--epic", "AIO-5", "--comment-digest"]);
  check("epic + comment-digest → target = epic", ep.error === null && ep.digestTarget === "AIO-5");

  // --comment-digest with explicit --digest-target → that target.
  const dt = parseRoadmapArgs(["--label", "x", "--comment-digest", "--digest-target", "AIO-9"]);
  check(
    "label + comment-digest + target → AIO-9",
    dt.error === null && dt.digestTarget === "AIO-9"
  );

  // Explicit target with epic still honored (explicit wins).
  const both = parseRoadmapArgs([
    "--epic",
    "AIO-5",
    "--comment-digest",
    "--digest-target",
    "AIO-9",
  ]);
  check("explicit target wins over epic default", both.digestTarget === "AIO-9");

  // Bad digest-target id → error.
  check(
    "bad digest-target → error",
    parseRoadmapArgs(["--label", "x", "--comment-digest", "--digest-target", "nope"]).error !== null
  );

  // No --comment-digest → digestTarget null even if --digest-target passed alone.
  const none = parseRoadmapArgs(["--label", "x"]);
  check("no comment-digest → target null", none.digestTarget === null);
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
