// AM6 weekly maturity report + belts (AIO-231). Feeds synthetic two-week fixtures
// directly to the pure buildWeekReport (no clock dependence), tests isoMonday/splitWeeks
// separately, drives nextSpineBlockers as the anti-drift core, and spawns the CLI over a
// written store to prove the project filter (Major #1). Covers the three reviewer Majors:
//   #1 project filter = SESSION cwd slug, not the workspace-root basename (CLI spawn test);
//   #2 next-belt thresholds come from aem.mjs's band constants, verified by an anti-drift
//      sweep that bumps each reported blocker to its neededValue and re-scores;
//   #3 the verification gate surfaces + is ordered first in the next-belt UX.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildWeekReport,
  renderWeekReport,
  isoMonday,
  splitWeeks,
  MIN_WEEK_SESSIONS,
} from "../scripts/maturity-week.mjs";
import {
  spineLevel,
  scoreAxes,
  nextSpineBlockers,
  minForScore,
  maxTokensForScore,
  VERIFICATION_BANDS,
  AUTONOMY_BANDS,
  LEARNING_BANDS,
  L5_SUBAGENT_MIN,
} from "../scripts/analyze/aem.mjs";
import { STORE_REL } from "../scripts/analyze/maturity-store.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const DAY = 24 * 60 * 60 * 1000;
const levelNum = (spine) => Number(String(spine).slice(1));

// One session with zeroed counts + signals; caller overrides the knobs that matter.
function mkSession(counts = {}, signals = {}, extra = {}) {
  return {
    session_id: "s",
    project: "gui",
    ended_at: "2026-07-01T10:00:00Z",
    tier: "admin",
    counts: {
      in_tok: 0,
      out_tok: 0,
      cache_read_tok: 0,
      cache_create_tok: 0,
      subagent_tok: 0,
      tool_use_total: 0,
      verify_tool_uses: 0,
      tool_results: 0,
      tool_result_errors: 0,
      tasks: 0,
      permission_events: 0,
      ...counts,
    },
    signals: { subagent_usage: 0, tool_diversity: 0, ...signals },
    ...extra,
  };
}

// N identical sessions → the fold's ratios equal the per-session ratios (sums scale by N).
function week(n, counts, signals, extra) {
  return Array.from({ length: n }, () => mkSession(counts, signals, extra));
}

// A signals object with sane zero-ish defaults, for driving aem.mjs functions directly.
function sig(overrides = {}) {
  return {
    verify_tool_rate: 0,
    cache_hit_rate: 0,
    delegation_ratio: 0,
    tokens_per_task: 200_000, // > the last cost bound → cost score 1
    tool_diversity: 0,
    subagent_usage: 0,
    permission_events: 0,
    ...overrides,
  };
}

const NOW = new Date("2026-07-04T12:00:00Z"); // a Saturday → ISO Monday 2026-06-29

// ── isoMonday / splitWeeks ──────────────────────────────────────────────────

test("isoMonday: UTC Monday of the containing ISO week", () => {
  assert.equal(
    isoMonday(new Date("2026-07-04T23:00:00Z")).toISOString().slice(0, 10),
    "2026-06-29"
  );
  assert.equal(
    isoMonday(new Date("2026-06-29T00:00:00Z")).toISOString().slice(0, 10),
    "2026-06-29"
  );
  assert.equal(
    isoMonday(new Date("2026-06-28T12:00:00Z")).toISOString().slice(0, 10),
    "2026-06-22"
  );
});

test("splitWeeks buckets by UTC-Monday window; out-of-range dropped", () => {
  const s = (id, iso) => mkSession({ tasks: 1 }, {}, { session_id: id, ended_at: iso });
  const sessions = [
    s("a", "2026-07-01T10:00:00Z"), // this week (Wed)
    s("b", "2026-06-24T10:00:00Z"), // prev week (Wed)
    s("c", "2026-06-15T10:00:00Z"), // two weeks ago → neither
    s("d", "not-a-date"), // unparseable → dropped
  ];
  const { thisWeek, prevWeek } = splitWeeks(sessions, NOW);
  assert.equal(thisWeek.length, 1);
  assert.equal(prevWeek.length, 1);
  assert.equal(thisWeek[0].session_id, "a");
  assert.equal(prevWeek[0].session_id, "b");
});

// ── level + axis deltas, belts ──────────────────────────────────────────────

