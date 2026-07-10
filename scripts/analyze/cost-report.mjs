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
 * Daily spend for a given tool from its NormalizedEvent[] (session-log cost).
 * @param {string} tool
 * @param {import("./normalize.mjs").NormalizedEvent[]} events
 * @param {number} sinceMs
 */
function buildToolCostFromEvents(tool, events, sinceMs) {
  const filtered = events.filter((ev) => {
    if (ev.tool !== tool) return false;
    if (!ev.ts) return true;
    const t = new Date(ev.ts).getTime();
    return Number.isFinite(t) ? t >= sinceMs : true;
  });
  if (!filtered.length) return null;

  const days = [];
  let totalCost = 0;
  let totalEvents = 0;
  for (const [date, evs] of [...bucketByDay(filtered).entries()]
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

/**
 * Claude Code daily spend from local session logs (token estimate, not billing API).
 * @param {import("./normalize.mjs").NormalizedEvent[]} events
 * @param {number} sinceMs
 */
export function buildClaudeCostFromEvents(events, sinceMs) {
  return buildToolCostFromEvents("claude", events, sinceMs);
}

/**
 * Opencode daily spend from local session data (per-message cost from server API).
 * @param {import("./normalize.mjs").NormalizedEvent[]} events
 * @param {number} sinceMs
 */
export function buildOpencodeCostFromEvents(events, sinceMs) {
  return buildToolCostFromEvents("opencode", events, sinceMs);
}

/**
 * Codex CLI daily spend from local session logs (token estimate, not billing API).
 * @param {import("./normalize.mjs").NormalizedEvent[]} events
 * @param {number} sinceMs
 */
export function buildCodexCostFromEvents(events, sinceMs) {
  return buildToolCostFromEvents("codex", events, sinceMs);
}

/**
 * Terminal spend block, grouped by what the number MEANS:
 *   REAL SPEND     — flat subscription + billed API/usage ($ you actually pay)
 *   API-EQUIVALENT — token estimates ("what this would cost on the API", NOT your bill)
 * The split matters because subscription usage isn't billed per token; a token
 * estimate is a value/efficiency signal, never spend. See claude-plan.mjs.
 */
export function renderCostSummary(costData, color) {
  if (
    !costData?.cursor &&
    !costData?.claude &&
    !costData?.opencode &&
    !costData?.codex &&
    !costData?.anthropic &&
    !costData?.plan
  ) {
    return "";
  }
  const c = color || { dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const { window: win } = costData;
  const L = [];
  L.push("");
  L.push(`Provider spend — ${win.since} → ${win.until}`);

  // ── real spend ──
  L.push(c.dim("  Real spend"));
  const plan = costData.plan;
  if (plan?.monthly_usd != null) {
    L.push(
      c.dim(
        `    ${("Claude " + plan.label + " (subscription)").padEnd(30)}${("$" + plan.monthly_usd.toFixed(0) + "/mo").padStart(8)}   flat · ${plan.source}`
      )
    );
  }
  if (costData.anthropic?.total_usd != null) {
    L.push(
      c.dim(
        `    ${"Anthropic API (billed)".padEnd(30)}${fmtUsd(costData.anthropic.total_usd).padStart(8)}   real`
      )
    );
  } else if (costData.anthropic_error) {
    L.push(c.dim(`    Anthropic API (billed)         — (${costData.anthropic_error})`));
  }
  if (costData.cursor?.totals) {
    const t = costData.cursor.totals;
    L.push(
      c.dim(
        `    ${"Cursor (billing)".padEnd(30)}${fmtUsd(t.cost_usd).padStart(8)}   ${t.events} events`
      )
    );
    if (costData.cursor.truncated) {
      L.push(c.yellow("      billing fetch incomplete — daily totals may be undercounted"));
    }
  } else if (costData.cursor_error) {
    L.push(c.yellow(`    Cursor (billing)               unavailable (${costData.cursor_error})`));
  }
  if (costData.opencode?.totals) {
    const t = costData.opencode.totals;
    L.push(
      c.dim(
        `    ${"Opencode (session)".padEnd(30)}${fmtUsd(t.cost_usd).padStart(8)}   ${t.events} turns`
      )
    );
  }

  // ── API-equivalent value (estimates) ──
  const est = [];
  if (costData.claude?.totals) est.push(["Claude", costData.claude.totals]);
  if (costData.codex?.totals) est.push(["Codex", costData.codex.totals]);
  if (est.length) {
    L.push(c.dim("  API-equivalent value (not billed on a subscription)"));
    for (const [name, t] of est) {
      L.push(
        c.dim(
          `    ${(name + " (est.)").padEnd(30)}${fmtUsd(t.cost_usd, { estimated: true }).padStart(9)}   ${t.events} turns`
        )
      );
    }
  }

  if (plan?.note) L.push(c.dim(`  note: ${plan.note}`));
  L.push(
    c.dim(
      "  Anthropic API = billed (admin key) · Cursor = billing API · Opencode = session API · Claude/Codex = token estimate"
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
  for (const day of result.codex?.days || []) {
    out.push({
      member,
      date: day.date,
      provider: "codex",
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
  for (const day of result.anthropic?.days || []) {
    if (day.date === "unknown") continue;
    out.push({
      member,
      date: day.date,
      provider: "anthropic",
      source: "admin-cost",
      project: project || "",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: roundUsd(day.cost_usd),
      events: 0,
      // Authoritative billed $ (API-key usage), not an estimate.
      meta: { real: true },
    });
  }
  for (const day of result.opencode?.days || []) {
    out.push({
      member,
      date: day.date,
      provider: "opencode",
      source: "session-api",
      project: project || "",
      input_tokens: day.input_tokens || 0,
      output_tokens: day.output_tokens || 0,
      cache_read_tokens: day.cache_read_tokens || 0,
      cost_usd: roundUsd(day.cost_usd),
      events: day.events || 0,
      meta: {},
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

  // Billing model — separates what you actually pay from token estimates.
  lines.push("## Billing model", "");
  lines.push("| Item | Amount | Basis |", "|------|--------|-------|");
  if (result.plan?.monthly_usd != null) {
    lines.push(
      `| Claude ${result.plan.label} (subscription) | $${result.plan.monthly_usd.toFixed(0)}/mo | flat · ${result.plan.source} |`
    );
  }
  if (result.anthropic?.total_usd != null) {
    lines.push(
      `| Anthropic API (billed) | $${result.anthropic.total_usd.toFixed(2)} | real (admin cost API) |`
    );
  }
  if (result.cursor?.totals) {
    lines.push(`| Cursor | $${result.cursor.totals.cost_usd.toFixed(2)} | real (billing API) |`);
  }
  if (result.opencode?.totals) {
    lines.push(
      `| Opencode | $${result.opencode.totals.cost_usd.toFixed(2)} | real (session API) |`
    );
  }
  if (result.claude?.totals) {
    lines.push(
      `| Claude (est.) | ~$${result.claude.totals.cost_usd.toFixed(2)} | API-equivalent value, not billed |`
    );
  }
  if (result.codex?.totals) {
    lines.push(
      `| Codex (est.) | ~$${result.codex.totals.cost_usd.toFixed(2)} | API-equivalent value, not billed |`
    );
  }
  lines.push("");
  if (result.plan?.note) lines.push(`> ${result.plan.note}`, "");

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

  if (result.codex?.totals) {
    lines.push("## Codex CLI (estimated from session logs)", "");
    lines.push(`| Total (est.) | ~$${result.codex.totals.cost_usd.toFixed(2)} |`);
    lines.push("");
    lines.push("| Date | Est. cost | Turns |", "|------|-----------|-------|");
    for (const d of result.codex.days || []) {
      lines.push(`| ${d.date} | ~$${d.cost_usd.toFixed(2)} | ${d.events} |`);
    }
    lines.push("");
  }

  if (result.opencode?.totals) {
    lines.push("## Opencode (from session API)", "");
    lines.push(`| Total | $${result.opencode.totals.cost_usd.toFixed(2)} |`);
    lines.push("");
    lines.push("| Date | Cost | Turns |", "|------|------|-------|");
    for (const d of result.opencode.days || []) {
      lines.push(`| ${d.date} | $${d.cost_usd.toFixed(2)} | ${d.events} |`);
    }
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "_Auto-updated by `aios analyze --push`. Cursor figures are authoritative; Claude/Codex figures are token estimates; Opencode figures are per-message cost from the server API._",
    ""
  );
  return lines.join("\n");
}
