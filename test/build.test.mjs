#!/usr/bin/env node
// test/build.test.mjs — pure-function unit tests for the build phase (scripts/build.mjs).
// Zero-dep, no network, no Cursor. Run: node test/build.test.mjs
//
// Covers arg parsing, plan extraction from a relay --log, the MERGE_READY token
// matcher (incl. the PLAN_READY/MERGE_READY split that the loop keys on), branch
// slugging, and diff classification. The full loop is exercised in build-loop.test.mjs.

import {
  parseBuildArgs,
  extractPlanFromLog,
  detectMergeToken,
  slugify,
  classifyDiff,
  buildCodeReviewPrompt,
  buildImplementPrompt,
  snapshotsDiffer,
  tripwireVerdict,
  EXIT,
} from "../scripts/build.mjs";
import { PLAN_READY_TOKEN, MERGE_READY_TOKEN } from "../scripts/relay-core.mjs";

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

console.log("parseBuildArgs");
{
  const a = parseBuildArgs([
    "plan.md",
    "feat/x",
    "--rounds",
    "6",
    "--merge",
    "--verify",
    "npm test",
    "--base",
    "main",
    "--build-timeout",
    "60",
  ]);
  check("plan-source positional", a.planSource === "plan.md");
  check("branch positional", a.branch === "feat/x");
  check("rounds parsed", a.rounds === 6);
  check("merge flag", a.merge === true);
  check("verify value", a.verify === "npm test");
  check("base value", a.base === "main");
  check("build-timeout → ms", a.buildTimeout === 60000);
  check("defaults: review timeout 300s", a.cursorTimeout === 300000);
  check("defaults: skill /ai-code-review", a.skill === "/ai-code-review");
  check("defaults: no merge off", parseBuildArgs(["p.md"]).merge === false);
  check("default rounds 4", parseBuildArgs(["p.md"]).rounds === 4);
  check("--task flag", parseBuildArgs(["do it", "--task"]).isTask === true);
  check(
    "value-flag value not taken as branch",
    parseBuildArgs(["p.md", "--base", "main"]).branch === undefined
  );
  check("bugbot default off without merge", parseBuildArgs(["p.md", "b"]).bugbot === false);
  check("bugbot on with --merge", parseBuildArgs(["p.md", "b", "--merge"]).bugbot === true);
  check(
    "--no-bugbot overrides merge default",
    parseBuildArgs(["p.md", "b", "--merge", "--no-bugbot"]).bugbot === false
  );
  // H1: --pr is a ship action too — the Bugbot gate must default on (and be overridable).
  check("bugbot on with --pr", parseBuildArgs(["p.md", "b", "--pr"]).bugbot === true);
  check(
    "--no-bugbot overrides pr default",
    parseBuildArgs(["p.md", "b", "--pr", "--no-bugbot"]).bugbot === false
  );
  check(
    "explicit --bugbot on the --pr path",
    parseBuildArgs(["p.md", "b", "--pr", "--bugbot"]).bugbot === true
  );
}

console.log("extractPlanFromLog");
{
  const log =
    "# aios relay plan\n\nTask: x\n\n---\n## Round 1 — Opus plan\n\nDRAFT\n\n---\n## Approved plan (round 2)\n\nFINAL PLAN BODY\n\n---\n## trailing\n\nz\n";
  check("prefers Approved plan section", extractPlanFromLog(log) === "FINAL PLAN BODY");
  const lastOnly =
    "# h\n\n---\n## Round 1 — Opus plan\n\nDRAFT\n\n---\n## Last plan (round limit reached — unapproved)\n\nPARTIAL\n";
  check("falls back to Last plan", extractPlanFromLog(lastOnly) === "PARTIAL");
  check(
    "uses whole file when no sections",
    extractPlanFromLog("just a raw task") === "just a raw task"
  );
  let threw = false;
  try {
    extractPlanFromLog("   \n  ");
  } catch {
    threw = true;
  }
  check("throws on empty", threw);

  // AIO-182: a plan body containing its own markdown horizontal rule must not be
  // truncated at that embedded `---` — only a `---` immediately before the NEXT
  // `## ` section header is a real section boundary.
  const embeddedRule =
    "# h\n\n---\n## Round 1 — Opus plan\n\nDRAFT\n\n---\n## Approved plan (round 2)\n\nSTEP 1\n\n---\n\nSTEP 2 after a horizontal rule\n\n---\n## trailing\n\nz\n";
  check(
    "does not truncate at an embedded horizontal rule",
    extractPlanFromLog(embeddedRule) === "STEP 1\n\n---\n\nSTEP 2 after a horizontal rule"
  );
}

console.log("detectMergeToken");
{
  check("approves on trailing token", detectMergeToken("findings...\nMERGE_READY") === true);
  check(
    "tolerates trailing whitespace/blank lines",
    detectMergeToken("ok\n  MERGE_READY  \n\n") === true
  );
  check("rejects token mid-text", detectMergeToken("MERGE_READY\nmore text") === false);
  check("rejects when absent", detectMergeToken("Not ready to merge") === false);
  check(
    "build keys on MERGE_READY, not PLAN_READY",
    detectMergeToken("x\n" + PLAN_READY_TOKEN) === false
  );
  check("tokens are distinct", PLAN_READY_TOKEN !== MERGE_READY_TOKEN);

  // AIO-182: a streaming artifact can glue the token to trailing prose on the same line.
  check(
    "approves when trailing prose is glued to the token",
    detectMergeToken("findings ok\nMERGE_READY - approved, ship it") === true
  );
  check(
    "approves with no space before glued punctuation",
    detectMergeToken("MERGE_READY.") === true
  );
  check(
    "still rejects a distinct token sharing the prefix",
    detectMergeToken("x\nMERGE_READY_STATUS: pending") === false
  );
}

