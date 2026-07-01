// C8 telemetry — unit tests for the store (recordEvent/readEvents) and the pure reducer
// (computeMetrics). Drives the built module directly. The reducer semantics tested here are the
// trust surface: degraded data must produce met:null, never a false green.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  recordEvent,
  readEvents,
  computeMetrics,
  telemetryEnabled,
  TELEMETRY_EVENTS_REL,
  hasLeak,
  aboveAudienceStrings,
} from "../../dist/operator-loop/index.js";

const NOW = new Date("2026-06-30T12:00:00.000Z");
const ws = () => mkdtempSync(path.join(tmpdir(), "c8-telem-"));
const eventsPath = (dir) => path.join(dir, TELEMETRY_EVENTS_REL);

// Event builder for reducer tests — full shape (as readEvents would return).
function ev(kind, runId, at, payload, cadence = "weekly") {
  return {
    v: 1,
    kind,
    tier: "admin",
    runId,
    cadence,
    at,
    member: "alex",
    project: "acme",
    payload,
  };
}
const iso = (d) => new Date(d).toISOString();

// ── write side ────────────────────────────────────────────────────────────────────────────────

test("recordEvent appends one JSONL line and readEvents round-trips it", () => {
  const dir = ws();
  try {
    const ok = recordEvent(dir, {
      kind: "daily.run",
      runId: "r1",
      cadence: "daily",
      member: "alex",
      project: "acme",
      at: iso(NOW),
      payload: { durationMs: 5, signalCount: 3 },
    });
    assert.equal(ok, true);
    const { events, warnings } = readEvents(dir);
    assert.equal(warnings.length, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "daily.run");
    assert.equal(events[0].tier, "admin"); // always admin
    assert.equal(events[0].v, 1);
    assert.deepEqual(events[0].payload, { durationMs: 5, signalCount: 3 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AIOS_LOOP_TELEMETRY opt-out (0/OFF/' false '/no) writes nothing", () => {
  for (const val of ["0", "OFF", " false ", "no"]) {
    const dir = ws();
    try {
      assert.equal(telemetryEnabled({ AIOS_LOOP_TELEMETRY: val }), false, `disabled for ${val}`);
      const ok = recordEvent(
        dir,
        { kind: "daily.run", runId: "r", cadence: "daily", member: "a", project: "p", payload: {} },
        { AIOS_LOOP_TELEMETRY: val }
      );
      assert.equal(ok, false);
      assert.equal(existsSync(eventsPath(dir)), false, `no file for ${val}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("recordEvent swallows an I/O error (a file where the telemetry dir must go) and never throws", () => {
  const dir = ws();
  try {
    // Make `.aios` a FILE so mkdirSync of `.aios/loop/telemetry` fails with ENOTDIR.
    writeFileSync(path.join(dir, ".aios"), "x");
    let ok;
    assert.doesNotThrow(() => {
      ok = recordEvent(dir, {
        kind: "weekly.run",
        runId: "r",
        cadence: "weekly",
        member: "a",
        project: "p",
        payload: {},
      });
    });
    assert.equal(ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── read side (fails closed with warnings) ──────────────────────────────────────────────────────

test("readEvents never silently drops: malformed / unknown-version / missing-fields each warn", () => {
  const dir = ws();
  try {
    mkdirSync(path.dirname(eventsPath(dir)), { recursive: true });
    const good = JSON.stringify(ev("weekly.run", "good", iso(NOW), { audiences: ["team"] }));
    const lines = [
      "", // blank → ignored, no warning
      good,
      "{not json", // malformed → no runId
      JSON.stringify({ v: 2, kind: "weekly.run", runId: "vv" }), // unknown-version, attributable
      JSON.stringify({ v: 1, kind: "weekly.run", runId: "mf" }), // missing fields, attributable
      "42", // parseable non-object → missing-fields, unattributable
    ];
    writeFileSync(eventsPath(dir), lines.join("\n") + "\n");
    const { events, warnings } = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].runId, "good");
    const malformed = warnings.find((w) => w.reason === "malformed-json");
    const unknown = warnings.find((w) => w.reason === "unknown-version");
    const missingAttributed = warnings.find(
      (w) => w.reason === "missing-fields" && w.runId === "mf"
    );
    assert.ok(malformed, "malformed warned");
    assert.equal(malformed.runId, undefined);
    assert.equal(unknown.runId, "vv", "unknown-version attributable");
    assert.ok(missingAttributed, "missing-fields attributable to mf");
    assert.equal(warnings.filter((w) => w.reason === "missing-fields").length, 2); // mf + "42"
    assert.ok(
      warnings.every((w) => typeof w.line === "number" && w.line >= 1),
      "every warning has a line"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── reducer: clean happy path ────────────────────────────────────────────────────────────────────

function cleanWeekly(runId, endedAt, { withApprove = false, approveAt, rows = [] } = {}) {
  const started = iso(new Date(endedAt).getTime() - 3 * 60000); // 3 min before ended
  const events = [
    ev("weekly.run", runId, endedAt, {
      startedAt: started,
      endedAt,
      durationMs: 4000,
      audiences: ["team"],
      anyFailed: false,
    }),
    ev("weekly.verify", runId, endedAt, {
      audience: "team",
      status: "pass",
      shippable: true,
      leakWithheld: 0,
    }),
    ev("weekly.shipped", runId, endedAt, { audience: "team", tierLeak: false }),
  ];
  if (withApprove)
    events.push(
      ev("weekly.approve", runId, approveAt ?? iso(new Date(endedAt).getTime() + 10 * 60000), {
        targets: ["sync"],
        wroteCount: rows.length ? 2 : 1,
        taskRowsWritten: rows,
        tierSafetyWithheld: false,
        exitCode: 0,
        nextWeekActionsProposed: rows.length,
      })
    );
  return events;
}

test("three clean weekly runs (out of JSONL order) → streak 3, verifier 100%, leak 0", () => {
  const events = [
    ...cleanWeekly("w2", iso("2026-06-23T00:00:00Z")),
    ...cleanWeekly("w3", iso("2026-06-29T00:00:00Z")),
    ...cleanWeekly("w1", iso("2026-06-16T00:00:00Z")),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.consecutiveCleanWeeklies.value, 3);
  assert.equal(m.consecutiveCleanWeeklies.met, true);
  assert.equal(m.tierLeakCount.value, 0);
  assert.equal(m.tierLeakCount.met, true);
  assert.equal(m.verifierShippableRate.value, 1);
  assert.equal(m.verifierShippableRate.met, true);
  assert.equal(m.breakdown.weeklyRuns, 3);
});

test("a non-clean run between clean runs resets the streak", () => {
  const mid = "wbad";
  const events = [
    ...cleanWeekly("wa", iso("2026-06-16T00:00:00Z")),
    // failed audience → not clean
    ev("weekly.run", mid, iso("2026-06-20T00:00:00Z"), {
      startedAt: iso("2026-06-20T00:00:00Z"),
      endedAt: iso("2026-06-20T00:00:00Z"),
      durationMs: 1000,
      audiences: ["team"],
      anyFailed: true,
    }),
    ev("weekly.verify", mid, iso("2026-06-20T00:00:00Z"), {
      audience: "team",
      status: "failed",
      shippable: false,
      leakWithheld: 0,
    }),
    ...cleanWeekly("wc", iso("2026-06-29T00:00:00Z")),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.consecutiveCleanWeeklies.value, 1); // longest run is 1 (wa, then reset, then wc)
});

test("a shipped tierLeak:true is counted and breaks clean", () => {
  const events = [
    ev("weekly.run", "wl", iso("2026-06-29T00:00:00Z"), {
      startedAt: iso("2026-06-29T00:00:00Z"),
      endedAt: iso("2026-06-29T00:00:00Z"),
      durationMs: 1000,
      audiences: ["team"],
      anyFailed: false,
    }),
    ev("weekly.verify", "wl", iso("2026-06-29T00:00:00Z"), {
      audience: "team",
      status: "pass",
      shippable: true,
      leakWithheld: 0,
    }),
    ev("weekly.shipped", "wl", iso("2026-06-29T00:00:00Z"), { audience: "team", tierLeak: true }),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.tierLeakCount.value, 1);
  assert.equal(m.tierLeakCount.met, false);
  assert.equal(m.consecutiveCleanWeeklies.value, 0);
});

// ── reducer: data quality ──────────────────────────────────────────────────────────────────────

test("unattributable corrupt line nulls tier-leak and streak (global blindness)", () => {
  const events = cleanWeekly("w1", iso("2026-06-29T00:00:00Z"));
  const warnings = [{ phase: "parse", line: 9, reason: "malformed-json" }];
  const m = computeMetrics(
    { events, warnings },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.tierLeakCount.met, null);
  assert.equal(m.consecutiveCleanWeeklies.met, null);
  assert.equal(m.breakdown.dataQuality.unattributableGaps, 1);
  assert.equal(m.breakdown.dataQuality.corruptLines, 1);
});

test("attributable warning degrades ONLY that run; tier-leak stays computed", () => {
  const events = [
    ...cleanWeekly("wgood", iso("2026-06-29T00:00:00Z")),
    ...cleanWeekly("wdeg", iso("2026-06-27T00:00:00Z")),
  ];
  const warnings = [{ phase: "parse", line: 3, reason: "unknown-version", runId: "wdeg" }];
  const m = computeMetrics(
    { events, warnings },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.tierLeakCount.met, true); // NOT nulled — attributable
  assert.deepEqual(m.breakdown.dataQuality.degradedRunIds, ["wdeg"]);
  // wdeg excluded from verifier denom + streak; only wgood counts as completed/clean
  assert.equal(m.breakdown.weeklyRuns, 1);
  assert.equal(m.verifierShippableRate.sampleSize, 1);
  assert.equal(m.consecutiveCleanWeeklies.value, 1);
});

test("orphan approve (no weekly.run) → semantic warning, excluded from acceptance", () => {
  const events = [
    ev("weekly.approve", "ghost", iso("2026-06-29T00:00:00Z"), {
      targets: ["sync"],
      wroteCount: 1,
      taskRowsWritten: ["k1"],
      tierSafetyWithheld: false,
      exitCode: 0,
      nextWeekActionsProposed: 1,
    }),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  const orphan = m.warnings.find((w) => w.phase === "semantic" && w.reason === "orphan-approve");
  assert.ok(orphan, "orphan-approve semantic warning present");
  assert.equal(orphan.runId, "ghost");
  assert.ok(orphan.detail && orphan.detail.length > 0, "carries debug detail");
  assert.equal(m.nextWeekActionAcceptance.sampleSize, 0);
  assert.equal(m.nextWeekActionAcceptance.met, null); // pending
});

// ── reducer: approval / acceptance ────────────────────────────────────────────────────────────

test("multi-writeback for one stamp → DISTINCT UNION of taskRowsWritten (no double-count)", () => {
  const endedAt = iso("2026-06-29T00:00:00Z");
  const events = [
    ...cleanWeekly("w1", endedAt),
    ev("weekly.approve", "w1", iso("2026-06-29T00:05:00Z"), {
      targets: ["sync"],
      wroteCount: 1,
      taskRowsWritten: ["k1", "k2"],
      tierSafetyWithheld: false,
      exitCode: 0,
      nextWeekActionsProposed: 3,
    }),
    ev("weekly.approve", "w1", iso("2026-06-29T00:10:00Z"), {
      targets: ["pm"],
      wroteCount: 1,
      taskRowsWritten: ["k2", "k3"], // k2 overlaps → union {k1,k2,k3}
      tierSafetyWithheld: false,
      exitCode: 0,
      nextWeekActionsProposed: 3,
    }),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.nextWeekActionAcceptance.value, 1); // the single run accepted actions
  assert.equal(m.nextWeekActionAcceptance.met, true);
  // Wall-clock ritual span uses the EARLIEST approve (00:05, +5min from run.startedAt at -3min... )
  // startedAt = endedAt-3min = 2026-06-28T23:57:00Z; earliest approve 00:05 → 8 min.
  assert.equal(m.weeklyWallClock.value, 8);
  assert.equal(m.weeklyWallClock.note, "1 ritual-span / 0 CLI-proxy");
});

test("--local-only approval (no rows) is an accepted run with 0 accepted actions", () => {
  const endedAt = iso("2026-06-29T00:00:00Z");
  const events = [
    ...cleanWeekly("w1", endedAt),
    ev("weekly.approve", "w1", iso("2026-06-29T00:05:00Z"), {
      targets: ["local"],
      wroteCount: 1,
      taskRowsWritten: [],
      tierSafetyWithheld: false,
      exitCode: 0,
      nextWeekActionsProposed: 2,
    }),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.nextWeekActionAcceptance.sampleSize, 1); // in denominator
  assert.equal(m.nextWeekActionAcceptance.value, 0); // 0 accepted actions
  assert.equal(m.nextWeekActionAcceptance.met, false);
});

test("a rejected (fail-closed) approval stays in denominator with 0 accepted actions", () => {
  const endedAt = iso("2026-06-29T00:00:00Z");
  const events = [
    ...cleanWeekly("w1", endedAt),
    ev("weekly.approve", "w1", iso("2026-06-29T00:05:00Z"), {
      targets: ["sync"],
      wroteCount: 0,
      taskRowsWritten: [],
      tierSafetyWithheld: true,
      exitCode: 2,
      nextWeekActionsProposed: 2,
    }),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.nextWeekActionAcceptance.sampleSize, 1);
  assert.equal(m.nextWeekActionAcceptance.value, 0);
});

// ── reducer: wall-clock fallback ─────────────────────────────────────────────────────────────────

test("wall-clock uses ritual span when approved, CLI proxy otherwise; note reports the split", () => {
  const events = [
    ...cleanWeekly("wapproved", iso("2026-06-28T00:00:00Z"), {
      withApprove: true,
      approveAt: iso("2026-06-28T00:05:00Z"), // startedAt = -3min → span 8 min
      rows: ["k1"],
    }),
    ...cleanWeekly("wproxy", iso("2026-06-29T00:00:00Z")), // no approve → durationMs 4000ms ≈ 0.07 min
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.weeklyWallClock.sampleSize, 2);
  assert.equal(m.weeklyWallClock.note, "1 ritual-span / 1 CLI-proxy");
  assert.equal(m.weeklyWallClock.met, true); // median of {8, ~0.07} < 20
});

// ── reducer: daily frequency ───────────────────────────────────────────────────────────────────

test("dailyRunFrequency: not wired → met null; wired + 0 runs → met false", () => {
  const empty = { events: [], warnings: [] };
  const notWired = computeMetrics(empty, { now: NOW, windowDays: 14, dailySourceWired: false });
  assert.equal(notWired.dailyRunFrequency.met, null);
  assert.match(notWired.dailyRunFrequency.note, /no daily source/);

  const wiredZero = computeMetrics(empty, { now: NOW, windowDays: 14, dailySourceWired: true });
  assert.equal(wiredZero.dailyRunFrequency.value, 0);
  assert.equal(wiredZero.dailyRunFrequency.met, false); // C4 exists, user didn't run it
});

test("dailyRunFrequency: distinct working days vs majority threshold", () => {
  // Five distinct weekdays leading up to NOW (Tue 2026-06-30). Use Mon..Fri that week.
  const days = ["2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26"];
  const events = days.map((d, i) =>
    ev("daily.run", `d${i}`, iso(`${d}T09:00:00Z`), { durationMs: 3, signalCount: 1 }, "daily")
  );
  // add a duplicate same-day run → still one distinct day
  events.push(
    ev("daily.run", "dup", iso("2026-06-22T18:00:00Z"), { durationMs: 3, signalCount: 1 }, "daily")
  );
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 14, dailySourceWired: true }
  );
  assert.equal(m.dailyRunFrequency.value, 5, "5 distinct days (dup collapsed)");
  assert.equal(m.breakdown.dailyRuns, 6, "6 raw daily.run events");
  // met iff distinct >= ceil(workingDays/2)
  assert.equal(m.dailyRunFrequency.met, 5 >= Math.ceil(m.dailyRunFrequency.sampleSize / 2));
});

// ── reducer: window filtering ────────────────────────────────────────────────────────────────────

test("windowDays excludes older events; --all (null) includes everything", () => {
  const events = [
    ...cleanWeekly("old", iso("2026-05-01T00:00:00Z")),
    ...cleanWeekly("recent", iso("2026-06-29T00:00:00Z")),
  ];
  const win = computeMetrics({ events, warnings: [] }, { now: NOW, windowDays: 14 });
  assert.equal(win.breakdown.weeklyRuns, 1, "only the recent run is in a 14d window");
  const all = computeMetrics({ events, warnings: [] }, { now: NOW, windowDays: null });
  assert.equal(all.breakdown.weeklyRuns, 2, "--all includes the old run");
  assert.equal(all.window.days, null);
});

// ── the independent leak re-check primitive (proves the quarantine would fire) ───────────────────

test("hasLeak + aboveAudienceStrings detect an admin phrase leaking into a team digest", () => {
  const manifest = {
    member: "alex",
    project: "acme",
    generatedAt: "2026-06-30T00:00:00.000Z",
    window: { cadence: "weekly", from: "2026-06-23", to: "2026-06-30" },
    signals: [
      {
        kind: "decision",
        source: "decision",
        tier: "admin",
        occurredAt: "2026-06-29T00:00:00.000Z",
        ref: { path: "5-personal/secret.md", row: "7", tier: "admin" },
        summary: "Acquisition of NorthstarWidgets closes in Q3",
      },
    ],
    excluded: [],
  };
  const above = aboveAudienceStrings(manifest, "team");
  assert.equal(hasLeak("clean team digest with no secrets", above), false);
  assert.equal(
    hasLeak("weekly digest — Acquisition of NorthstarWidgets closes in Q3", above),
    true,
    "an admin phrase in the shipped bytes is caught"
  );
});

// ── review fixes: fail-closed reads + tail streak ────────────────────────────────────────────────

test("an unreadable ledger (exists but can't be read) → warning, nulls tier-leak + streak", () => {
  const dir = ws();
  try {
    // events.jsonl as a DIRECTORY: existsSync is true, readFileSync throws EISDIR → "unreadable".
    mkdirSync(eventsPath(dir), { recursive: true });
    const read = readEvents(dir);
    assert.equal(read.events.length, 0);
    assert.equal(read.warnings.length, 1);
    assert.equal(read.warnings[0].reason, "unreadable");
    assert.equal(read.warnings[0].runId, undefined, "unattributable");
    const m = computeMetrics(read, { now: NOW, windowDays: 14, dailySourceWired: true });
    assert.equal(m.tierLeakCount.met, null, "cannot certify zero leaks from an unreadable ledger");
    assert.equal(m.consecutiveCleanWeeklies.met, null);
    assert.equal(m.breakdown.dataQuality.unattributableGaps, 1);
    assert.equal(m.breakdown.dataQuality.corruptLines, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an event with a non-parseable `at` is rejected with a warning (not silently dropped)", () => {
  const dir = ws();
  try {
    mkdirSync(path.dirname(eventsPath(dir)), { recursive: true });
    const bad = JSON.stringify({
      ...ev("weekly.run", "bad", "not-a-date", { audiences: ["team"] }),
    });
    const good = JSON.stringify(ev("weekly.run", "good", iso(NOW), { audiences: ["team"] }));
    writeFileSync(eventsPath(dir), bad + "\n" + good + "\n");
    const { events, warnings } = readEvents(dir);
    assert.equal(events.length, 1, "only the good event is accepted");
    assert.equal(events[0].runId, "good");
    const w = warnings.find((x) => x.reason === "missing-fields" && x.runId === "bad");
    assert.ok(w, "the bad-timestamp line warns (attributable), never silently vanishes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("consecutiveCleanWeeklies is the TAIL streak: 3 clean then a leaked most-recent → 0", () => {
  const events = [
    ...cleanWeekly("w1", iso("2026-06-20T00:00:00Z")),
    ...cleanWeekly("w2", iso("2026-06-24T00:00:00Z")),
    ...cleanWeekly("w3", iso("2026-06-27T00:00:00Z")),
    // most recent run ships a leak → tail streak resets to 0 even though 3 earlier runs were clean
    ev("weekly.run", "w4", iso("2026-06-29T00:00:00Z"), {
      startedAt: iso("2026-06-29T00:00:00Z"),
      endedAt: iso("2026-06-29T00:00:00Z"),
      durationMs: 1000,
      audiences: ["team"],
      anyFailed: false,
    }),
    ev("weekly.verify", "w4", iso("2026-06-29T00:00:00Z"), {
      audience: "team",
      status: "pass",
      shippable: true,
      leakWithheld: 0,
    }),
    ev("weekly.shipped", "w4", iso("2026-06-29T00:00:00Z"), { audience: "team", tierLeak: true }),
  ];
  const m = computeMetrics(
    { events, warnings: [] },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.equal(m.consecutiveCleanWeeklies.value, 0, "trailing streak is 0, not the best-of-3");
  assert.equal(m.consecutiveCleanWeeklies.met, false);
  assert.equal(m.tierLeakCount.value, 1);
});

test("a degraded most-recent weekly breaks the tail streak", () => {
  const events = [
    ...cleanWeekly("w1", iso("2026-06-20T00:00:00Z")),
    ...cleanWeekly("w2", iso("2026-06-24T00:00:00Z")),
    ...cleanWeekly("w3", iso("2026-06-27T00:00:00Z")),
    ...cleanWeekly("w4", iso("2026-06-29T00:00:00Z")),
  ];
  const warnings = [{ phase: "parse", line: 99, reason: "missing-fields", runId: "w4" }];
  const m = computeMetrics(
    { events, warnings },
    { now: NOW, windowDays: 30, dailySourceWired: true }
  );
  assert.deepEqual(m.breakdown.dataQuality.degradedRunIds, ["w4"]);
  assert.equal(m.breakdown.weeklyRuns, 3, "degraded run is excluded from completed metrics");
  assert.equal(m.consecutiveCleanWeeklies.value, 0, "degraded latest run breaks the tail streak");
  assert.equal(m.consecutiveCleanWeeklies.met, false);
  assert.equal(m.tierLeakCount.met, true, "attributable warning does not null global leak metric");
});
