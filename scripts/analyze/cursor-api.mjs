/**
 * cursor-api.mjs — fetch billing usage from cursor.com dashboard API.
 * Zero dependencies (Node fetch).
 */

import { resolveCursorSession } from "./cursor-auth.mjs";

const BASE = "https://cursor.com";

async function cursorFetch(path, { method = "GET", body } = {}) {
  const cookie = resolveCursorSession();
  const headers = {
    Cookie: `WorkosCursorSessionToken=${cookie.replace(/::/g, "%3A%3A")}`,
    Accept: "application/json",
    "User-Agent": "aios-costs/1.0",
  };
  if (body) {
    headers["Content-Type"] = "application/json";
    headers.Origin = BASE;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Cursor API ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Billing cycle start from /api/usage (ISO). */
export async function cursorBillingStart() {
  const me = await cursorFetch("/api/auth/me");
  const uid = me.id;
  if (!uid) throw new Error("Cursor session invalid (no user id)");
  const usage = await cursorFetch(`/api/usage?user=${uid}`);
  const som = usage.startOfMonth;
  if (!som) return new Date(Date.now() - 30 * 86_400_000);
  return new Date(som);
}

/**
 * Aggregated usage for a window.
 */
export async function fetchCursorUsage(startMs, endMs) {
  const me = await cursorFetch("/api/auth/me");
  const uid = me.id;
  const agg = await cursorFetch("/api/dashboard/get-aggregated-usage-events", {
    method: "POST",
    body: { teamId: 0, startDate: String(startMs), endDate: String(endMs), userId: uid },
  });

  const rows = agg.aggregations || [];
  const models = {};
  let input = 0,
    output = 0,
    cache_read = 0,
    cost_usd = 0;
  for (const r of rows) {
    const cents = Number(r.totalCents || 0);
    cost_usd += cents / 100;
    input += Number(r.inputTokens || 0);
    output += Number(r.outputTokens || 0);
    cache_read += Number(r.cacheReadTokens || 0);
    const model = r.modelIntent || "unknown";
    models[model] = (models[model] || 0) + cents / 100;
  }

  const days = new Map();
  const PAGE_SIZE = 1000;
  let page = 1;
  let fetched = 0;
  let total = 0;
  let truncated = false;

  // Paginate until all events are fetched — a hard page cap silently undercounts billing.
  while (true) {
    const chunk = await cursorFetch("/api/dashboard/get-filtered-usage-events", {
      method: "POST",
      body: {
        teamId: 0,
        startDate: String(startMs),
        endDate: String(endMs),
        userId: uid,
        page,
        pageSize: PAGE_SIZE,
      },
    });
    const events = chunk.usageEventsDisplay || [];
    if (page === 1) total = Number(chunk.totalUsageEventsCount || 0);
    for (const ev of events) {
      const ts = Number(ev.timestamp || 0);
      const date = ts ? new Date(ts).toISOString().slice(0, 10) : "unknown";
      const tu = ev.tokenUsage || {};
      const value = Number(tu.totalCents || 0) / 100;
      const cur = days.get(date) || {
        date,
        cost_usd: 0,
        included_usd: 0,
        overage_usd: 0,
        events: 0,
        input: 0,
        output: 0,
        cache_read: 0,
        models: {},
      };
      cur.cost_usd += value;
      cur.events += 1;
      cur.input += Number(tu.inputTokens || 0);
      cur.output += Number(tu.outputTokens || 0);
      cur.cache_read += Number(tu.cacheReadTokens || 0);
      const kind = String(ev.kind || "");
      if (kind.includes("USAGE_BASED")) cur.overage_usd += value;
      else if (kind.includes("INCLUDED")) cur.included_usd += value;
      const model = ev.model || "unknown";
      cur.models[model] = (cur.models[model] || 0) + value;
      days.set(date, cur);
    }
    fetched += events.length;
    if (!events.length || fetched >= total) break;
    page += 1;
  }

  if (total > 0 && fetched < total) {
    truncated = true;
    console.warn(
      `Cursor billing: fetched ${fetched}/${total} usage events — daily costs may be undercounted`
    );
  }

  const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dayCostUsd = dayList.reduce((s, d) => s + d.cost_usd, 0);

  return {
    email: me.email,
    days: dayList,
    models,
    totals: {
      input,
      output,
      cache_read,
      cost_usd,
      events: total || fetched,
      day_cost_usd: dayCostUsd,
    },
    truncated,
    events_fetched: fetched,
    events_total: total,
  };
}
