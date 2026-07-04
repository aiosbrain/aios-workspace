#!/usr/bin/env node
// test/roadmap-digest.test.mjs — buildDigest (deterministic, no model) + cmdRoadmapRun's
// digest fallback. A zero-issue run yields a valid digest with NO model call; a multi-issue
// digest lists merged/blocked/refused/skipped; a throwing digest model → deterministic fallback
// (the run still succeeds). Run: node test/roadmap-digest.test.mjs

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildDigest, cmdRoadmapRun, resolveDigestCfg } from "../scripts/roadmap-run.mjs";
import { DEFAULT_MODELS } from "../scripts/loop-models.mjs";
import { SHIP_EXIT } from "../scripts/ship.mjs";

// A minimal eligible candidate: Todo (unstarted), unassigned, unblocked.
const eligible = (id, createdAt = "2026-01-01") => ({
  identifier: id,
  title: id,
  state: { type: "unstarted", name: "Todo" },
  assignee: null,
  priority: 2,
  createdAt,
  blockedBy: [],
});

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

console.log("cmdRoadmapRun — successful digest model prepends prose (covers the live path)");
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
    callDigestAgent: async () => "One issue shipped cleanly; nothing blocked.",
    now: () => new Date("2026-07-03T12:00:00Z"),
    writeDigest: (date, text) => {
      writes.push({ date, text });
      return `/tmp/roadmap-digest-${date}.md`;
    },
  };
  const code = await cmdRoadmapRun("/tmp/repo", ["--label", "x"], deps);
  check("run returns 0", code === 0);
  check(
    "prose is prepended before the deterministic digest",
    /^One issue shipped cleanly; nothing blocked\.\n\n# Roadmap run — 2026-07-03/.test(
      writes[0].text
    )
  );
}

console.log("cmdRoadmapRun — a ship halt surfaces its SHIP_EXIT code, no refresh after halt");
{
  const gitCalls = [];
  const deps = {
    linear: {
      listIssues: async () => [eligible("AIO-2")],
      addComment: async () => ({ ok: true }),
    },
    spawnShip: () => SHIP_EXIT.PR_FAILED, // 40 → halt
    gitExec: (argv) => (gitCalls.push(argv.join(" ")), ""),
    // Stub the digest agent so the (now live-by-default) prose call stays hermetic.
    callDigestAgent: async () => "",
    now: () => new Date("2026-07-03T12:00:00Z"),
    writeDigest: () => "/tmp/d.md",
  };
  const code = await cmdRoadmapRun("/tmp/repo", ["--label", "x"], deps);
  check("halt returns the ship exit code (not 0)", code === SHIP_EXIT.PR_FAILED);
  check("no ff-only refresh after a halt", !gitCalls.some((g) => g.includes("--ff-only")));
}

console.log("cmdRoadmapRun — a skip runs the between-issue ff-only refresh, then returns 0");
{
  const gitCalls = [];
  let shipCount = 0;
  const deps = {
    linear: {
      listIssues: async () => [eligible("AIO-3")],
      addComment: async () => ({ ok: true }),
    },
    spawnShip: () => (shipCount++, SHIP_EXIT.BUILD_FAILED), // 30 → skip
    gitExec: (argv) => (gitCalls.push(argv.join(" ")), ""),
    // Stub the digest agent so the (now live-by-default) prose call stays hermetic.
    callDigestAgent: async () => "",
    now: () => new Date("2026-07-03T12:00:00Z"),
    writeDigest: () => "/tmp/d.md",
  };
  const code = await cmdRoadmapRun("/tmp/repo", ["--label", "x", "--max-issues", "2"], deps);
  check("skip is not a halt → returns 0", code === 0);
  check("shipped exactly once (attempted set blocks re-pick)", shipCount === 1);
  check(
    "fetch ran after the skip",
    gitCalls.some((g) => g === "fetch origin main")
  );
  check(
    "ff-only ran after the skip",
    gitCalls.some((g) => g.includes("--ff-only"))
  );
}

console.log("resolveDigestCfg — soft resolver never process.exits on a broken loop-models.yaml");
{
  // A valid digest override is honored.
  const okRepo = mkdtempSync(path.join(tmpdir(), "roadmap-ok-"));
  mkdirSync(path.join(okRepo, ".aios"), { recursive: true });
  writeFileSync(
    path.join(okRepo, ".aios", "loop-models.yaml"),
    "digest_model: claude-opus-4-8\ndigest_timeout_s: 42\n"
  );
  const okCfg = resolveDigestCfg(okRepo);
  check("honors digest_model override", okCfg.model === "claude-opus-4-8");
  check("honors digest_timeout_s override", okCfg.timeoutMs === 42000);

  // No file → baked-in default, no throw.
  const bareRepo = mkdtempSync(path.join(tmpdir(), "roadmap-bare-"));
  check(
    "missing file → default digest model",
    resolveDigestCfg(bareRepo).model === DEFAULT_MODELS.digest.model
  );

  // A broken config (empty model, diversity-violating, unparseable) that resolveLoopModels would
  // die() on must NOT crash the soft resolver — it falls back to the default.
  const badRepo = mkdtempSync(path.join(tmpdir(), "roadmap-bad-"));
  mkdirSync(path.join(badRepo, ".aios"), { recursive: true });
  writeFileSync(
    path.join(badRepo, ".aios", "loop-models.yaml"),
    "digest_model:\nbuild_model: gpt-5.5-high\ncode_review_model: gpt-5.5-high\n"
  );
  const badCfg = resolveDigestCfg(badRepo);
  check(
    "broken config → falls back to default model",
    badCfg.model === DEFAULT_MODELS.digest.model
  );
  check("broken config → no crash / no exit", typeof badCfg.model === "string");
}

console.log(
  "cmdRoadmapRun — broken loop-models.yaml still writes the deterministic digest (exit 0)"
);
{
  // No resolveModels injected → production path through resolveDigestCfg. A broken config must not
  // process.exit before the digest write (the F6 regression this guards against).
  const badRepo = mkdtempSync(path.join(tmpdir(), "roadmap-run-bad-"));
  mkdirSync(path.join(badRepo, ".aios"), { recursive: true });
  writeFileSync(path.join(badRepo, ".aios", "loop-models.yaml"), "digest_model:\n");
  const writes = [];
  const deps = {
    linear: {
      listIssues: async () => [], // zero issues
      addComment: async () => ({ ok: true }),
    },
    spawnShip: () => 0,
    gitExec: () => "",
    // No resolveModels → exercises the soft production resolver reading the broken file above.
    callDigestAgent: async () => "prose ok",
    now: () => new Date("2026-07-03T12:00:00Z"),
    writeDigest: (date, text) => {
      writes.push({ date, text });
      return `/tmp/roadmap-digest-${date}.md`;
    },
  };
  const code = await cmdRoadmapRun(badRepo, ["--label", "x"], deps);
  check("run returns 0 despite broken config", code === 0);
  check("deterministic digest still written", writes.length === 1);
  check("digest carries the deterministic body", /# Roadmap run — 2026-07-03/.test(writes[0].text));
}

console.log(failed ? `${RED}${failed} check(s) failed${NC}` : `${GREEN}all checks passed${NC}`);
process.exit(failed ? 1 : 0);