// This-week signals → L3: context 2 (sets L3), verification 0 (gate holds at ≤3),
// cost 4 (L2), autonomy 0. Prev week identical EXCEPT context 1 → L2. So spine +1,
// context_hygiene +1, all other axes flat.
const L3_COUNTS = {
  in_tok: 100,
  cache_create_tok: 10,
  cache_read_tok: 90,
  tasks: 2,
  tool_use_total: 10,
};
const L2_COUNTS = { ...L3_COUNTS, cache_read_tok: 20 }; // lower cache-hit → context score 1
const LEARN1 = { tool_diversity: 2 }; // learning score 1

test("level + per-axis deltas vs a hand-computed prior week (L2→L3, +1)", () => {
  const report = buildWeekReport({
    sessions: week(5, L3_COUNTS, LEARN1),
    prevWeekSessions: week(5, L2_COUNTS, LEARN1),
    now: NOW,
  });
  assert.equal(report.sufficient, true);
  assert.equal(report.spine, "L3");
  assert.equal(report.spineDelta, 1, "Spine moved L2 → L3");
  assert.equal(report.axesDeltas.context_hygiene, 1, "context hygiene +1");
  assert.equal(report.axesDeltas.verification, 0, "verification flat");
  assert.equal(report.axesDeltas.cost_governance, 0, "cost flat");
  assert.equal(report.belt, "Green", "L3 → Green belt");
  assert.equal(report.weekOf, "2026-06-29");
});

test("under-strength prior week → placement/belt render but deltas are null (never faked)", () => {
  const report = buildWeekReport({
    sessions: week(5, L3_COUNTS, LEARN1),
    prevWeekSessions: week(3, L2_COUNTS, LEARN1), // < MIN_WEEK_SESSIONS
    now: NOW,
  });
  assert.equal(report.spine, "L3");
  assert.equal(report.spineDelta, null);
  assert.equal(report.axesDeltas, null);
  const md = renderWeekReport(report);
  assert.match(md, /No prior-week baseline/);
});

// ── belts + Ninja Master ────────────────────────────────────────────────────

// L5 with every axis at its ceiling (learning maxes at 3, the rest at 4).
const L5_MAX_COUNTS = {
  in_tok: 10,
  cache_read_tok: 100, // cache-hit ≈0.91 → context 4
  subagent_tok: 40, // delegation ≈0.36 → autonomy 4
  tool_use_total: 10,
  verify_tool_uses: 3, // verify rate 0.3 → verification 4
  tasks: 1, // tokens/task ≈10 → cost 4
};
const L5_MAX_SIGNALS = { subagent_usage: 1, tool_diversity: 6 }; // learning 3

test("belt matches level; Ninja Master only at a perfect (all-axes-maxed) L5", () => {
  const perfect = buildWeekReport({ sessions: week(5, L5_MAX_COUNTS, L5_MAX_SIGNALS), now: NOW });
  assert.equal(perfect.spine, "L5");
  assert.equal(perfect.belt, "Black");
  assert.equal(perfect.isNinjaMaster, true, "L5 with all axes maxed → Ninja Master");
  assert.equal(perfect.nextBelt, null, "no next belt beyond L5");
  assert.match(renderWeekReport(perfect), /🥷 Ninja Master/);

  // Still L5 but context only 3 (cache-hit ≈0.6) → not maxed → not Ninja Master.
  const notMaxed = buildWeekReport({
    sessions: week(5, { ...L5_MAX_COUNTS, cache_read_tok: 15 }, L5_MAX_SIGNALS),
    now: NOW,
  });
  assert.equal(notMaxed.spine, "L5");
  assert.equal(notMaxed.isNinjaMaster, false, "L5 with a sub-max axis is not Ninja Master");
  assert.doesNotMatch(renderWeekReport(notMaxed), /Ninja Master/);

  // A non-L5 report is never Ninja Master.
  const l3 = buildWeekReport({ sessions: week(5, L3_COUNTS, LEARN1), now: NOW });
  assert.equal(l3.isNinjaMaster, false);
});

// ── next-belt thresholds are sourced from the band constants (Major #2) ──────