console.log("slugify");
{
  check(
    "lowercases + hyphenates",
    slugify("Add an aios Build Phase!! (v2)") === "add-an-aios-build-phase-v2"
  );
  check("empty → task", slugify("") === "task");
  check("caps length", slugify("x".repeat(100)).length <= 40);
}

console.log("classifyDiff");
{
  check("no-commits", classifyDiff({ totalCommits: 0, newCommits: 0 }) === "no-commits");
  check("no-progress", classifyDiff({ totalCommits: 3, newCommits: 0 }) === "no-progress");
  check("has-changes", classifyDiff({ totalCommits: 3, newCommits: 2 }) === "has-changes");
}

console.log("buildCodeReviewPrompt");
{
  const p = buildCodeReviewPrompt({
    skill: "/ai-code-review",
    plan: "PLAN",
    diff: "DIFF",
    diffStat: "STAT",
    logOneline: "abc commit",
    secretsResult: "clean",
    branch: "feat/x",
    round: 1,
    maxRounds: 4,
  });
  check("includes the skill", p.includes("/ai-code-review"));
  check("includes the original plan", p.includes("PLAN"));
  check("includes the diff", p.includes("DIFF"));
  check("includes the secrets evidence", p.includes("clean"));
  check("asks for MERGE_READY", p.includes(MERGE_READY_TOKEN));
  const last = buildCodeReviewPrompt({
    skill: "/ai-code-review",
    plan: "P",
    diff: "D",
    diffStat: "",
    logOneline: "",
    secretsResult: "",
    branch: "b",
    round: 4,
    maxRounds: 4,
  });
  check("final round still withholds on Critical/High", /Critical\/High/.test(last));
}

console.log("buildImplementPrompt");
{
  const base = buildImplementPrompt("PLAN BODY", { branch: "feat/x" });
  check("includes the plan", base.includes("PLAN BODY"));
  check("forbids secrets/abs paths", base.includes("/Users/"));
  check("forbids weakening validation/hooks", base.includes("validation/"));
  const fb = buildImplementPrompt("PLAN", { branch: "b", review: "FIX THIS" });
  check("appends reviewer feedback", fb.includes("FIX THIS"));
  const resume = buildImplementPrompt("PLAN", { branch: "b", resumeLog: "abc earlier work" });
  check(
    "includes resume context",
    resume.includes("abc earlier work") && resume.includes("do NOT redo")
  );
}

console.log("snapshotsDiffer (tripwire)");
{
  const before = { status: "", head: "aaa" };
  check("status change trips", snapshotsDiffer(before, { status: " M x", head: "aaa" }));
  check("head change trips", snapshotsDiffer(before, { status: "", head: "bbb" }));
  check("unchanged ok", !snapshotsDiffer(before, before));
}

console.log("tripwireVerdict (concurrency-aware)");
{
  const gitFacts = { originMainSha: "ccc", headIsAncestor: true };
  const before = { status: "?? old.png", head: "aaa" };

  // benign: ff-only advance to origin/main (concurrent walker synced main)
  check(
    "ff to origin/main does not trip",
    !tripwireVerdict(before, { status: "?? old.png", head: "ccc" }, gitFacts)
  );
  // trips: ANY status change — including an untracked file escaping into primary
  check(
    "untracked escape still trips",
    tripwireVerdict(before, { status: "?? old.png\n?? TRIPWIRE_TEST.txt", head: "aaa" }, gitFacts)
  );
  check(
    "tracked modification trips",
    tripwireVerdict(before, { status: " M scripts/aios.mjs\n?? old.png", head: "aaa" }, gitFacts)
  );
  // trips: status change even alongside a benign head ff
  check(
    "status change during benign ff still trips",
    tripwireVerdict(before, { status: "", head: "ccc" }, gitFacts)
  );
  // trips: HEAD moved but NOT to origin/main
  check(
    "head move off origin/main trips",
    tripwireVerdict(before, { status: "?? old.png", head: "ddd" }, gitFacts)
  );
  // trips: HEAD at origin/main but not a descendant (reset/rewrite)
  check(
    "non-ff head move trips",
    tripwireVerdict(
      before,
      { status: "?? old.png", head: "ccc" },
      { originMainSha: "ccc", headIsAncestor: false }
    )
  );
  // trips: origin/main unresolvable
  check(
    "missing origin/main trips on any head move",
    tripwireVerdict(
      before,
      { status: "?? old.png", head: "ccc" },
      { originMainSha: "", headIsAncestor: true }
    )
  );
  // benign: nothing changed
  check("unchanged ok", !tripwireVerdict(before, before, gitFacts));
}

console.log("EXIT codes");
{
  check(
    "contract is stable",
    EXIT.OK === 0 &&
      EXIT.NONCONVERGENCE === 2 &&
      EXIT.NO_DIFF === 3 &&
      EXIT.GATE_FAILED === 4 &&
      EXIT.TIMEOUT === 124
  );
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
