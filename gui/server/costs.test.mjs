import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCostsPayload, currentPeriod } from "./costs.mjs";

const PERIOD = "2026-07";

// A representative `analyze --json` costs block (subset of report.mjs `toJson`).
// claude/codex carry token-ESTIMATE dollars (12.5 / 987.65) that must NEVER
// surface; cursor/anthropic/opencode carry real billed/session dollars.
const SAMPLE = {
  window: { since: "2026-06-09", until: "2026-07-09" },
  costs: {
    cursor: {
      totals: { cost_usd: 35, events: 40 },
      days: [
        { date: "2026-06-30", cost_usd: 5, events: 4 }, // outside the current month
        { date: "2026-07-08", cost_usd: 30, events: 36 },
      ],
      truncated: false,
    },
    claude: {
      totals: { cost_usd: 12.5, events: 20 }, // token estimate — must never appear
      days: [{ date: "2026-07-08", cost_usd: 12.5, events: 20, input_tokens: 300 }],
    },
    codex: {
      totals: { cost_usd: 987.65, events: 6 }, // token estimate — must never appear
      days: [{ date: "2026-07-09", cost_usd: 987.65, events: 6, input_tokens: 100 }],
    },
    anthropic: {
      total_usd: 44.5,
      days: [
        { date: "2026-06-28", cost_usd: 2 },
        { date: "2026-07-09", cost_usd: 42.5 },
      ],
    },
    opencode: {
      totals: { cost_usd: 3.25, events: 5 },
      days: [{ date: "2026-07-05", cost_usd: 3.25, events: 5 }],
    },
    plan: {
      provider: "claude",
      label: "Max 20×",
      plan: "max_20x",
      monthly_usd: 200,
      source: "keychain",
    },
    cursor_error: null,
  },
};

const build = (config = {}, sample = SAMPLE) =>
  buildCostsPayload(JSON.stringify(sample), { config, period: PERIOD });

const provider = (p, key) => p.by_provider.find((b) => b.provider === key);

test("token estimates are completely excluded from the response", () => {
  const p = build();
  const raw = JSON.stringify(p);
  // The estimate dollar values, token counts, and old estimate-era fields are gone.
  assert.ok(!raw.includes("12.5"), "claude token-estimate $ leaked");
  assert.ok(!raw.includes("987.65"), "codex token-estimate $ leaked");
  assert.ok(!raw.includes("tokensByDay") && !raw.includes("spendByDay"));
  assert.ok(!raw.includes("input_tokens") && !raw.includes("estimated"));
  // codex has activity but no actual source → honest unknown, never a number.
  const codex = provider(p, "codex");
  assert.equal(codex.status, "unknown");
  assert.equal(codex.total_usd, null);
  assert.equal(codex.lines, 0);
  assert.equal(p.config_status.complete, false);
  assert.deepEqual(p.config_status.unknown, ["codex"]);
});

test("billing/session actuals are month-scoped ledger lines with provenance", () => {
  const p = build();
  assert.equal(p.period, PERIOD);
  const cursor = p.lines.find((l) => l.provider === "cursor");
  assert.equal(cursor.amount_usd, 30); // June's $5 excluded from July
  assert.equal(cursor.source, "billing");
  assert.equal(cursor.kind, "metered");
  const anthropic = p.lines.find((l) => l.provider === "anthropic");
  assert.equal(anthropic.amount_usd, 42.5);
  assert.equal(anthropic.source, "billing");
  const opencode = p.lines.find((l) => l.provider === "opencode");
  assert.equal(opencode.amount_usd, 3.25);
  assert.equal(opencode.source, "session");
  assert.equal(provider(p, "opencode").status, "billing");
  // Every line carries provider/kind/source/period provenance.
  for (const l of p.lines) {
    assert.ok(l.provider && l.kind && l.source && l.period === PERIOD, JSON.stringify(l));
  }
});

test("detected Claude subscription is used when no config exists (never the estimate)", () => {
  const p = build();
  const claude = p.lines.find((l) => l.provider === "claude");
  assert.equal(claude.amount_usd, 200); // plan price, not the 12.5 estimate
  assert.equal(claude.kind, "subscription");
  assert.equal(claude.source, "detected");
  assert.equal(provider(p, "claude").status, "subscription");
});

test("precedence: explicit owner config beats billing", () => {
  const withCfg = build({ metered: { anthropic: { [PERIOD]: 99.99 } } });
  const a = withCfg.lines.find((l) => l.provider === "anthropic");
  assert.equal(a.amount_usd, 99.99);
  assert.equal(a.source, "config");
  assert.equal(provider(withCfg, "anthropic").status, "config");
  // Removing the config entry falls back down to the billing figure.
  const without = build({ metered: { anthropic: {} } });
  assert.equal(without.lines.find((l) => l.provider === "anthropic").amount_usd, 42.5);
  assert.equal(provider(without, "anthropic").status, "billing");
});

