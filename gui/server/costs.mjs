/**
 * costs.mjs — pure reshaper for the cockpit Cost panel.
 *
 * `buildCostsPayload(stdout)` parses the JSON emitted by `aios analyze --json`
 * (see scripts/analyze/report.mjs `toJson` → `out.costs`) and flattens the four
 * provider cost blocks into the friendly `CostResponse` contract the client
 * renders: per-provider daily spend, daily token buckets, and a provider rollup.
 *
 * Lives in its own module (not index.mjs, which self-boots an http server on
 * import) so it can be unit-tested without side effects — mirroring maturity.mjs.
 *
 * Provider cost provenance (surfaced so the UI never conflates estimate with bill):
 *   cursor   → dashboard billing API   (authoritative USD)
 *   claude   → local session-log token estimate
 *   codex    → local session-log token estimate
 *   opencode → per-message session-API cost
 *
 * Zero dependencies.
 */

/** Display order + provenance for the four providers analyze can emit. */
const PROVIDERS = [
  { key: "cursor", label: "Cursor", source: "billing", estimated: false },
  { key: "claude", label: "Claude", source: "estimate", estimated: true },
  { key: "codex", label: "Codex", source: "estimate", estimated: true },
  { key: "opencode", label: "Opencode", source: "session", estimated: false },
];

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Read a day's tokens tolerating both key styles (cursor uses input/output/cache_read). */
function dayTokens(d) {
  return {
    input: num(d.input_tokens ?? d.input),
    output: num(d.output_tokens ?? d.output),
    cache_read: num(d.cache_read_tokens ?? d.cache_read),
  };
}

/**
 * @param {string} stdout - raw stdout of `aios analyze --json`
 * @returns {object} the CostResponse payload
 */
export function buildCostsPayload(stdout) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error("costs: analyze --json produced unparseable output");
  }

  const costs = data.costs ?? {};
  const spend = new Map(); // date → { date, [provider]: usd }
  const tokens = new Map(); // date → { date, input, output, cache_read }
  const present = [];
  const byProvider = [];

  for (const p of PROVIDERS) {
    const block = costs[p.key];
    if (!block) continue;
    const days = Array.isArray(block.days) ? block.days : [];
    if (!days.length && !block.totals) continue;
    present.push(p.key);

    let providerCost = 0;
    let providerEvents = 0;
    for (const d of days) {
      if (!d || d.date === "unknown" || d.date === "undated") continue;
      const cost = num(d.cost_usd);
      const tok = dayTokens(d);
      providerCost += cost;
      providerEvents += num(d.events);

      const s = spend.get(d.date) ?? { date: d.date };
      s[p.key] = Math.round(((s[p.key] ?? 0) + cost) * 1e5) / 1e5;
      spend.set(d.date, s);

      const t = tokens.get(d.date) ?? { date: d.date, input: 0, output: 0, cache_read: 0 };
      t.input += tok.input;
      t.output += tok.output;
      t.cache_read += tok.cache_read;
      tokens.set(d.date, t);
    }

    byProvider.push({
      provider: p.key,
      label: p.label,
      source: p.source,
      estimated: p.estimated,
      cost_usd: Math.round((block.totals?.cost_usd ?? providerCost) * 1e5) / 1e5,
      events: block.totals?.events ?? providerEvents,
    });
  }

  // 0-fill every present provider on every day so the stacked chart is dense.
  const spendByDay = [...spend.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => {
      for (const key of present) if (!(key in row)) row[key] = 0;
      return row;
    });
  const tokensByDay = [...tokens.values()].sort((a, b) => a.date.localeCompare(b.date));

  const totalCost = byProvider.reduce((s, p) => s + p.cost_usd, 0);

  return {
    window: data.window ?? null,
    providers: present,
    by_provider: byProvider.sort((a, b) => b.cost_usd - a.cost_usd),
    spendByDay,
    tokensByDay,
    totals: { cost_usd: Math.round(totalCost * 1e5) / 1e5 },
    cursor_error: costs.cursor_error ?? null,
  };
}
