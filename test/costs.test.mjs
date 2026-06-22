import test from "node:test";
import assert from "node:assert/strict";

import { buildCostPushPayloads, renderAiSpendMarkdown } from "../scripts/analyze/cost-report.mjs";

test("buildCostPushPayloads emits cursor + claude rows", () => {
  const result = {
    project: "aios",
    window: { since: "2026-06-18", until: "2026-06-22" },
    cursor: {
      days: [
        {
          date: "2026-06-22",
          cost_usd: 83.8,
          events: 116,
          input: 1000,
          output: 200,
          cache_read: 5000,
          overage_usd: 40.81,
          included_usd: 42.99,
          models: { "gpt-5.3-codex": 31.25 },
        },
      ],
    },
    claude: {
      days: [
        {
          date: "2026-06-22",
          cost_usd: 12.5,
          events: 40,
          input_tokens: 100,
          output_tokens: 50,
          cache_read_tokens: 0,
        },
      ],
    },
  };
  const payloads = buildCostPushPayloads(result, "john", "aios");
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].provider, "cursor");
  assert.equal(payloads[0].source, "dashboard-api");
  assert.equal(payloads[0].meta.overage_usd, 40.81);
  assert.equal(payloads[1].provider, "claude");
  assert.equal(payloads[1].meta.estimated, true);
});

test("renderAiSpendMarkdown includes team frontmatter", () => {
  const md = renderAiSpendMarkdown({
    window: { since: "2026-06-18", until: "2026-06-22" },
    cursor: { totals: { cost_usd: 150, events: 220 }, days: [] },
    claude: { totals: { cost_usd: 20 }, days: [] },
  });
  assert.match(md, /^---\naccess: team/);
  assert.match(md, /Cursor \(billing dashboard\)/);
});
