// Tests for the Team Brain MCP server's protocol layer + tool dispatch.
// No network: the brain client is injected as a stub, so these assert the JSON-RPC
// framing, the tool registry, tier/route mapping, and error semantics in isolation.
//
// Run: node scripts/brain-mcp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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
    "aios_loop_collect",
    "brain_get_item",
    "brain_list_decisions",
    "brain_list_projects",
    "brain_list_tasks",
    "brain_pull_items",
    "brain_query",
    "brain_stakeholders",
    "brain_status",
  ]);
  for (const t of res.result.tools) {
    assert.equal(t.inputSchema.type, "object", `${t.name} inputSchema is a JSON Schema object`);
    assert.ok(t.description.length > 20, `${t.name} has a real description`);
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} is annotated read-only`);
  }
});

test("every tool name is service-prefixed to avoid cross-server collisions", () => {
  // brain_* = brain-facing reads; aios_* = local workspace tools (Operator Loop). Both are
  // deliberately namespaced so they can't collide with other connected MCP servers.
  for (const t of TOOLS) assert.match(t.name, /^(brain|aios)_/, `${t.name} prefixed`);
});

test("aios_loop_collect (local tool) reads the workspace at ctx.cwd and matches the collector core", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aios-loop-mcp-"));
  try {
    // project.yaml is the workspace marker findWorkspaceRoot walks up to; 3-log is current spine.
    writeFileSync(path.join(dir, "project.yaml"), "slug: testproj\nmember: testuser\n");
    mkdirSync(path.join(dir, "3-log"), { recursive: true });
    const today = new Date().toISOString().slice(0, 10); // in-window date (collector window is [now-7d, now])
    writeFileSync(
      path.join(dir, "3-log", "decision-log.md"),
      "---\naccess: team\n---\n\n" +
        "| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n" +
        "|---|------|----------|-----------|------------|--------|------|----------|\n" +
        `| 1 | ${today} | Test decision | because | alex | impact | 1 | team |\n`
    );
    // Local tool ignores the brain client; ctx.cwd points it at the workspace.
    const dispatch = createDispatcher({ client: stubClient(), ctx: { cwd: dir } });
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: { name: "aios_loop_collect", arguments: { cadence: "weekly" } },
    });
    assert.ok(!res.result.isError, res.result.content?.[0]?.text);
    const manifest = JSON.parse(res.result.content[0].text);
    assert.equal(manifest.window.cadence, "weekly");
    assert.ok(
      manifest.signals.some((s) => s.kind === "decision" && s.summary === "Test decision"),
      "manifest includes the decision signal"
    );
    // Identical to the CLI path: same shared identity resolver + same collector core ⇒ same
    // member, project, and signal refs (IO3 — MCP manifest == CLI manifest).
    const { collect } = await import("../dist/operator-loop/index.js");
    const { resolveLoopIdentity } = await import("./loop-config.mjs");
    const { member, project } = resolveLoopIdentity(dir);
    const direct = collect({ root: dir, cadence: "weekly", member, project });
    assert.equal(manifest.member, member, "MCP member matches the shared resolver");
    assert.equal(manifest.project, project, "MCP project matches the shared resolver");
    assert.deepEqual(
      manifest.signals.map((s) => `${s.ref.path}#${s.ref.row ?? ""}`),
      direct.signals.map((s) => `${s.ref.path}#${s.ref.row ?? ""}`)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

// ── brain_stakeholders (AIO-141) ─────────────────────────────────────────────
// A routing client that answers GET /me, /company-graph, and paginated /items from
// snake_case fixtures — no network. `tier` defaults to team; override to test the gate.
function graphClient({ tier = "team", pages } = {}) {
  const people = [
    {
      entity_id: "actor-006",
      name: "Nadia Kovalchuk",
      role: "Head of Finance",
      job_family: "Finance",
      reports_to: "actor-005",
    },
    { entity_id: "actor-005", name: "Priya Sharma", role: "CFO", job_family: "Finance", reports_to: null },
  ];
  const ownership = [
    {
      person_id: "actor-006",
      relationship: "OWNS",
      target_id: "wf-001",
      target_kind: "workflow",
      target_name: "Month-End Financial Close",
      target_job_family: "Finance",
    },
  ];
  const itemPages = pages || [
    {
      items: [
        {
          path: "1-inbox/granola/standup.md",
          frontmatter: { meeting: true, title: "Weekly Standup", participants: "Nadia, Priya" },
        },
      ],
      next_cursor: null,
    },
  ];
  const calls = [];
  return {
    calls,
    meta: { brain_url: "https://b", team: "acme", member: "alex" },
    async fetchJson(method, route) {
      calls.push({ method, route });
      if (route === "/me") return { role: "member", tier };
      if (route === "/company-graph") return { people, ownership };
      if (route.startsWith("/items")) {
        // Serve one page per call, in order, so pagination is exercised.
        return itemPages[Math.min(calls.filter((c) => c.route.startsWith("/items")).length - 1, itemPages.length - 1)];
      }
      throw new Error(`404 not_found: ${route}`);
    },
  };
}