test("precedence: config beats detected subscription; sans both → unknown", () => {
  const cfg = build({ claude: { monthly_usd: 100 } }); // legacy shape
  const claude = cfg.lines.find((l) => l.provider === "claude");
  assert.equal(claude.amount_usd, 100);
  assert.equal(claude.source, "config");
  assert.equal(provider(cfg, "claude").status, "config");
  // No config + no detected plan + local activity → unknown, no synthesized $.
  const noPlan = structuredClone(SAMPLE);
  noPlan.costs.plan = { provider: "claude", plan: "unknown", monthly_usd: null, source: "unknown" };
  const unk = build({}, noPlan);
  assert.equal(provider(unk, "claude").status, "unknown");
  assert.equal(provider(unk, "claude").total_usd, null);
  assert.ok(unk.config_status.unknown.includes("claude"));
});

test("a configured subscription supersedes the provider usage value", () => {
  const p = build({ subscriptions: { cursor: { monthly_usd: 20 } } });
  const cursorLines = p.lines.filter((l) => l.provider === "cursor");
  assert.equal(cursorLines.length, 1);
  assert.equal(cursorLines[0].kind, "subscription");
  assert.equal(cursorLines[0].amount_usd, 20); // not the $30 usage value
  assert.equal(provider(p, "cursor").status, "config");
});

test("Anthropic API metered spend is additive to the Claude subscription", () => {
  const p = build({
    claude: { monthly_usd: 200 },
    metered: { anthropic: { [PERIOD]: 42.13 } },
  });
  assert.equal(p.lines.find((l) => l.provider === "claude").amount_usd, 200);
  assert.equal(p.lines.find((l) => l.provider === "anthropic").amount_usd, 42.13);
  // Both count in the month total (plus the untouched cursor/opencode billing lines).
  assert.equal(p.totals.month_usd, 200 + 42.13 + 30 + 3.25);
  // A configured codex subscription also stacks and clears the unknown flag.
  const full = build({
    claude: { monthly_usd: 200 },
    subscriptions: { codex: { monthly_usd: 0 } },
    metered: { anthropic: { [PERIOD]: 42.13 } },
  });
  assert.equal(full.config_status.complete, true);
  assert.equal(provider(full, "codex").total_usd, 0);
});

test("pre-existing cost-config shapes load unchanged (back-compat)", () => {
  // The documented legacy file: { "claude": { "plan": "max_20x", "monthly_usd": 200 } }
  const p = build({ claude: { plan: "max_20x", monthly_usd: 200 } });
  const claude = p.lines.find((l) => l.provider === "claude");
  assert.equal(claude.amount_usd, 200);
  assert.equal(claude.source, "config");
  // New-shape subscriptions.claude wins over the legacy key when both exist.
  const both = build({
    claude: { monthly_usd: 100 },
    subscriptions: { claude: { monthly_usd: 200 } },
  });
  assert.equal(both.lines.find((l) => l.provider === "claude").amount_usd, 200);
});

test("providers with no actuals and no activity are omitted; empty is complete", () => {
  const p = buildCostsPayload(JSON.stringify({ window: null, costs: {} }), { period: PERIOD });
  assert.deepEqual(p.lines, []);
  assert.deepEqual(p.by_provider, []);
  assert.equal(p.totals.month_usd, 0);
  assert.equal(p.config_status.complete, true);
  // A cursor billing error still surfaces cursor as honestly unknown.
  const errd = buildCostsPayload(
    JSON.stringify({ window: null, costs: { cursor_error: "not signed in" } }),
    { period: PERIOD }
  );
  assert.equal(provider(errd, "cursor").status, "unknown");
  assert.equal(errd.cursor_error, "not signed in");
});

test("rollups sort known spend first, unknown last", () => {
  const p = build();
  const statuses = p.by_provider.map((b) => b.total_usd);
  const firstNull = statuses.findIndex((v) => v == null);
  if (firstNull !== -1) {
    assert.ok(statuses.slice(firstNull).every((v) => v == null));
  }
  assert.equal(p.by_provider[0].provider, "claude"); // $200 tops the month
});

test("window coverage of the calendar month is surfaced, never silently partial", () => {
  // Window starts before the 1st → the month is fully covered.
  assert.equal(build().config_status.window_covers_month, true);
  // Window starts ON the 1st → covered.
  const onFirst = structuredClone(SAMPLE);
  onFirst.window = { since: "2026-07-01", until: "2026-07-16" };
  assert.equal(build({}, onFirst).config_status.window_covers_month, true);
  // Window starts after the 1st (the old rolling `30d` on the 31st) → flagged,
  // so a billing sum labeled "{period}" is never a silent undercount.
  const partial = structuredClone(SAMPLE);
  partial.window = { since: "2026-07-03", until: "2026-08-01" };
  assert.equal(build({}, partial).config_status.window_covers_month, false);
  // No window at all → nothing provable, no false alarm.
  const p = buildCostsPayload(JSON.stringify({ costs: {} }), { period: PERIOD });
  assert.equal(p.config_status.window_covers_month, true);
});

test("currentPeriod formats YYYY-MM (UTC)", () => {
  assert.equal(currentPeriod(new Date("2026-07-16T10:00:00Z")), "2026-07");
  assert.equal(currentPeriod(new Date("2026-12-31T23:59:59Z")), "2026-12");
});

test("buildCostsPayload throws on unparseable stdout", () => {
  assert.throws(() => buildCostsPayload("not json"), /unparseable/);
});
