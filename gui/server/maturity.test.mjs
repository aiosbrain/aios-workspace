import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMaturityPayload } from "./maturity.mjs";
import { AXIS_GUIDE, ergonomicsTip } from "../../scripts/analyze/guidance.mjs";
import { AXIS_LABELS } from "../../scripts/analyze/aem.mjs";

// A representative `analyze --json` document (subset of report.mjs `toJson`).
const SAMPLE = {
  window: { since: "2026-06-03", until: "2026-07-03" },
  tools: ["claude"],
  totals: { sessions: 12, tasks: 40, events: 300, total_tokens: 1000 },
  signals: {},
  placement: {
    axes: {
      verification: 1,
      context_hygiene: 3,
      autonomy: 2,
      learning: 2,
      cost_governance: 3,
    },
    spine: "L2",
    overall: 2.2,
    weakest: "verification",
  },
  axes_shadow: { cognitive_ergonomics: 2 },
  attention: { reading: "orchestration-heavy — protect focus blocks" },
  days: [
    { date: "2026-07-01", signals: {}, placement: { overall: 2.0 }, axes_shadow: { cognitive_ergonomics: 1 } },
    { date: "2026-07-02", signals: {}, placement: { overall: 2.2 }, axes_shadow: { cognitive_ergonomics: null } },
    { date: "2026-07-03", signals: {}, placement: { overall: 2.2 }, axes_shadow: { cognitive_ergonomics: 3 } },
  ],
};

test("payload merges guidance + labels + glosses for each axis", () => {
  const p = buildMaturityPayload(JSON.stringify(SAMPLE));
  // weakest guidance is the AXIS_GUIDE entry for placement.weakest
  assert.deepEqual(p.guidance.weakest, AXIS_GUIDE.verification);
  // every axis carries its label + gloss
  for (const a of p.axes) {
    assert.equal(a.label, AXIS_LABELS[a.key]);
    assert.equal(a.gloss, AXIS_GUIDE[a.key].gloss);
  }
  // ergonomics tip is the ergonomicsTip() string for the attention reading
  assert.equal(p.guidance.ergonomics_tip, ergonomicsTip(SAMPLE.attention.reading));
  assert.notEqual(p.guidance.ergonomics_tip, "");
});

test("placement fields + per-axis scores pass through unchanged", () => {
  const p = buildMaturityPayload(JSON.stringify(SAMPLE));
  assert.equal(p.spine, "L2");
  assert.equal(p.overall, 2.2);
  assert.equal(p.weakest, "verification");
  assert.equal(p.ce_band, 2);
  const byKey = Object.fromEntries(p.axes.map((a) => [a.key, a.score]));
  assert.deepEqual(byKey, SAMPLE.placement.axes);
});

test("days reshape to {date, am, ce} preserving null CE", () => {
  const p = buildMaturityPayload(JSON.stringify(SAMPLE));
  assert.deepEqual(p.days, [
    { date: "2026-07-01", am: 2.0, ce: 1 },
    { date: "2026-07-02", am: 2.2, ce: null },
    { date: "2026-07-03", am: 2.2, ce: 3 },
  ]);
});

test("malformed stdout throws an unparseable error", () => {
  assert.throws(() => buildMaturityPayload("<not json>"), /unparseable/);
});

test("W2-absent (no ergonomicsTip) degrades to empty CE tip, no throw", () => {
  const p = buildMaturityPayload(JSON.stringify(SAMPLE), { ergonomicsTip: undefined });
  assert.equal(p.guidance.ergonomics_tip, "");
  // the rest of the payload is still well-formed
  assert.equal(p.weakest, "verification");
  assert.equal(p.axes.length, 5);
});

test("empty / zeroed analyze run yields a well-formed payload", () => {
  const p = buildMaturityPayload(JSON.stringify({}));
  assert.deepEqual(p.window, null);
  assert.equal(p.spine, null);
  assert.equal(p.overall, null);
  assert.equal(p.weakest, null);
  assert.deepEqual(p.axes, []);
  assert.equal(p.ce_band, null);
  assert.deepEqual(p.days, []);
  assert.deepEqual(p.guidance.weakest, null);
  assert.equal(p.guidance.ergonomics_tip, "");
});
