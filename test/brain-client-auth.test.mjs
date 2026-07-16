import test from "node:test";
import assert from "node:assert/strict";
import { createBrainClient } from "../scripts/brain-client.mjs";

function jsonResponse(value = { ok: true }) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify(value),
  };
}

test("omits X-AIOS-Team when team_id is absent", async () => {
  let request;
  const client = createBrainClient(
    { brain_url: "https://brain.example.com/t/aios", api_key: "aios_k_secret" },
    {
      fetch: async (url, options) => {
        request = { url, options };
        return jsonResponse({ actor: "alex" });
      },
    }
  );
  const result = await client.fetchJson("GET", "/me");
  assert.equal(result.actor, "alex");
  assert.equal(request.url, "https://brain.example.com/api/v1/me");
  assert.equal(request.options.headers.Authorization, "Bearer aios_k_secret");
  assert.equal(Object.hasOwn(request.options.headers, "X-AIOS-Team"), false);
});

test("sends a configured non-empty team UUID or slug for backward compatibility", async () => {
  for (const team_id of ["acme", "11111111-2222-3333-4444-555555555555"]) {
    let headers;
    const client = createBrainClient(
      { brain_url: "https://brain.example.com/api/v1", api_key: "key", team_id },
      {
        fetch: async (_url, options) => {
          headers = options.headers;
          return jsonResponse();
        },
      }
    );
    await client.fetchJson("GET", "/projects");
    assert.equal(headers["X-AIOS-Team"], team_id);
  }
});
