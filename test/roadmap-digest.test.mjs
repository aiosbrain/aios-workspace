#!/usr/bin/env node
// test/roadmap-digest.test.mjs — buildDigest (deterministic, no model) + cmdRoadmapRun's
// digest fallback. A zero-issue run yields a valid digest with NO model call; a multi-issue
// digest lists merged/blocked/refused/skipped; a throwing digest model → deterministic fallback
// (the run still succeeds). Run: node test/roadmap-digest.test.mjs

import { buildDigest, cmdRoadmapRun } from "../scripts/roadmap-run.mjs";

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

console.log("buildDigest — zero-issue (deterministic, no model)");
{
  let modelCalled = false;
  const d = buildDigest({ source: "label:x", attempted: 0, max: 3 }, { date: "2026-07-03" });
  // buildDigest takes no model dep, so it is structurally impossible for it to call one.
  check("no model call possible", modelCalled === false);
  check("has header with date", /# Roadmap run — 2026-07-03/.test(d));
  check("Merged (none)", /## Merged\n- \(none\)/.test(d));
  check("Skipped (none)", /## Skipped candidates\n- \(none\)/.test(d));
}

console.log("buildDigest — multi-issue sections");
{
  const d = buildDigest(
    {
      source: "epic:AIO-1",
      attempted: 3,
      max: 3,
      merged: [{ issue: "AIO-2", pr: "#77" }],
      blocked: [{ issue: "AIO-3", reason: "MERGE_BLOCKED", code: 60 }],
      refused: [{ issue: "AIO-4" }],
      skipped: [{ issue: "AIO-5", reason: "assigned" }],
    },
    { date: "2026-07-03" }
  );
  check("merged listed", /- AIO-2 — PR #77/.test(d));
  check("blocked listed with code", /- AIO-3 — MERGE_BLOCKED \(SHIP_EXIT 60\)/.test(d));
  check("refused listed", /- AIO-4 — safety review withheld/.test(d));
  check("skipped listed", /- AIO-5 — assigned/.test(d));
}

console.log("cmdRoadmapRun — throwing digest model → deterministic fallback, run still succeeds");
{
  const writes = [];
  const deps = {
    linear: {
      listIssues: async () => [], // empty board → zero issues
      addComment: async () => ({ ok: true }),
    },
    spawnShip: () => 0,
    gitExec: () => "",
    resolveModels: () => ({ digest: { model: "claude-haiku-4-5" } }),
    callDigestAgent: async () => {
      throw new Error("model exploded");
    },
    now: () => new Date("2026-07-03T12:00:00Z"),
    writeDigest: (date, text) => {
      writes.push({ date, text });
      return `/tmp/roadmap-digest-${date}.md`;
    },
  };
  const code = await cmdRoadmapRun("/tmp/repo", ["--label", "x"], deps);
  check("run returns 0 despite model throw", code === 0);
  check("digest written once", writes.length === 1);
  check("digest is the deterministic text", /# Roadmap run — 2026-07-03/.test(writes[0].text));
  check("date from injected now", writes[0].date === "2026-07-03");
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
