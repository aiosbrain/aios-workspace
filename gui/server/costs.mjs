/**
 * costs.mjs — pure reshaper for the cockpit Cost panel (actual spend ONLY).
 *
 * `buildCostsPayload(stdout, { config, period })` parses the JSON emitted by
 * `aios analyze --json` (scripts/analyze/report.mjs `toJson` → `out.costs`) and
 * emits the `CostResponse` contract: a ledger of ACTUAL dollar lines for the
 * current calendar month, a per-provider rollup, the month total, and a
 * configuration-completeness indicator.
 *
 * THE INVARIANT (AIO-457): token-based "API-equivalent" estimates NEVER appear
 * here — not as money, not as a chart. Per provider the actual figure resolves
 * with this precedence, and stops honestly at "unknown":
 *
 *   1. explicit owner config   (.aios/cost-config.json — subscriptions/metered)
 *   2. billing / admin API     (anthropic admin cost report, cursor billing,
 *                               opencode per-message session cost)
 *   3. detected subscription   (Claude plan read from the login token)
 *   4. unknown                 (activity seen, no actual source — NEVER estimate)
 *
 * A configured subscription supersedes a provider's "usage value" (e.g. a flat
 * Cursor plan beats the dashboard usage number). Anthropic API metered spend is
 * a separate provider line, so it is ADDITIVE to the Claude subscription.
 *
 * The analyze window must cover the whole calendar month (the route fetches
 * `--since 35d`); when it provably doesn't (window.since after the 1st), the
 * payload surfaces `config_status.window_covers_month: false` instead of
 * silently undercounting billing-sourced lines.
 *
 * Lives in its own module (not index.mjs, which self-boots an http server on
 * import) so it can be unit-tested without side effects. No npm dependencies —
 * config-value coercion is shared with cost-config.mjs so the ledger and the
 * Settings surface always agree on what a config value is worth.
 */

import { configSubscriptionUsd, configMeteredUsd } from "./cost-config.mjs";

/** Display order + labels for the providers analyze can emit. */
export const PROVIDER_META = [
  { key: "claude", label: "Claude" },
  { key: "anthropic", label: "Anthropic API" },
  { key: "cursor", label: "Cursor" },
  { key: "codex", label: "Codex" },
  { key: "openai", label: "OpenAI API" },
  { key: "opencode", label: "OpenCode" },
  { key: "openrouter", label: "OpenRouter" },
  { key: "zai", label: "Z.ai" },
];

const LABELS = Object.fromEntries(PROVIDER_META.map((p) => [p.key, p.label]));

function round2(v) {
  return Math.round(v * 100) / 100;
}

