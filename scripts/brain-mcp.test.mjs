// Tests for the Team Brain MCP server's protocol layer + tool dispatch.
// No network: the brain client is injected as a stub, so these assert the JSON-RPC
// framing, the tool registry, tier/route mapping, and error semantics in isolation.
//
// Run: node scripts/brain-mcp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createDispatcher,
  createBrainClient,
  resolveBrainConfig,
  TOOLS,
  SERVER_NAME,
  SERVER_VERSION,
} from "./brain-mcp.mjs";

// A client stub that records calls and returns canned data.
function stubClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    meta: overrides.meta || { brain_url: "https://brain.example", team: "acme", member: "alex" },
    async fetchJson(method, route, body) {
      calls.push({ kind: "fetchJson", method, route, body });
      if (overrides.fetchJson) return overrides.fetchJson(method, route, body);
      return { ok: true, route };
    },
    async query(question, project) {
      calls.push({ kind: "query", question, project });
      if (overrides.query) return overrides.query(question, project);
      return { text: `answer: ${question}`, sources: [] };
    },
  };
}

test("initialize returns protocol version, tools capability, and server info", async () => {
  const dispatch = createDispatcher({ client: stubClient() });
  const res = await dispatch({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(res.jsonrpc, "2.0");
  assert.equal(res.id, 1);
  assert.equal(res.result.protocolVersion, "2024-11-05");
  assert.ok(res.result.capabilities.tools);
  assert.equal(res.result.serverInfo.name, SERVER_NAME);
  assert.equal(res.result.serverInfo.version, SERVER_VERSION);
});

test("notifications (no id) get no response", async () => {
  const dispatch = createDispatcher({ client: stubClient() });
  const res = await dispatch({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res, null);
});

test("ping returns empty result", async () => {
  const dispatch = createDispatcher({ client: stubClient() });
  const res = await dispatch({ jsonrpc: "2.0", id: 7, method: "ping" });
  assert.deepEqual(res.result, {});
});

test("tools/list exposes every registered tool with a JSON-Schema inputSchema", async () => {
  const dispatch = createDispatcher({ client: stubClient() });
  const res = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = res.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "brain_get_item",
    "brain_list_decisions",
    "brain_list_projects",
    "brain_list_tasks",
    "brain_pull_items",
    "brain_query",
    "brain_status",
  ]);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name} inputSchema is a JSON Schema object`);
    assert.ok(t.description.length > 20, `${t.name} has a real description`);
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is annotated read-only`);
  }
});

test("every tool name is service-prefixed to avoid cross-server collisions", () => {
  for (const t of TOOLS) assert.match(t.name, /^brain_/, `${t.name} prefixed`);
});

test("brain_query routes to client.query and returns answer + sources", async () => {
  const client = stubClient({
    query: async (q) => ({ text: `re: ${q}`, sources: [{ id: "S1", path: "x.md" }] }),
  });
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "brain_query", arguments: { question: "what did we decide?" } },
  });
  assert.equal(client.calls[0].kind, "query");
  assert.equal(client.calls[0].question, "what did we decide?");
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.answer, "re: what did we decide?");
  assert.equal(payload.sources[0].id, "S1");
  assert.ok(!res.result.isError);
});

test("brain_status probes via a far-future /items read and reports connected + non-secret meta", async () => {
  const client = stubClient({ meta: { brain_url: "https://b", team: "acme", member: "alex" } });
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 30,
    method: "tools/call",
    params: { name: "brain_status", arguments: {} },
  });
  const probe = client.calls[0];
  assert.match(probe.route, /^\/items\?since=9999-/, "uses a far-future zero-data probe cursor");
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.connected, true);
  assert.equal(payload.team, "acme");
  assert.equal(payload.brain_url, "https://b");
  assert.ok(!("api_key" in payload) && !("secret" in payload), "never echoes a credential");
  assert.ok(!res.result.isError);
});

test("brain_status reports connected:false (not isError) with a fix hint on a bad key", async () => {
  const client = stubClient({
    fetchJson: async () => {
      throw new Error("401 unauthorized: bad key");
    },
  });
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 31,
    method: "tools/call",
    params: { name: "brain_status", arguments: {} },
  });
  assert.ok(
    !res.result.isError,
    "a failed probe is a normal result the model can read, not a tool error"
  );
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.connected, false);
  assert.match(payload.error, /401 unauthorized/);
  assert.match(payload.hint, /AIOS_BRAIN_URL/);
});

test("brain_pull_items builds a query string from defined params only", async () => {
  const client = stubClient();
  const dispatch = createDispatcher({ client });
  await dispatch({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "brain_pull_items",
      arguments: { project: "northwind-aios", kinds: "deliverable,decision" },
    },
  });
  const route = client.calls[0].route;
  assert.match(route, /^\/items\?/);
  assert.match(route, /project=northwind-aios/);
  assert.match(route, /kinds=deliverable%2Cdecision/);
  assert.doesNotMatch(route, /since=/, "undefined params are omitted");
});

test("brain_get_item url-encodes the id into the path", async () => {
  const client = stubClient();
  const dispatch = createDispatcher({ client });
  await dispatch({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "brain_get_item", arguments: { id: "abc/123" } },
  });
  assert.equal(client.calls[0].route, "/items/abc%2F123");
});

