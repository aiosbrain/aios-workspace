/**
 * cost-report.mjs — Cursor billing payloads + optional 3-log/ai-spend.md summary.
 * Used by analyze --push (W2.1) and tests.
 */

import { bucketByDay, computeSignals } from "./metrics.mjs";

function roundUsd(n) {
  return Math.round(Number(n || 0) * 100000) / 100000;
}

function fmtUsd(n, { estimated = false } = {}) {
  const v = Number(n || 0);
  const s = `$${v.toFixed(2)}`;
  return estimated ? `~${s}` : s;
}

/**
 * Claude Code daily spend from local session logs (token estimate, not billing API).
 * @param {import("./normalize.mjs").NormalizedEvent[]} events
 */
export function buildClaudeCostFromEvents(events, sinceMs) {
  const claude = events.filter((ev) => {
    if (ev.tool !== "claude") return false;
    if (!ev.ts) return true;
    const t = new Date(ev.ts).getTime();
    return Number.isFinite(t) ? t >= sinceMs : true;
  });
  if (!claude.length) return null;

  const days = [];
  let totalCost = 0;
  let totalEvents = 0;
  for (const [date, evs] of [...bucketByDay(claude).entries()]
    .filter(([d]) => d !== "undated")
    .sort((a, b) => a[0].localeCompare(b[0]))) {
    const sig = computeSignals(evs);
    const turns = evs.filter(
      (e) => (e.actor === "assistant" || e.actor === "subagent") && e.tokens
    ).length;
    days.push({
      date,
      cost_usd: sig.total_cost_usd,
      events: turns,
      input_tokens: sig.input_tokens,
      output_tokens: sig.output_tokens,
      cache_read_tokens: sig.cache_read_tokens,
    });
    totalCost += sig.total_cost_usd;
    totalEvents += turns;
  }
  return {
    totals: { cost_usd: totalCost, events: totalEvents },
    days,
  };
}

/** Terminal spend block (Cursor authoritative + Claude estimated). */
export function renderCostSummary(costData, color) {
  if (!costData?.cursor && !costData?.claude) return "";
  const c = color || { dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const { window: win } = costData;
  const L = [];
  L.push("");
  L.push(`Provider spend — ${win.since} → ${win.until}`);
  if (costData.cursor?.totals) {
    const t = costData.cursor.totals;
    L.push(c.dim(`  Cursor (billing)     ${fmtUsd(t.cost_usd).padStart(8)}   ${t.events} events`));
    if (costData.cursor.truncated) {
      L.push(c.yellow("    billing fetch incomplete — daily totals may be undercounted"));
    }
  } else if (costData.cursor_error) {
    L.push(c.yellow(`  Cursor (billing)     unavailable (${costData.cursor_error})`));
  }
  if (costData.claude?.totals) {
    const t = costData.claude.totals;
    L.push(
      c.dim(
        `  Claude (est.)        ${fmtUsd(t.cost_usd, { estimated: true }).padStart(9)}   ${t.events} turns`
      )
    );
  }
  L.push(
    c.dim(
      "  Cursor = dashboard API · Claude = token estimate from session logs · see brain Usage for team totals"
    )
  );
  return L.join("\n");
}

/** Build POST /api/v1/costs payloads for each provider-day. */
export function buildCostPushPayloads(result, member, project) {
  const out = [];
  for (const day of result.cursor?.days || []) {
    if (day.date === "unknown") continue;
    out.push({
      member,
      date: day.date,
      provider: "cursor",
      source: "dashboard-api",
      project: project || "",
      input_tokens: day.input || 0,
      output_tokens: day.output || 0,
      cache_read_tokens: day.cache_read || 0,
      cost_usd: roundUsd(day.cost_usd),
      events: day.events || 0,
      meta: {
        models: day.models || {},
        included_usd: day.included_usd || 0,
        overage_usd: day.overage_usd || 0,
      },
    });
  }
  for (const day of result.claude?.days || []) {
    out.push({
      member,
      date: day.date,
      provider: "claude",
      source: "session-logs",
      project: project || "",
      input_tokens: day.input_tokens || 0,
      output_tokens: day.output_tokens || 0,
      cache_read_tokens: day.cache_read_tokens || 0,
      cost_usd: roundUsd(day.cost_usd),
      events: day.events || 0,
      meta: { estimated: true },
    });
  }
  return out;
}

/** Update 3-log/ai-spend.md with latest summary (team-tier syncable). */
export function renderAiSpendMarkdown(result) {
  const now = new Date().toISOString().slice(0, 10);
  const lines = [
    "---",
    "access: team",
    "title: AI provider spend",
    `updated: ${now}`,
    "---",
    "",
    "# AI provider spend",
    "",
    `Rolling window: **${result.window.since}** → **${result.window.until}**`,
    "",
  ];

  if (result.cursor?.totals) {
    lines.push("## Cursor (billing dashboard)", "");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Total USD | $${result.cursor.totals.cost_usd.toFixed(2)} |`);
    lines.push(`| Events | ${result.cursor.totals.events} |`);
    lines.push("");
    lines.push(
      "### Daily",
      "",
      "| Date | Cost | Events | Overage |",
      "|------|------|--------|---------|"
    );
    for (const d of result.cursor.days || []) {
      lines.push(
        `| ${d.date} | $${d.cost_usd.toFixed(2)} | ${d.events} | $${(d.overage_usd || 0).toFixed(2)} |`
      );
    }
    lines.push("");
  }

  if (result.claude?.totals) {
    lines.push("## Claude Code (estimated from session logs)", "");
    lines.push(`| Total (est.) | ~$${result.claude.totals.cost_usd.toFixed(2)} |`);
    lines.push("");
    lines.push("| Date | Est. cost | Turns |", "|------|-----------|-------|");
    for (const d of result.claude.days || []) {
      lines.push(`| ${d.date} | ~$${d.cost_usd.toFixed(2)} | ${d.events} |`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "_Auto-updated by `aios analyze --push`. Cursor figures are authoritative; Claude figures are token estimates._",
    ""
  );
  return lines.join("\n");
}