test("brain_stakeholders --owns matches by name/job_family, probes /me, returns snake_case rows", async () => {
  const client = graphClient();
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 40,
    method: "tools/call",
    params: { name: "brain_stakeholders", arguments: { owns: "Financial Close" } },
  });
  assert.ok(!res.result.isError, res.result.content?.[0]?.text);
  assert.equal(client.calls[0].route, "/me", "tier probe runs first");
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.mode, "owns");
  assert.equal(payload.ownership[0].person_id, "actor-006", "snake_case field preserved");
  assert.equal(payload.ownership[0].target_name, "Month-End Financial Close");
  assert.equal(payload.people[0].name, "Nadia Kovalchuk", "involved person resolved");
});

test("brain_stakeholders --who returns the person, owned edges, and resolved reports_to", async () => {
  const client = graphClient();
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: { name: "brain_stakeholders", arguments: { who: "Nadia" } },
  });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.person.name, "Nadia Kovalchuk");
  assert.equal(payload.ownership[0].target_name, "Month-End Financial Close");
  assert.equal(payload.reports_to.name, "Priya Sharma", "reports_to resolved to a person row");
});

test("brain_stakeholders --meeting derives attendees from meeting items", async () => {
  const client = graphClient();
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: { name: "brain_stakeholders", arguments: { meeting: "Standup" } },
  });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.mode, "meeting");
  assert.deepEqual(payload.meetings[0].participants, ["Nadia", "Priya"]);
  assert.ok(!client.calls.some((c) => c.route === "/company-graph"), "meeting mode never hits the graph");
});

test("brain_stakeholders paginates the full /items cursor loop for --meeting", async () => {
  const pages = [
    { items: [{ path: "a.md", frontmatter: { meeting: true, title: "Other", participants: "X" } }], next_cursor: "c1" },
    { items: [{ path: "b.md", frontmatter: { meeting: true, title: "Q3 Review", participants: "Amy, Bo" } }], next_cursor: null },
  ];
  const client = graphClient({ pages });
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 43,
    method: "tools/call",
    params: { name: "brain_stakeholders", arguments: { meeting: "Q3 Review" } },
  });
  const payload = JSON.parse(res.result.content[0].text);
  assert.deepEqual(payload.meetings[0].participants, ["Amy", "Bo"], "found the meeting on page 2");
  const itemsCalls = client.calls.filter((c) => c.route.startsWith("/items"));
  assert.equal(itemsCalls.length, 2, "walked both cursor pages");
  assert.match(itemsCalls[1].route, /cursor=c1/, "second page passed the cursor");
});

test("brain_stakeholders rejects a non-team (external) key with 403 forbidden_tier", async () => {
  const client = graphClient({ tier: "external" });
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 44,
    method: "tools/call",
    params: { name: "brain_stakeholders", arguments: { owns: "Finance" } },
  });
  assert.ok(res.result.isError, "external key is refused");
  assert.match(res.result.content[0].text, /forbidden_tier/);
  assert.ok(!client.calls.some((c) => c.route === "/company-graph"), "never reaches the graph leg");
});

test("brain_stakeholders requires exactly one mode", async () => {
  const client = graphClient();
  const dispatch = createDispatcher({ client });
  for (const args of [{}, { owns: "a", who: "b" }]) {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 45,
      method: "tools/call",
      params: { name: "brain_stakeholders", arguments: args },
    });
    assert.ok(res.result.isError, `rejects args ${JSON.stringify(args)}`);
    assert.match(res.result.content[0].text, /exactly one/);
  }
});

test("brain_stakeholders tolerates a 404 from an older brain (owns/who)", async () => {
  const client = {
    calls: [],
    meta: {},
    async fetchJson(method, route) {
      this.calls.push({ route });
      if (route === "/me") return { tier: "team" };
      throw new Error("404 not_found: /company-graph");
    },
  };
  const dispatch = createDispatcher({ client });
  const res = await dispatch({
    jsonrpc: "2.0",
    id: 46,
    method: "tools/call",
    params: { name: "brain_stakeholders", arguments: { owns: "anything" } },
  });
  assert.ok(!res.result.isError, "a missing endpoint is a clean result, not an error");
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.available, false);
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
