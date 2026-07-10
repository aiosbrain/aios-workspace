import test from "node:test";
import assert from "node:assert/strict";

import { detectClaudePlan, mapPlan, PLAN_PRICES } from "../scripts/analyze/claude-plan.mjs";
import { fetchAnthropicApiCost } from "../scripts/analyze/anthropic-admin.mjs";
import { buildCostPushPayloads } from "../scripts/analyze/cost-report.mjs";

test("mapPlan resolves rateLimitTier and subscriptionType", () => {
  assert.equal(mapPlan("max", "default_claude_max_20x"), "max_20x");
  assert.equal(mapPlan("max", "default_claude_max_5x"), "max_5x");
  assert.equal(mapPlan("max", ""), "max_5x"); // ambiguous → 5x default (override in config)
  assert.equal(mapPlan("pro", ""), "pro");
  assert.equal(mapPlan("nonsense", "nonsense"), null);
});

test("detectClaudePlan: config monthly_usd override wins (no keychain read)", () => {
  const p = detectClaudePlan({
    config: { claude: { plan: "max_20x", monthly_usd: 200 } },
    env: {},
  });
  assert.equal(p.source, "config");
  assert.equal(p.monthly_usd, 200);
  assert.equal(p.plan, "max_20x");
  assert.equal(p.billing, "subscription");
});

test("detectClaudePlan: env override wins over config", () => {
  const p = detectClaudePlan({
    config: { claude: { monthly_usd: 100 } },
    env: { AIOS_CLAUDE_MONTHLY_USD: "250", AIOS_CLAUDE_PLAN: "custom" },
  });
  assert.equal(p.monthly_usd, 250);
  assert.equal(p.source, "config");
});

test("detectClaudePlan: plan-only config maps to list price", () => {
  const p = detectClaudePlan({ config: { claude: { plan: "pro" } }, env: {} });
  assert.equal(p.monthly_usd, PLAN_PRICES.pro);
  assert.equal(p.plan, "pro");
});

test("fetchAnthropicApiCost: no admin key → null (silent skip)", async () => {
  const r = await fetchAnthropicApiCost({ sinceMs: 0, endMs: 1, env: {} });
  assert.equal(r, null);
});

test("fetchAnthropicApiCost: parses cents→USD, buckets by day, sums models", async () => {
  const canned = {
    data: [
      {
        starting_at: "2026-07-08T00:00:00Z",
        ending_at: "2026-07-09T00:00:00Z",
        results: [
          { amount: "123.45", currency: "USD", cost_type: "tokens", model: "claude-opus-4-8" },
          { amount: "76.55", currency: "USD", cost_type: "tokens", model: "claude-sonnet-5" },
        ],
      },
      {
        starting_at: "2026-07-09T00:00:00Z",
        ending_at: "2026-07-10T00:00:00Z",
        results: [{ amount: "50", currency: "USD", cost_type: "web_search", model: null }],
      },
    ],
    has_more: false,
    next_page: null,
  };
  const fetchImpl = async () => ({ ok: true, json: async () => canned });
  const r = await fetchAnthropicApiCost({
    sinceMs: Date.parse("2026-07-08"),
    endMs: Date.parse("2026-07-10"),
    env: { ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test" },
    fetchImpl,
  });
  // 123.45 + 76.55 + 50 cents = 250 cents = $2.50
  assert.equal(r.total_usd, 2.5);
  assert.equal(r.days.length, 2);
  assert.equal(r.days[0].date, "2026-07-08");
  assert.equal(r.days[0].cost_usd, 2.0); // (123.45+76.55)/100
  assert.equal(r.days[1].cost_usd, 0.5);
  assert.equal(r.models["claude-opus-4-8"], 1.2345);
});

test("fetchAnthropicApiCost: 403 (individual account) → {error}", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => "forbidden" });
  const r = await fetchAnthropicApiCost({
    sinceMs: 0,
    endMs: 1,
    env: { ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test" },
    fetchImpl,
  });
  assert.equal(r.status, 403);
  assert.match(r.error, /org Admin key/);
});

test("buildCostPushPayloads emits a real anthropic row (source=admin-cost, meta.real)", () => {
  const payloads = buildCostPushPayloads(
    { anthropic: { days: [{ date: "2026-07-09", cost_usd: 12.34 }] } },
    "john",
    "aios"
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].provider, "anthropic");
  assert.equal(payloads[0].source, "admin-cost");
  assert.equal(payloads[0].meta.real, true);
  assert.equal(payloads[0].cost_usd, 12.34);
});
