import test from "node:test";
import assert from "node:assert/strict";
import { collectProviderActuals, fetchOpenRouterMonthlyActual } from "./provider-costs.mjs";

test("OpenRouter returns only the current key's provider-reported monthly actual", async () => {
  let request;
  const actual = await fetchOpenRouterMonthlyActual({
    apiKey: "fixture-key",
    now: new Date("2026-07-21T10:00:00Z"),
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { data: { usage_monthly: 8.40879405, ignored_secret_metadata: "never-returned" } };
        },
      };
    },
  });

  assert.equal(request.url, "https://openrouter.ai/api/v1/key");
  assert.equal(request.options.headers.Authorization, "Bearer fixture-key");
  assert.deepEqual(actual, {
    monthly_usd: 8.40879405,
    period: "2026-07",
    scope: "current_api_key",
  });
  assert.doesNotMatch(JSON.stringify(actual), /fixture-key|secret_metadata/);
});

test("missing credentials and provider failures degrade to no actual", async () => {
  assert.equal(await fetchOpenRouterMonthlyActual({ apiKey: "" }), null);
  assert.equal(
    await fetchOpenRouterMonthlyActual({
      apiKey: "fixture-key",
      fetchImpl: async () => ({ ok: false }),
    }),
    null
  );
  assert.deepEqual(
    await collectProviderActuals({
      openrouter: {
        apiKey: "fixture-key",
        fetchImpl: async () => {
          throw new Error("provider body must not escape");
        },
      },
    }),
    {}
  );
});
