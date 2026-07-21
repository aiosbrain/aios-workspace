/**
 * Small, fail-closed provider billing probes for the Cost panel.
 *
 * Only numeric provider-reported actuals cross this boundary. Tokens, response bodies, key metadata,
 * and provider errors never reach the browser. Missing or insufficient credentials resolve to an
 * empty result so the ledger can remain honestly unknown instead of breaking the whole Cost view.
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
  if (!key) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(OPENROUTER_KEY_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const amount = Number(body?.data?.usage_monthly);
    if (!Number.isFinite(amount) || amount < 0) return null;
    return {
      monthly_usd: amount,
      period: currentPeriod(now),
      scope: "current_api_key",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectProviderActuals(options = {}) {
  const openrouter = await fetchOpenRouterMonthlyActual(options.openrouter);
  return openrouter ? { openrouter } : {};
}
