/**
 * anthropic-admin.mjs — REAL per-day Anthropic API-key spend via the Admin Cost API.
 *
 * This is the one Anthropic number that is genuinely authoritative money: the
 * organization's `GET /v1/organizations/cost_report` (docs: manage-claude/usage-cost-api).
 * It reports actual USD billed for API-KEY usage (sk-ant-… keys — our Hermes/scripts),
 * NOT Claude Code subscription usage.
 *
 * Caveat (anthropics/claude-code#27780): today the report only returns
 * customer_type:"api" rows, so subscription/OAuth usage is absent. When that bug is
 * fixed, subscription rows will start appearing here automatically — no code change
 * needed, which is why this is built the right way now.
 *
 * Requires an Admin key (`ANTHROPIC_ADMIN_KEY`, format `sk-ant-admin01-…`, scope
 * org:admin). Absent key → returns null (skipped silently). Not available for
 * individual (non-org) accounts — those get a 401/403, surfaced as `{error}`.
 *
 * Zero dependencies (Node >= 18 global fetch).
 */

const COST_REPORT_URL = "https://api.anthropic.com/v1/organizations/cost_report";

/**
 * @param {{sinceMs:number, endMs:number, env?:NodeJS.ProcessEnv, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<null | {error:string, status?:number}
 *   | {total_usd:number, days:{date:string,cost_usd:number}[], models:Record<string,number>, truncated:boolean}>}
 *   null = no admin key configured (skip). {error} = key present but request failed.
 */
export async function fetchAnthropicApiCost({
  sinceMs,
  endMs,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const key = env.ANTHROPIC_ADMIN_KEY;
  if (!key) return null; // not configured — silent skip

  // 1d buckets snap to UTC midnight — align the window to whole UTC days so the
  // report covers the intended range (floor start, ceil end to next midnight).
  const startDay = new Date(sinceMs);
  startDay.setUTCHours(0, 0, 0, 0);
  const endDay = new Date(endMs);
  endDay.setUTCHours(0, 0, 0, 0);
  endDay.setUTCDate(endDay.getUTCDate() + 1);
  const startingAt = startDay.toISOString();
  const endingAt = endDay.toISOString();

  const byDay = new Map();
  const byModel = new Map();
  let total = 0;
  let page = null;
  let guard = 0;

  try {
    do {
      const url = new URL(COST_REPORT_URL);
      url.searchParams.set("starting_at", startingAt);
      url.searchParams.set("ending_at", endingAt);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.append("group_by[]", "description"); // gives per-model rows
      if (page) url.searchParams.set("page", page);

      const res = await fetchImpl(url, {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        // Never let a stalled admin call hang `aios analyze` (runs inside --push).
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const gated = res.status === 401 || res.status === 403;
        return {
          error: gated
            ? `admin cost API ${res.status} — needs an org Admin key (sk-ant-admin01-…, org:admin); not available for individual accounts`
            : `admin cost API ${res.status}`,
          status: res.status,
        };
      }
      const json = await res.json();
      for (const bucket of json.data || []) {
        const date = String(bucket.starting_at || "").slice(0, 10);
        for (const r of bucket.results || []) {
          // `amount` is a decimal string in LOWEST currency units (cents) → USD = /100.
          const usd = Number(r.amount || 0) / 100;
          if (!Number.isFinite(usd) || usd === 0) continue;
          total += usd;
          if (date) byDay.set(date, (byDay.get(date) || 0) + usd);
          if (r.model) byModel.set(r.model, (byModel.get(r.model) || 0) + usd);
        }
      }
      page = json.has_more ? json.next_page : null;
    } while (page && ++guard < 40);
  } catch (e) {
    return { error: e.message };
  }

  const round = (n) => Math.round(n * 1e5) / 1e5;
  return {
    total_usd: round(total),
    days: [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, usd]) => ({ date, cost_usd: round(usd) })),
    models: Object.fromEntries([...byModel.entries()].map(([m, v]) => [m, round(v)])),
    truncated: guard >= 40,
  };
}
