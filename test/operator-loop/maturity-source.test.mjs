import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "../../dist/operator-loop/index.js";
import { projectSlug } from "../../scripts/analyze/maturity-fold.mjs";

const STORE_REL = ".aios/loop/maturity/sessions.ndjson";
const NOW = new Date("2026-07-02T00:00:00Z");

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "aios-ws-maturity-"));
  mkdirSync(path.join(root, "1-inbox"), { recursive: true });
  mkdirSync(path.join(root, "3-log"), { recursive: true });
  return realpathSync(root);
}

function writeStore(root, sessions) {
  const abs = path.join(root, STORE_REL);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    sessions.map((s) => JSON.stringify({ v: 1, op: "put", session: s })).join("\n") + "\n"
  );
}

// A realistic AM1 session snapshot (hooks/maturity-capture.mjs shape); the store tags each
// session with the slug of the cwd it ran in — reuse the SAME slug rule the source filters by.
function session(root, overrides = {}) {
  return {
    session_id: "s-1",
    tool: "claude",
    project: projectSlug(root),
    ended_at: "2026-07-01T12:00:00Z",
    event_count: 10,
    signals: { subagent_usage: 1, tool_diversity: 5 },
    counts: {
      in_tok: 1000,
      out_tok: 500,
      cache_read_tok: 2000,
      cache_create_tok: 300,
      subagent_tok: 400,
      tool_use_total: 20,
      verify_tool_uses: 5,
      tool_results: 20,
      tool_result_errors: 1,
      tasks: 2,
      permission_events: 1,
    },
    tier: "admin",
    ...overrides,
  };
}

test("maturity source: emits ONE aggregate kind:'maturity' signal per the domain contract", () => {
  const root = workspace();
  writeStore(root, [
    session(root),
    session(root, { session_id: "s-2", ended_at: "2026-07-01T18:00:00Z" }),
  ]);

  const m = collect({ root, cadence: "weekly", now: NOW });
  const sigs = m.signals.filter((s) => s.kind === "maturity");
  assert.equal(sigs.length, 1);
  const s = sigs[0];
  assert.equal(s.source, "analyze");
  assert.equal(s.tier, "admin"); // local telemetry — never syncs; collector retains admin
  assert.equal(s.occurredAt, "2026-07-01T18:00:00.000Z"); // latest in-window session
  assert.equal(s.ref.path, STORE_REL);
  assert.equal(s.ref.row, "s-2"); // latest captured session anchors the evidence row
  assert.equal(s.ref.tier, "admin");
  // Payload contract: { placement (L0-L5), axisScores, costTotals, sessionCount }.
  assert.match(s.payload.placement, /^L[0-5]$/);
  assert.equal(typeof s.payload.axisScores, "object");
  for (const v of Object.values(s.payload.axisScores)) assert.equal(typeof v, "number");
  assert.equal(s.payload.sessionCount, 2);
  assert.equal(s.payload.costTotals.in_tok, 2000);
  assert.equal(s.payload.costTotals.subagent_tok, 800);
  assert.equal(s.payload.costTotals.total_tok, 7600); // in+out+cache_read+cache_create
  assert.match(s.summary, /^AEM L[0-5] — 2 sessions, weakest axis: /);
});

test("maturity source: absent store → empty signals, never a throw", () => {
  const root = workspace();
  const m = collect({ root, cadence: "weekly", now: NOW });
  assert.equal(m.signals.filter((s) => s.kind === "maturity").length, 0);
});

test("maturity source: 7-day max lookback windows the fold; a stale-only store emits nothing", () => {
  const root = workspace();
  writeStore(root, [
    session(root, { session_id: "fresh", ended_at: "2026-06-29T12:00:00Z" }), // 3d old
    session(root, { session_id: "stale", ended_at: "2026-06-20T12:00:00Z" }), // 12d old
    session(root, { session_id: "future", ended_at: "2026-07-03T12:00:00Z" }), // future-dated
  ]);

  const m = collect({ root, cadence: "weekly", now: NOW });
  const sigs = m.signals.filter((s) => s.kind === "maturity");
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].payload.sessionCount, 1); // only the 3-day-old session folds
  assert.equal(sigs[0].ref.row, "fresh");
  assert.equal(sigs[0].occurredAt, "2026-06-29T12:00:00.000Z");

  // Only stale sessions → the source emits nothing at all (no zero-session aggregate).
  const staleRoot = workspace();
  writeStore(staleRoot, [session(staleRoot, { ended_at: "2026-06-20T12:00:00Z" })]);
  const m2 = collect({ root: staleRoot, cadence: "weekly", now: NOW });
  assert.equal(m2.signals.filter((s) => s.kind === "maturity").length, 0);
});

test("maturity source: weekly-only kind — the daily cadence does not collect it", () => {
  const root = workspace();
  writeStore(root, [session(root)]);
  const m = collect({ root, cadence: "daily", now: NOW });
  assert.equal(m.signals.filter((s) => s.kind === "maturity").length, 0);
});

test("maturity source: co-mingled other-project sessions are filtered out of the fold", () => {
  const root = workspace();
  writeStore(root, [
    session(root),
    session(root, { session_id: "other", project: "some-other-repo" }),
  ]);

  const m = collect({ root, cadence: "weekly", now: NOW });
  const sigs = m.signals.filter((s) => s.kind === "maturity");
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].payload.sessionCount, 1);
  assert.equal(sigs[0].ref.row, "s-1");
});