test("next-belt text quotes thresholds computed from the band constants, not literals", () => {
  // L3 → next L4: verification (0.04) + autonomy (0.02), both from the bands.
  const l3 = buildWeekReport({ sessions: week(5, L3_COUNTS, LEARN1), now: NOW });
  assert.equal(l3.nextBelt.target, "L4");
  const md3 = renderWeekReport(l3);
  assert.ok(
    md3.includes(minForScore(VERIFICATION_BANDS, 2).toFixed(2)), // "0.04"
    "verification threshold is minForScore(VERIFICATION_BANDS, 2)"
  );
  assert.ok(
    md3.includes(minForScore(AUTONOMY_BANDS, 2).toFixed(2)), // "0.02"
    "autonomy threshold is minForScore(AUTONOMY_BANDS, 2)"
  );

  // L1 → next L2 is an OR over cost (≤180000) and learning (≥1).
  const l1 = buildWeekReport({
    sessions: week(5, { in_tok: 200_000, tasks: 1 }, {}),
    now: NOW,
  });
  assert.equal(l1.spine, "L1");
  assert.equal(l1.nextBelt.target, "L2");
  assert.equal(l1.nextBelt.mode, "any");
  const md1 = renderWeekReport(l1);
  assert.match(md1, /Reach \*\*either\*\*/);
  assert.ok(md1.includes(String(maxTokensForScore(2))), "cost threshold is maxTokensForScore(2)");
  assert.ok(
    md1.includes(minForScore(LEARNING_BANDS, 1).toFixed(1)), // "1.0"
    "learning threshold is minForScore(LEARNING_BANDS, 1)"
  );
});

// ── verification gate in the UX (Major #3) ──────────────────────────────────

test("verification-weak L3 → next-belt lists verification FIRST with the 0.04 threshold", () => {
  // verification 1 (gate), autonomy 0, context 2 → spine L3; L4 needs verification+autonomy.
  const counts = {
    in_tok: 100,
    cache_read_tok: 90,
    tasks: 2,
    tool_use_total: 100,
    verify_tool_uses: 1,
  };
  const report = buildWeekReport({ sessions: week(5, counts, {}), now: NOW });
  assert.equal(report.spine, "L3", "capped at L3 by the verification gate");
  assert.equal(report.axes.verification, 1);
  const axes = report.nextBelt.blockers.map((b) => b.axis);
  assert.ok(axes.includes("verification") && axes.includes("autonomy"), "both are blockers");

  const md = renderWeekReport(report);
  const vIdx = md.indexOf("Verification");
  const aIdx = md.indexOf("Autonomy");
  assert.ok(vIdx !== -1 && aIdx !== -1 && vIdx < aIdx, "verification blocker is listed first");
  // The verification bullet quotes the score-2 threshold, not an L4 axis pair number.
  assert.ok(md.includes(minForScore(VERIFICATION_BANDS, 2).toFixed(2)), "quotes 0.04");
});

// ── anti-drift sweep: the mirror tracks spineLevel's real predicates ─────────

test("anti-drift: bumping each reported blocker to its neededValue advances spineLevel", () => {
  const grid = [
    sig(), // L1  → target L2 (OR)
    sig({ tokens_per_task: 80, tool_diversity: 2, cache_hit_rate: 0.1, verify_tool_rate: 0.01 }), // L2 → L3
    sig({ tokens_per_task: 80, cache_hit_rate: 0.45 }), // L3 (context 2) → L4
    // L4 (verification 3 + autonomy 3), learning 2, subagent 0 → L5 needs learning + subagent
    sig({ verify_tool_rate: 0.12, delegation_ratio: 0.1, cache_hit_rate: 0.45, tool_diversity: 3 }),
  ];

  for (const s of grid) {
    const axes = scoreAxes(s);
    const { target, mode, blockers } = nextSpineBlockers(axes, s);
    if (!target) continue; // already L5
    assert.ok(blockers.length > 0, `an unmet target ${target} must report blockers`);

    if (mode === "any") {
      // Any single blocker, bumped to its neededValue, must reach the target on its own.
      for (const b of blockers) {
        const s2 = { ...s, [b.signal]: b.neededValue };
        assert.ok(
          levelNum(spineLevel(scoreAxes(s2), s2)) >= levelNum(target),
          `any-mode: bumping ${b.signal} to ${b.neededValue} should reach ${target}`
        );
      }
    } else {
      // All blockers bumped together must reach the target.
      const s2 = { ...s };
      for (const b of blockers) s2[b.signal] = b.neededValue;
      assert.ok(
        levelNum(spineLevel(scoreAxes(s2), s2)) >= levelNum(target),
        `all-mode: bumping every blocker should reach ${target}`
      );
    }
  }
});

