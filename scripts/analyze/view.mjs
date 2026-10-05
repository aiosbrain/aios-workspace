/**
 * view.mjs — the presented (colour terminal) view of an `aios analyze` run.
 *
 * Builds a plain-data view model from the same inputs `renderText`,
 * `renderCostSummary` and `renderReport` read, so the Ink renderer in
 * `src/terminal/analyze.tsx` only does layout and colour. Every value here is
 * derived from real analysis data or from the static guidance copy the plain
 * report already prints — nothing is invented for presentation. The plain
 * report (pipes, CI, `AIOS_UI_TIER=plain`, `--json`) never reads this module.
 *
 * Zero dependencies.
 */

import { AXIS_LABELS, attentionCard, contextHealthCard, codebaseHealthCard } from "./aem.mjs";
import { AXIS_LABEL_ERGONOMICS } from "./ergonomics.mjs";
import { AXIS_GUIDE, ergonomicsTip, contextHealthTip, codebaseHealthTip } from "./guidance.mjs";
import {
  SPINE_GLOSS,
  fmtNum,
  shadowBands,
  shadowRollup,
  ceTrendArrow,
  plainStat,
} from "./report.mjs";

const EN = "en-US";

/** Compact token count: 9027980123 → "9.03B", 4500000 → "4.5M", 12345 → "12k". */
export function compactTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(Math.round(v));
}