function usdOrNull(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

/** Current calendar month as YYYY-MM (UTC, matching analyze's UTC day buckets). */
export function currentPeriod(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * Sum a provider block's billed days that fall inside the period (YYYY-MM).
 * `field` selects which per-day amount to total — default `cost_usd` (all billed
 * usage), or `overage_usd` for plan providers where included usage is already
 * covered by the flat fee and must not be re-counted as metered spend.
 */
function monthTotal(block, period, field = "cost_usd") {
  const days = Array.isArray(block?.days) ? block.days : [];
  let sum = 0;
  for (const d of days) {
    if (!d || typeof d.date !== "string" || d.date.slice(0, 7) !== period) continue;
    const v = usdOrNull(d[field]);
    if (v != null) sum += v;
  }
  return round2(sum);
}

/** True when analyze saw any activity for this provider block. */
function hasActivity(block) {
  if (!block) return false;
  if (Array.isArray(block.days) && block.days.length) return true;
  return block.totals != null || block.total_usd != null;
}

function line(provider, kind, amount_usd, source, period, note) {
  const out = { provider, label: LABELS[provider] ?? provider, kind, amount_usd, source, period };
  if (note) out.note = note;
  return out;
}

/**
 * Resolve one provider to its actual-spend lines + winning provenance.
 * @returns {{lines: object[], status: "config"|"billing"|"subscription"|"unknown"}|null}
 *          null when the provider has no actuals AND no detected activity (omitted).
 */
function resolveProvider(key, { costs, config, period, providerActuals }) {
  const lines = [];
  const subUsd =
    key === "anthropic" || key === "openai" || key === "openrouter"
      ? null
      : configSubscriptionUsd(config, key);
  const meteredUsd = configMeteredUsd(config, key, period);

  // 1. Explicit owner config — subscription and owner-entered metered are both
  //    explicit actuals, so they stack (e.g. flat plan + entered overage).
  if (subUsd != null) lines.push(line(key, "subscription", subUsd, "config", period));
  if (meteredUsd != null) {
    lines.push(line(key, "metered", meteredUsd, "config", period, "owner-entered exact spend"));
  }
  if (lines.length) return { lines, status: "config" };

  const providerActual = providerActuals?.[key];
  const providerActualUsd = usdOrNull(providerActual?.monthly_usd);
  if (providerActualUsd != null && providerActual?.period === period) {
    return {
      lines: [
        line(
          key,
          "metered",
          providerActualUsd,
          "billing",
          period,
          providerActual?.scope === "current_api_key"
            ? "provider-reported usage for the current API key"
            : "provider-reported usage"
        ),
      ],
      status: "billing",
    };
  }

  // 2. Authenticated billing / provider-reported actuals for this month.
  //    A truncated billing fetch is a known-partial total — never present it as
  //    complete actual spend; fall through to the "unknown" terminal state below
  //    so the owner is asked to enter the real figure (owner config, resolved
  //    above, still takes precedence).
  if (key === "anthropic" && hasActivity(costs.anthropic) && !costs.anthropic.truncated) {
    return {
      lines: [
        line(
          key,
          "metered",
          monthTotal(costs.anthropic, period),
          "billing",
          period,
          "org admin cost report"
        ),
      ],
      status: "billing",
    };
  }
  if (key === "cursor" && hasActivity(costs.cursor) && !costs.cursor.truncated) {
    // Only usage-based OVERAGE is out-of-pocket metered spend; INCLUDED usage
    // is already paid for by the flat plan and must not be counted.
    const overageUsd = monthTotal(costs.cursor, period, "overage_usd");
    const includedUsd = monthTotal(costs.cursor, period, "included_usd");
    // INCLUDED usage proves a flat plan whose fee the billing API never reports
    // as a dollar amount. Owner config was already consulted above (step 1
    // returns when a cursor subscription is configured), so without it the plan
    // fee would silently read as $0 — keep any real overage line, but degrade
    // the status to unknown so Settings prompts for the actual plan spend
    // instead of undercounting.
    return {
      lines:
        overageUsd > 0 || includedUsd === 0
          ? [
              line(
                key,
                "metered",
                overageUsd,
                "billing",
                period,
                "Cursor billing API (metered overage)"
              ),
            ]
          : [],
      status: includedUsd > 0 ? "unknown" : "billing",
    };
  }
  if (key === "opencode" && hasActivity(costs.opencode)) {
    return {
      lines: [
        line(
          key,
          "metered",
          monthTotal(costs.opencode, period),
          "session",
          period,
          "per-message session cost"
        ),
      ],
      status: "billing",
    };
  }

  // 3. Detected subscription (Claude plan from the login token — real flat fee,
  //    not a token estimate; see claude-plan.mjs).
  if (key === "claude") {
    const plan = costs.plan;
    if (plan && usdOrNull(plan.monthly_usd) != null) {
      const fromConfig = plan.source === "config";
      return {
        lines: [
          line(
            key,
            "subscription",
            usdOrNull(plan.monthly_usd),
            fromConfig ? "config" : "detected",
            period,
            fromConfig
              ? undefined
              : `detected ${plan.label ?? plan.plan} plan from the Claude Code login`
          ),
        ],
        status: fromConfig ? "config" : "subscription",
      };
    }
  }

  // 4. Unknown — activity (or a billing error) with no actual source. Honest
  //    terminal state: no line, no amount, and NEVER a token estimate.
  const active =
    hasActivity(costs[key]) ||
    (key === "cursor" && costs.cursor_error != null) ||
    (key === "anthropic" && costs.anthropic_error != null);
  if (active) return { lines: [], status: "unknown" };
  return null;
}

/**
 * @param {string} stdout - raw stdout of `aios analyze --json`
 * @param {{config?: object, period?: string}} [opts]
 *   config: parsed .aios/cost-config.json; period: YYYY-MM (defaults to now).
 * @returns {object} the CostResponse payload (actual spend only)
 */
export function buildCostsPayload(
  stdout,
  { config = {}, period = currentPeriod(), providerActuals = {} } = {}
) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("costs: analyze --json produced unparseable output");
  }

  const costs = data.costs ?? {};
  const lines = [];
  const byProvider = [];
  const unknown = [];

  for (const meta of PROVIDER_META) {
    const resolved = resolveProvider(meta.key, { costs, config, period, providerActuals });
    if (!resolved) continue;
    lines.push(...resolved.lines);
    const total = resolved.lines.length
      ? round2(resolved.lines.reduce((s, l) => s + l.amount_usd, 0))
      : null;
    byProvider.push({
      provider: meta.key,
      label: meta.label,
      status: resolved.status,
      total_usd: total,
      lines: resolved.lines.length,
    });
    if (resolved.status === "unknown") unknown.push(meta.key);
  }

  // Known totals first (largest spend on top), unknowns last, display order stable.
  byProvider.sort((a, b) => {
    if ((a.total_usd == null) !== (b.total_usd == null)) return a.total_usd == null ? 1 : -1;
    return (b.total_usd ?? 0) - (a.total_usd ?? 0);
  });

  // Honest coverage: if the analyze window starts after the 1st of the month,
  // billing/session sums for "{period}" are provably partial — surface it in
  // the completeness indicator instead of silently undercounting.
  const windowCoversMonth =
    typeof data.window?.since === "string" ? data.window.since <= `${period}-01` : true;

  return {
    period,
    window: data.window ?? null,
    lines,
    by_provider: byProvider,
    totals: { month_usd: round2(lines.reduce((s, l) => s + l.amount_usd, 0)) },
    config_status: {
      complete: unknown.length === 0,
      unknown,
      window_covers_month: windowCoversMonth,
    },
    cursor_error: costs.cursor_error ?? null,
    anthropic_error: costs.anthropic_error ?? null,
    warnings: Array.isArray(providerActuals?._warnings) ? providerActuals._warnings : [],
  };
}