test("OR at L1→L2 + L5 subagent floor sourced from the constant", () => {
  const l1 = nextSpineBlockers(scoreAxes(sig()), sig());
  assert.equal(l1.target, "L2");
  assert.equal(l1.mode, "any");
  const l1axes = l1.blockers.map((b) => b.axis).sort();
  assert.deepEqual(l1axes, ["cost_governance", "learning"], "OR over cost + learning");

  // L4 with learning 2 + subagent 0 → L5 blockers include the raw subagent floor at L5_SUBAGENT_MIN.
  const s = sig({
    verify_tool_rate: 0.12,
    delegation_ratio: 0.1,
    cache_hit_rate: 0.45,
    tool_diversity: 3,
  });
  const l5 = nextSpineBlockers(scoreAxes(s), s);
  assert.equal(l5.target, "L5");
  const sub = l5.blockers.find((b) => b.signal === "subagent_usage");
  assert.ok(sub, "subagent_usage is a blocker");
  assert.equal(sub.neededValue, L5_SUBAGENT_MIN, "floor comes straight from L5_SUBAGENT_MIN");
});

// ── insufficient data ───────────────────────────────────────────────────────

test("< 5 sessions this week → insufficient, null verdicts, honest message", () => {
  const report = buildWeekReport({ sessions: week(4, L3_COUNTS, LEARN1), now: NOW });
  assert.equal(report.sufficient, false);
  assert.equal(report.insufficient.have, 4);
  assert.equal(report.insufficient.need, MIN_WEEK_SESSIONS);
  assert.equal(report.spine, null);
  assert.equal(report.spineDelta, null);
  assert.match(renderWeekReport(report), /4 of 5 sessions/);
});

// ── CLI file I/O + project filter (Major #1) ────────────────────────────────

// Build a store under <ws>/.aios/loop/maturity with sessions dated inside the current
// UTC week, tagged with `project`. Returns the workspace path.
function writeStore(project) {
  const tmp = mkdtempSync(path.join(tmpdir(), "maturity-week-"));
  const ws = path.join(tmp, "aios-workspace");
  const abs = path.join(ws, STORE_REL);
  mkdirSync(path.dirname(abs), { recursive: true });
  const inWeek = new Date(isoMonday(new Date()).getTime() + 2 * DAY).toISOString(); // Wed this week
  const put = (s) => JSON.stringify({ v: 1, op: "put", session: s });
  const lines = Array.from({ length: 6 }, (_, i) =>
    put({
      ...mkSession(L3_COUNTS, LEARN1, { session_id: `w${i}`, ended_at: inWeek, project }),
    })
  );
  writeFileSync(abs, lines.join("\n") + "\n");
  return { tmp, ws };
}

function runCli(ws, args, cwd) {
  return execFileSync("node", [CLI, "maturity-week", "--repo", ws, ...args], {
    cwd,
    encoding: "utf8",
  });
}

test("CLI --out writes the report; project filter uses the session cwd slug, not the repo basename", () => {
  const { tmp, ws } = writeStore("gui"); // sessions tagged with the SUBDIR slug
  try {
    const guiDir = path.join(ws, "gui");
    mkdirSync(guiDir, { recursive: true });
    const out = path.join(tmp, "report.md");

    // Run FROM the 'gui' subdir → projectSlug(cwd) === 'gui' matches the store → sufficient.
    const stdout = runCli(ws, ["--out", out], guiDir);
    assert.match(stdout, /Wrote/);
    assert.ok(existsSync(out), "report file written");
    const md = readFileSync(out, "utf8");
    assert.match(md, /^---\naccess: admin\n---/, "admin-tier frontmatter");
    assert.match(md, /Spine L3/);
    assert.match(md, /Belt: Green/);

    // Filtering by the repo basename ('aios-workspace') instead would see 0 sessions.
    const stdoutRepo = runCli(ws, ["--project", "aios-workspace", "--json"], guiDir);
    assert.equal(JSON.parse(stdoutRepo).sufficient, false, "repo-basename filter finds nothing");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CLI default path is 3-log/maturity/week-<ISO-MONDAY>.md", () => {
  const { tmp, ws } = writeStore("gui");
  try {
    const guiDir = path.join(ws, "gui");
    mkdirSync(guiDir, { recursive: true });
    const stdout = runCli(ws, [], guiDir);
    const weekOf = isoMonday(new Date()).toISOString().slice(0, 10);
    const expected = path.join(ws, "3-log", "maturity", `week-${weekOf}.md`);
    assert.match(stdout, /Wrote 3-log\/maturity\/week-\d{4}-\d{2}-\d{2}\.md/);
    assert.ok(existsSync(expected), "default report path exists");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
