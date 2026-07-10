import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCostsPayload } from "./costs.mjs";

// A representative `analyze --json` costs block (subset of report.mjs `toJson`).
const SAMPLE = {
  window: { since: "2026-06-09", until: "2026-07-09" },
  costs: {
    cursor: {
      totals: { cost_usd: 30, events: 40 },
      days: [
        { date: "2026-07-08", cost_usd: 30, events: 40, input: 1000, output: 200, cache_read: 50 },
      ],
      truncated: false,
    },
    claude: {
      totals: { cost_usd: 12.5, events: 20 },
      days: [
        {
          date: "2026-07-08",
          cost_usd: 5,
          events: 8,
          input_tokens: 300,
          output_tokens: 90,
          cache_read_tokens: 10,
        },
        {
          date: "2026-07-09",
          cost_usd: 7.5,
          events: 12,
          input_tokens: 400,
          output_tokens: 120,
          cache_read_tokens: 0,
        },
      ],
    },
    codex: {
      totals: { cost_usd: 2, events: 6 },
      days: [
        {
          date: "2026-07-09",
          cost_usd: 2,
          events: 6,
          input_tokens: 100,
          output_tokens: 40,
          cache_read_tokens: 0,
        },
      ],
    },
    opencode: null,
    cursor_error: null,
  },
};

test("buildCostsPayload unifies provider blocks into a dense series", () => {
  const p = buildCostsPayload(JSON.stringify(SAMPLE));
  assert.deepEqual(p.providers.sort(), ["claude", "codex", "cursor"]);
  // Two calendar days, providers 0-filled where absent.
  assert.equal(p.spendByDay.length, 2);
  const d8 = p.spendByDay.find((d) => d.date === "2026-07-08");
  assert.equal(d8.cursor, 30);
  assert.equal(d8.claude, 5);
  assert.equal(d8.codex, 0); // codex absent on the 8th → 0-filled
  const d9 = p.spendByDay.find((d) => d.date === "2026-07-09");
  assert.equal(d9.codex, 2);
  assert.equal(d9.cursor, 0);
  // Tokens tolerate both key styles (cursor input/output vs claude input_tokens).
  assert.equal(p.tokensByDay.find((t) => t.date === "2026-07-08").input, 1300);
  // Rollup carries provenance so the UI can label estimate vs billed.
  const cursor = p.by_provider.find((b) => b.provider === "cursor");
  assert.equal(cursor.estimated, false);
  assert.equal(cursor.source, "billing");
  assert.equal(p.by_provider.find((b) => b.provider === "claude").estimated, true);
  assert.equal(p.totals.cost_usd, 44.5);
});

test("buildCostsPayload tolerates an empty costs block", () => {
  const p = buildCostsPayload(JSON.stringify({ window: { since: "a", until: "b" }, costs: {} }));
  assert.deepEqual(p.providers, []);
  assert.deepEqual(p.spendByDay, []);
  assert.equal(p.totals.cost_usd, 0);
});

test("buildCostsPayload throws on unparseable stdout", () => {
  assert.throws(() => buildCostsPayload("not json"), /unparseable/);
});
