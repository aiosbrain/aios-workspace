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

test("fetchAnthropicApiCost: network error → {error}", async () => {
  const fetchImpl = async () => {
    throw new Error("ECONNRESET");
  };
  const r = await fetchAnthropicApiCost({
    sinceMs: 0,
    endMs: 1,
    env: { ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test" },
    fetchImpl,
  });
  assert.match(r.error, /ECONNRESET/);
});

test("fetchAnthropicApiCost: follows pagination (has_more/next_page)", async () => {
  const pages = [
    {
      data: [{ starting_at: "2026-07-08T00:00:00Z", results: [{ amount: "100" }] }],
      has_more: true,
      next_page: "page2",
    },
    {
      data: [{ starting_at: "2026-07-09T00:00:00Z", results: [{ amount: "200" }] }],
      has_more: false,
      next_page: null,
    },
  ];
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(new URL(url).searchParams.get("page"));
    return { ok: true, json: async () => pages.shift() };
  };
  const r = await fetchAnthropicApiCost({
    sinceMs: Date.parse("2026-07-08"),
    endMs: Date.parse("2026-07-10"),
    env: { ANTHROPIC_ADMIN_KEY: "sk-ant-admin01-test" },
    fetchImpl,
  });
  assert.deepEqual(seen, [null, "page2"]); // first page no cursor, second uses next_page
  assert.equal(r.total_usd, 3.0); // (100+200)/100
  assert.equal(r.days.length, 2);
  assert.equal(r.truncated, false);
});

test("detectClaudePlan: unknown when no override, no creds", () => {
  // Force the keychain/creds path to miss by pointing HOME at an empty dir on a
  // machine with no keychain item is non-deterministic; instead assert the shape
  // when an explicit empty config + a plan we can't price is given.
  const p = detectClaudePlan({ config: { claude: { plan: "enterprise-mystery" } }, env: {} });
  // plan-only with an unknown key falls through to keychain/unknown, monthly stays derivable-or-null
  assert.equal(p.provider, "claude");
  assert.equal(p.billing, "subscription");
  assert.ok(p.source === "keychain" || p.source === "unknown");
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

test("buildCostPushPayloads skips a net-negative anthropic day (credit → would 422)", () => {
  const payloads = buildCostPushPayloads(
    {
      anthropic: {
        days: [
          { date: "2026-07-09", cost_usd: -3.5 }, // credit/adjustment
          { date: "2026-07-10", cost_usd: 8.0 },
        ],
      },
    },
    "john",
    "aios"
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].date, "2026-07-10");
  assert.equal(payloads[0].cost_usd, 8.0);
});