/** "$1,234.56" (or "~$1,234.56" for an estimate). */
export function usd(n, { estimated = false } = {}) {
  const s = `$${(Number(n) || 0).toLocaleString(EN, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
  return estimated ? `~${s}` : s;
}

const count = (n) => (Number(n) || 0).toLocaleString(EN);

/** 0–4 sparkline level, or null for a day with no data (the plain report's "·"). */
function sparkLevel(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(4, Math.round(v)));
}

/** Drop a leading "<prefix>" the card reading repeats (e.g. "0/4 — "), never anything else. */
function withoutPrefix(text, prefix) {
  const s = String(text ?? "");
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

const COST_KEYS = ["cursor", "claude", "opencode", "codex", "anthropic", "plan"];

/** "Real spend" rows in the plain report's order: plan, Anthropic, Cursor, Opencode. */
function realSpendRows(costData) {
  const { plan, anthropic, anthropic_error, cursor, cursor_error, opencode } = costData;
  const rows = [];
  if (plan?.monthly_usd != null) {
    rows.push({
      label: `Claude ${plan.label} (subscription)`,
      amount: `$${plan.monthly_usd.toFixed(0)}/mo`,
      basis: `flat · ${plan.source}`,
    });
  }
  const api = "Anthropic API (billed)";
  if (anthropic?.total_usd != null)
    rows.push({ label: api, amount: usd(anthropic.total_usd), basis: "real" });
  else if (anthropic_error)
    rows.push({ label: api, amount: "—", basis: `(${anthropic_error})`, tone: "muted" });
  rows.push(...cursorRows(cursor, cursor_error));
  if (opencode?.totals) {
    const t = opencode.totals;
    const basis = `${count(t.events)} turns`;
    rows.push({ label: "Opencode (session)", amount: usd(t.cost_usd), basis });
  }
  return rows;
}

function cursorRows(cursor, error) {
  const label = "Cursor (billing)";
  if (cursor?.totals) {
    const t = cursor.totals;
    const rows = [{ label, amount: usd(t.cost_usd), basis: `${count(t.events)} events` }];
    if (cursor.truncated) {
      const note = "billing fetch incomplete — daily totals may be undercounted";
      rows.push({ note, tone: "warning" });
    }
    return rows;
  }
  return error ? [{ label, amount: "unavailable", basis: `(${error})`, tone: "warning" }] : [];
}

function costView(costData) {
  if (!COST_KEYS.some((key) => costData?.[key])) return null;
  const estimates = [
    ["Claude", costData.claude?.totals],
    ["Codex", costData.codex?.totals],
  ]
    .filter(([, t]) => t)
    .map(([name, t]) => ({
      label: `${name} (est.)`,
      amount: usd(t.cost_usd, { estimated: true }),
      basis: `${count(t.events)} turns`,
    }));
  return {
    window: costData.window,
    real: realSpendRows(costData),
    estimates,
    note: costData.plan?.note || null,
    legend:
      "Anthropic API = billed (admin key) · Cursor = billing API · Opencode = session API · Claude/Codex = token estimate",
  };
}

function deepDiveView(result, contextHealth) {
  const { placement, signals } = result;
  const w = placement.weakest;
  const g = AXIS_GUIDE[w];
  const chCard = contextHealthCard(contextHealth);
  return {
    label: AXIS_LABELS[w],
    score: placement.axes[w],
    scoreText: fmtNum(placement.axes[w], 1),
    meaning: g.meaning,
    why: g.why,
    where: `Score ${fmtNum(placement.axes[w], 1)}/4 — ${plainStat(w, signals)}.`,
    steps: [...g.steps],
    others: Object.entries(AXIS_LABELS)
      .filter(([key]) => key !== w)
      .map(([key, label]) => ({
        label,
        score: placement.axes[key],
        scoreText: fmtNum(placement.axes[key], 1),
        stat: plainStat(key, signals),
      })),
    contextHealth:
      chCard && chCard.metrics.score <= 2
        ? { reading: chCard.reading, tip: contextHealthTip(chCard.metrics.score) || null }
        : null,
  };
}

/** Five axes plus the cognitive-ergonomics shadow band and its trend sparklines. */
function axesView(result) {
  const { placement, signals } = result;
  const days = result.days || [];
  const bands = shadowBands(days);
  const rollup = shadowRollup(signals, days);
  const recent = days.slice(-14);
  return {
    axes: Object.entries(AXIS_LABELS).map(([key, label]) => ({
      label,
      score: placement.axes[key],
      scoreText: fmtNum(placement.axes[key], 1),
      gloss: AXIS_GUIDE[key].gloss,
      note:
        key === "learning"
          ? `Current signal: ${fmtNum(signals.tool_diversity, 1)} distinct tool interfaces per session; skill use and cross-session compounding are not yet observed.`
          : null,
    })),
    ergonomics: {
      label: AXIS_LABEL_ERGONOMICS,
      band: rollup,
      trend: rollup == null ? null : ceTrendArrow(bands),
      note:
        rollup == null
          ? "shadow — needs 5 active days of baseline first"
          : "shadow — vs your own baseline, uncalibrated, local-only",
    },
    trend:
      days.length >= 2
        ? {
            days: recent.length,
            am: recent.map((d) => sparkLevel(d.placement && d.placement.overall)),
            ce: bands.slice(-14).map((b) => sparkLevel(b.band)),
          }
        : null,
  };
}

/** Attention, context-health and codebase-health cards (each null when its check didn't run). */
function cardsView(signals, contextHealth, codebaseHealth) {
  const att = attentionCard(signals || {});
  const m = att.metrics;
  const chCard = contextHealthCard(contextHealth);
  const cbCard = codebaseHealthCard(codebaseHealth);
  return {
    attention: {
      reading: att.reading,
      metrics: [
        ["context switches/hr", fmtNum(m.context_switch_rate)],
        ["focus block avg", `${fmtNum(m.focus_block_avg_min, 1)}m`],
        ["interrupts/hr", fmtNum(m.interrupts_per_hour)],
        ["peak concurrent sessions", String(m.concurrent_sessions_peak)],
      ],
    },
    contextHealth: chCard
      ? {
          score: chCard.metrics.score,
          reading: withoutPrefix(chCard.reading, `${chCard.metrics.score}/4 — `),
          failing: (contextHealth.checks || [])
            .filter((chk) => !chk.ok)
            .slice(0, 3)
            .map((chk) => ({ label: chk.label, kind: chk.kind })),
        }
      : null,
    codebaseHealth: cbCard
      ? {
          status: cbCard.metrics.status,
          reading: withoutPrefix(cbCard.reading, `${cbCard.metrics.status} — `),
          tip: codebaseHealthTip(cbCard.metrics.status) || null,
        }
      : null,
    ergonomicsTip: ergonomicsTip(att.reading) || null,
  };
}

/**
 * @param {{result: object, contextHealth?: object|null, codebaseHealth?: object|null,
 *   costData?: object|null, report?: boolean}} input
 */
export function buildAnalyzeView({ result, contextHealth, codebaseHealth, costData, report }) {
  const { window: win, tools, totals, placement, signals } = result;
  const w = placement.weakest;
  return {
    window: win,
    tools: [...tools],
    totals: {
      sessions: count(totals.sessions),
      tasks: count(totals.tasks),
      tokens: compactTokens(totals.total_tokens),
    },
    spine: {
      level: placement.spine,
      gloss: SPINE_GLOSS[placement.spine] || "",
      overall: placement.overall,
      overallText: fmtNum(placement.overall),
    },
    ...axesView(result),
    ...cardsView(signals, contextHealth, codebaseHealth),
    opportunity: {
      label: AXIS_LABELS[w],
      gloss: AXIS_GUIDE[w].gloss,
      step: AXIS_GUIDE[w].steps[0],
    },
    hints: [
      "Run `aios analyze --report` for a step-by-step plan on this.",
      "Raw sessions stay on your machine — `aios analyze --push` shares only these scores.",
    ],
    cost: costView(costData),
    deepDive: report ? deepDiveView(result, contextHealth) : null,
  };
}