test("tools/call validates required args → -32602 instead of a confused downstream call", async () => {
  const client = stubClient();
  const dispatch = createDispatcher({ client });

  // missing required `question`
  const q = await dispatch({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "brain_query", arguments: {} },
  });
  assert.equal(q.error.code, -32602, "missing question → Invalid params");
  assert.match(q.error.message, /question/);

  // missing required `id` must NOT reach the client (no GET /items/undefined)
  const g = await dispatch({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "brain_get_item", arguments: {} },
  });
  assert.equal(g.error.code, -32602, "missing id → Invalid params");
  assert.equal(client.calls.length, 0, "no downstream request made for invalid args");

  // unexpected arg rejected (additionalProperties:false)
  const u = await dispatch({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "brain_status", arguments: { bogus: 1 } },
  });
  assert.equal(u.error.code, -32602, "unexpected arg → Invalid params");
});

test("a failing tool reports in-band isError, not a JSON-RPC error", async () => {
  const client = stubClient({
    fetchJson: async () => {
      throw new Error("422 forbidden_tier: nope");
    },
  });
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "brain_list_projects", arguments: {} },
  });
  assert.ok(res.result.isError, "surfaced as tool error");
  assert.match(res.result.content[0].text, /forbidden_tier/);
  assert.equal(res.error, undefined, "not a protocol-level error");
});

test("unknown tool is a JSON-RPC invalid-params error", async () => {
  const dispatch = createDispatcher({ client: stubClient() });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "brain_delete_everything", arguments: {} },
  });
  assert.equal(res.error.code, -32602);
  assert.match(res.error.message, /Unknown tool/);
});

test("unknown method is method-not-found", async () => {
  const dispatch = createDispatcher({ client: stubClient() });
  const res = await dispatch({ jsonrpc: "2.0", id: 9, method: "resources/list" });
  assert.equal(res.error.code, -32601);
});

test("resolveBrainConfig reads env-first and reports missing required fields", () => {
  const full = resolveBrainConfig({
    cwd: "/nonexistent-dir-xyz",
    env: {
      AIOS_BRAIN_URL: "https://brain.example/",
      AIOS_API_KEY: "aios_k_secret",
      AIOS_TEAM: "acme",
    },
  });
  assert.equal(full.brain_url, "https://brain.example", "trailing slash trimmed");
  assert.equal(full.team_id, "acme");
  assert.deepEqual(full.missing, []);

  const partial = resolveBrainConfig({ cwd: "/nonexistent-dir-xyz", env: {} });
  assert.deepEqual(partial.missing.sort(), ["AIOS_API_KEY", "AIOS_BRAIN_URL", "AIOS_TEAM"]);
});

test("createBrainClient.query parses an SSE answer stream into text + sources", async () => {
  const sse = [
    "event: delta",
    'data: {"text":"Governance "}',
    "",
    "event: delta",
    'data: {"text":"gates are weekly."}',
    "",
    "event: sources",
    'data: {"sources":[{"id":"S1","path":"3-log/decision-log.md"}]}',
    "",
    "event: done",
    'data: {"input_tokens":10,"output_tokens":5,"cost_usd":0.01}',
    "",
  ].join("\n");
  const fakeFetch = async () => ({
    ok: true,
    async text() {
      return sse;
    },
  });
  const client = createBrainClient(
    { brain_url: "https://b", api_key: "k", team_id: "t" },
    { fetch: fakeFetch }
  );
  const { text, sources } = await client.query("how do gates work?");
  assert.equal(text, "Governance gates are weekly.");
  assert.equal(sources[0].path, "3-log/decision-log.md");
});

test("createBrainClient.query handles multi-line data: fields and CRLF line endings", async () => {
  // A robust SSE parser must join multiple `data:` lines within one event block
  // (the JSON payload spans lines) and tolerate CRLF framing. The old single-`\n`
  // split parser broke on both.
  const sse = [
    "event: delta",
    'data: {"text":', // JSON payload split across two data: lines (joined with \n)
    'data: "hello world"}',
    "",
    "event: sources",
    'data: {"sources":[',
    'data:   {"id":"S1","path":"2-work/spec.md"}',
    "data: ]}",
    "",
  ].join("\r\n"); // CRLF throughout
  const fakeFetch = async () => ({
    ok: true,
    async text() {
      return sse;
    },
  });
  const client = createBrainClient(
    { brain_url: "https://b", api_key: "k", team_id: "t" },
    { fetch: fakeFetch }
  );
  const { text, sources } = await client.query("multi-line?");
  assert.equal(text, "hello world");
  assert.equal(sources[0].path, "2-work/spec.md");
});

test("createBrainClient.fetchJson surfaces brain error envelope", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 401,
    async text() {
      return JSON.stringify({ error: { code: "unauthorized", message: "bad key" } });
    },
  });
  const client = createBrainClient(
    { brain_url: "https://b", api_key: "k", team_id: "t" },
    { fetch: fakeFetch }
  );
  await assert.rejects(() => client.fetchJson("GET", "/projects"), /401 unauthorized: bad key/);
});
