/**
 * cost-report.mjs — Cursor billing payloads + optional 3-log/ai-spend.md summary.
 * Used by analyze --push (W2.1) and tests.
 */

function roundUsd(n) {
  return Math.round(Number(n || 0) * 100000) / 100000;
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
