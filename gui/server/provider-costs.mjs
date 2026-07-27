/**
 * Small, fail-closed provider billing probes for the Cost panel.
 *
 * Only numeric provider-reported actuals cross this boundary. Tokens, response bodies, key metadata,
 * and provider errors never reach the browser. Missing credentials resolve to an empty result;
 * configured-but-broken probes carry a bounded diagnostic so the UI can distinguish unknown spend
 * from a failed billing source.
 */

const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const DEFAULT_TIMEOUT_MS = 5_000;

function currentPeriod(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export async function fetchOpenRouterMonthlyActual({
  apiKey = process.env.OPENROUTER_API_KEY,
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return { actual: null, error: null };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok)
      return {
        actual: null,
        error: `OpenRouter billing returned HTTP ${response.status ?? "unknown"}`,
      };
    const body = await response.json().catch(() => null);
    const amount = Number(body?.data?.usage_monthly);
    if (!Number.isFinite(amount) || amount < 0)
      return { actual: null, error: "OpenRouter billing response missing usage_monthly" };
    return {
      actual: { monthly_usd: amount, period: currentPeriod(now), scope: "current_api_key" },
      error: null,
    };
  } catch {
    return { actual: null, error: "OpenRouter billing request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectProviderActuals(options = {}) {
  const openrouter = await fetchOpenRouterMonthlyActual(options.openrouter);
  return openrouter.actual
    ? { openrouter: openrouter.actual }
    : openrouter.error
      ? { _warnings: [openrouter.error] }
      : {};
}
