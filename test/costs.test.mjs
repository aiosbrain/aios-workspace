import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildClaudeCostFromEvents,
  buildCodexCostFromEvents,
  buildCostPushPayloads,
  renderAiSpendMarkdown,
  renderCostSummary,
} from "../scripts/analyze/cost-report.mjs";
import { writeAiSpendMarkdown } from "../scripts/analyze/push-costs.mjs";

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

test("buildCostPushPayloads emits a codex row (source=session-logs, estimated)", () => {
  const result = {
    codex: {
      days: [
        {
          date: "2026-07-09",
          cost_usd: 4.2,
          events: 18,
          input_tokens: 300,
          output_tokens: 120,
          cache_read_tokens: 50,
        },
      ],
    },
  };
  const payloads = buildCostPushPayloads(result, "john", "aios");
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].provider, "codex");
  assert.equal(payloads[0].source, "session-logs");
  assert.equal(payloads[0].meta.estimated, true);
  assert.equal(payloads[0].cost_usd, 4.2);
  assert.equal(payloads[0].events, 18);
});

test("buildCodexCostFromEvents buckets codex assistant usage by UTC day", () => {
  const events = [
    {
      tool: "codex",
      session_id: "s1",
      ts: "2026-07-09T10:00:00.000Z",
      actor: "assistant",
      tokens: { in: 1_000_000, out: 0, cache_read: 0, cache_create: 0 },
      model: "gpt-5.3-codex-spark",
    },
    {
      tool: "claude",
      session_id: "s2",
      ts: "2026-07-09T10:00:00.000Z",
      actor: "assistant",
      tokens: { in: 1_000_000, out: 0, cache_read: 0, cache_create: 0 },
      model: "claude-sonnet-4-6",
    },
  ];
  const report = buildCodexCostFromEvents(events, Date.parse("2026-07-09T00:00:00.000Z"));
  assert.ok(report);
  assert.equal(report.days.length, 1);
  assert.equal(report.days[0].date, "2026-07-09");
  assert.ok(report.days[0].cost_usd > 0);
  assert.equal(report.days[0].events, 1);
});

test("renderCostSummary lists a Codex (est.) line", () => {
  const text = renderCostSummary(
    {
      window: { since: "2026-07-09", until: "2026-07-09" },
      codex: { totals: { cost_usd: 4.2, events: 18 } },
    },
    { dim: (s) => s, yellow: (s) => s }
  );
  assert.match(text, /Codex \(est\.\).*4\.20/);
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

test("buildClaudeCostFromEvents buckets claude assistant usage by UTC day", () => {
  const events = [
    {
      tool: "claude",
      session_id: "s1",
      ts: "2026-06-22T10:00:00.000Z",
      actor: "assistant",
      tokens: { in: 1_000_000, out: 0, cache_read: 0, cache_create: 0 },
      model: "claude-sonnet-4-6",
    },
    {
      tool: "cursor",
      session_id: "s2",
      ts: "2026-06-22T10:00:00.000Z",
      actor: "assistant",
      tokens: { in: 1_000_000, out: 0, cache_read: 0, cache_create: 0 },
      model: "gpt-5",
    },
  ];
  const report = buildClaudeCostFromEvents(events, Date.parse("2026-06-22T00:00:00.000Z"));
  assert.ok(report);
  assert.equal(report.days.length, 1);
  assert.equal(report.days[0].date, "2026-06-22");
  assert.ok(report.days[0].cost_usd > 0);
  assert.equal(report.days[0].events, 1);
});

test("renderCostSummary lists cursor and claude lines", () => {
  const text = renderCostSummary(
    {
      window: { since: "2026-06-22", until: "2026-06-22" },
      cursor: { totals: { cost_usd: 29.37, events: 34 } },
      claude: { totals: { cost_usd: 12.5, events: 40 } },
    },
    { dim: (s) => s, yellow: (s) => s }
  );
  assert.match(text, /Cursor \(billing\).*29\.37/);
  assert.match(text, /Claude \(est\.\).*12\.50/);
});

test("writeAiSpendMarkdown writes 3-log/ai-spend.md", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-cost-"));
  try {
    const file = writeAiSpendMarkdown(dir, {
      window: { since: "2026-06-22", until: "2026-06-22" },
      cursor: { totals: { cost_usd: 10, events: 2 }, days: [] },
    });
    assert.equal(file, path.join(dir, "3-log", "ai-spend.md"));
    assert.match(readFileSync(file, "utf8"), /access: team/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
