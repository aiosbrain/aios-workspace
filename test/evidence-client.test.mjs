import test from "node:test";
import assert from "node:assert/strict";
import { createBrainClient } from "../packages/foundation/src/brain-client.mjs";
import { TOOLS, validateArgs } from "../packages/mcp-core/index.mjs";
const cfg = { brain_url: "https://brain.example", api_key: "synthetic-key", team_id: "demo" };
test("search sends authorized structured request and preserves bounded evidence", async () => {
  const data = {
    sources: [{ sid: "S1", item_id: "one", excerpt: "quote", contributors: [] }],
    returned: 1,
    truncated: false,
  };
  const client = createBrainClient(cfg, {
    fetch: async (url, options) => {
      assert.equal(url, "https://brain.example/api/v1/evidence/search");
      assert.equal(options.headers.Authorization, "Bearer synthetic-key");
      assert.deepEqual(JSON.parse(options.body), { query: "question", limit: 8 });
      return Response.json(data);
    },
  });
  const tool = TOOLS.find((t) => t.name === "brain_search_evidence");
  assert.ok(tool);
  const result = await tool.handler({ query: "question", limit: 8 }, client);
  assert.deepEqual(JSON.parse(result.content[0].text), data);
});
test("older servers require upgrade and errors never become empty success", async () => {
  for (const status of [401, 403, 404, 405, 429, 500]) {
    const client = createBrainClient(cfg, {
      fetch: async () =>
        Response.json({ error: { code: "failed", message: "failed" } }, { status }),
    });
    await assert.rejects(
      () => client.searchEvidence("question"),
      status === 404 || status === 405 ? /upgrade/i : new RegExp(String(status))
    );
  }
});
test("malformed and oversized success responses are rejected", async () => {
  for (const data of [
    {},
    { sources: [], returned: 0, truncated: false, padding: "x".repeat(21000) },
  ]) {
    const client = createBrainClient(cfg, { fetch: async () => Response.json(data) });
    await assert.rejects(() => client.searchEvidence("question"), /invalid|large/i);
  }
});
test("direct-client cancellation reaches the authenticated fetch", async () => {
  const controller = new AbortController();
  const client = createBrainClient(cfg, {
    fetch: async (_url, options) =>
      new Promise((_, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        })
      ),
  });
  const result = client.searchEvidence("question", undefined, 8, { signal: controller.signal });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(() => result, /caller cancelled/);
});

test("MCP dispatch accepts explicit integer limits and rejects non-integers", () => {
  const schema = TOOLS.find((tool) => tool.name === "brain_search_evidence").inputSchema;
  for (const limit of [1, 8, 10, 20]) {
    assert.deepEqual(validateArgs(schema, { query: "question", limit }), []);
  }
  for (const limit of [1.5, "10", true, [], {}, NaN, Infinity]) {
    assert.ok(
      validateArgs(schema, { query: "question", limit }).some((error) => error.includes("integer"))
    );
  }
});
