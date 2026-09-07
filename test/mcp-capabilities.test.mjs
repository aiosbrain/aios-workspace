import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import {
  TOOLS,
  TOOLSETS,
  SURFACES,
  parseSelectors,
  selectTools,
  probeCapability,
} from "../packages/mcp-core/index.mjs";
import { runStdio, SERVER_VERSION, createDispatcher } from "../scripts/brain-mcp.mjs";
import { startMcp } from "../scripts/mcp-runtime.mjs";
import { serveStdio } from "../scripts/mcp-stdio.mjs";
import { readFileSync } from "node:fs";

const config = { brain_url: "https://brain.example", api_key: "synthetic-test-key", missing: [] };
const identity = (tier = "team") => ({
  actor: "synthetic-member",
  role: "member",
  tier,
  team: "synthetic-team",
});
const names = (tools) => tools.map((t) => t.name).sort();
const frame = (id, method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
function io() {
  const stdin = new PassThrough();
  let output = "",
    diagnostic = "";
  const stdout = new Writable({
    write(chunk, _encoding, next) {
      output += chunk;
      next();
    },
  });
  const stderr = new Writable({
    write(chunk, _encoding, next) {
      diagnostic += chunk;
      next();
    },
  });
  return {
    stdin,
    stdout,
    stderr,
    frames: () => output.trim().split("\n").filter(Boolean).map(JSON.parse),
    diagnostics: () => diagnostic,
  };
}
async function launch({
  response = identity(),
  status = 200,
  fetch,
  cfg = config,
  argv = [],
  env = {},
  surface,
} = {}) {
  const streams = io();
  const calls = [];
  const mockFetch =
    fetch ||
    (async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(response), { status });
    });
  const deps = { ...streams, fetch: mockFetch, argv, env };
  const done = surface
    ? startMcp(cfg, { ...deps, surface, serverInfo: { name: "acceptance", version: "9.8.7" } })
    : runStdio(cfg, deps);
  streams.stdin.end(
    frame(1, "initialize") +
      "\n" +
      frame(2, "tools/list") +
      "\n" +
      frame(3, "tools/call", { name: "brain_list_projects" }) +
      "\n"
  );
  await done;
  return { ...streams, calls, result: streams.frames() };
}

test("surface and tier selection uses exact memberships", () => {
  assert.equal(SURFACES.standalone.length, 8);
  assert.equal(SURFACES.toolkit.length, 9);
  for (const surface of ["standalone", "toolkit"]) {
    for (const tier of [null, "external", "team"]) {
      const expected = [
        ...(surface === "toolkit" ? TOOLSETS.workspace : []),
        ...(tier ? TOOLSETS.brain : []),
        ...(tier === "team" ? TOOLSETS.board : []),
      ];
      const selected = selectTools(TOOLS, { surface, tier });
      assert.deepEqual(names(selected), [...expected].sort());
      assert.ok(Object.isFrozen(selected));
    }
  }
  assert.throws(() => selectTools(TOOLS, { surface: "remote" }), /Unknown MCP surface/);
});

test("selectors union explicit toolsets and additive tools, overriding only env toolsets", () => {
  const select = (argv, env = {}, tier = "team", surface = "toolkit") =>
    names(selectTools(TOOLS, { selectors: parseSelectors(argv, env), tier, surface }));
  assert.deepEqual(select(["--toolsets", "brain"]), [...TOOLSETS.brain].sort());
  assert.deepEqual(
    select(["--toolsets=brain", "--tools", "brain_list_tasks", "--tools=aios_loop_collect"], {
      AIOS_MCP_TOOLSETS: "invalid",
    }),
    [...TOOLSETS.brain, "brain_list_tasks", "aios_loop_collect"].sort()
  );
  assert.deepEqual(select(["--tools", "brain_status"]), ["brain_status"]);
  assert.deepEqual(select(["--tools", "brain_status"], { AIOS_MCP_TOOLSETS: "workspace" }), [
    "aios_loop_collect",
    "brain_status",
  ]);
  assert.deepEqual(
    select(["--toolsets", "all"], {}, "external"),
    [...TOOLSETS.brain, ...TOOLSETS.workspace].sort()
  );
  assert.deepEqual(
    select(["--tools=all"], {}, "team", "standalone"),
    [...SURFACES.standalone].sort()
  );
  assert.deepEqual(select(["--toolsets=workspace"], {}, "team", "standalone"), []);
  assert.deepEqual(
    select(["--toolsets", "brain", "--toolsets", "board"]),
    [...SURFACES.standalone].sort()
  );
  for (const argv of [
    ["--bad"],
    ["--tools"],
    ["--toolsets="],
    ["--toolsets", "--tools"],
    ["--tools=wat"],
    ["--toolsets=wat"],
  ])
    assert.throws(() => parseSelectors(argv));
  assert.throws(() => parseSelectors([], { AIOS_MCP_TOOLSETS: "" }));
  assert.throws(() => selectTools(TOOLS, { selectors: { toolsets: ["bad"] } }));
  assert.throws(() => selectTools(TOOLS, { selectors: { tools: ["bad"] } }));
});

test("startup /me selects team or external and hidden tools cannot dispatch", async () => {
  const team = await launch();
  assert.deepEqual(names(team.result[1].result.tools), names(TOOLS));
  assert.equal(team.calls.filter((c) => c.url.endsWith("/me")).length, 1);
  assert.ok(team.calls[0].options.signal);
  const external = await launch({ response: identity("external") });
  assert.deepEqual(
    names(external.result[1].result.tools),
    [...TOOLSETS.brain, ...TOOLSETS.workspace].sort()
  );
  assert.equal(external.result[2].error.code, -32602);
  assert.equal(external.calls.length, 1, "hidden call must never contact Brain");
  const standalone = await launch({ surface: "standalone" });
  assert.equal(standalone.result[1].result.tools.length, 8);
  assert.equal(standalone.result[0].result.serverInfo.version, "9.8.7");
});

test("missing configuration, revoked keys, invalid identity and network failure register no Brain tools", async () => {
  const failures = [
    { cfg: { missing: ["AIOS_API_KEY"] } },
    { cfg: { ...config, brain_url: "file:///tmp/brain" } },
    { response: { error: { code: "unauthorized", message: "revoked" } }, status: 401 },
    { response: null },
    { response: [] },
    { response: { tier: "team" } },
    { response: { ...identity(), team: "" } },
    { response: identity("admin") },
    {
      fetch: async () => {
        throw new Error("network unavailable");
      },
    },
    { cfg: { ...config, api_key: "aiosd_synthetic" }, status: 401 },
    { cfg: { ...config, api_key: "aiosd_synthetic" } },
  ];
  for (const options of failures) {
    const result = await launch(options);
    assert.deepEqual(names(result.result[1].result.tools), ["aios_loop_collect"]);
    assert.equal(result.result[2].error.code, -32602);
    assert.ok(result.diagnostics().length);
    if (options.cfg?.api_key?.startsWith("aiosd_"))
      assert.match(result.diagnostics(), /delegated tokens are unsupported/);
  }
  const redacted = await launch({
    fetch: async () => {
      throw new Error(config.api_key);
    },
  });
  assert.ok(!redacted.diagnostics().includes(config.api_key));
});

test("probe deadline aborts and fails closed even when the client ignores cancellation", async () => {
  let aborted = false;
  const started = Date.now();
  const result = await probeCapability(
    config,
    { fetchJson: () => new Promise(() => {}) },
    {
      timeoutMs: 15,
      abort: () => {
        aborted = true;
      },
    }
  );
  assert.equal(result.tier, null);
  assert.match(result.reason, /timed out/);
  assert.ok(aborted);
  assert.ok(Date.now() - started < 1000);
});

test("live startup buffers early input, has a three-second deadline and processes EOF after selection", async () => {
  let signal;
  const started = Date.now();
  const result = await launch({
    fetch: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    },
  });
  assert.ok(Date.now() - started >= 2900 && Date.now() - started < 5000);
  assert.ok(signal.aborted);
  assert.deepEqual(
    result.result.map((r) => r.id),
    [1, 2, 3]
  );
  assert.deepEqual(names(result.result[1].result.tools), ["aios_loop_collect"]);
});

test("availability stays immutable after startup while Brain still denies every revoked call", async () => {
  const streams = io();
  let calls = 0;
  const done = runStdio(config, {
    ...streams,
    env: {},
    fetch: async () => {
      calls++;
      return calls === 1
        ? Response.json(identity())
        : Response.json({ error: { code: "forbidden_tier", message: "denied" } }, { status: 403 });
    },
  });
  streams.stdin.end(
    [
      frame(1, "tools/list"),
      frame(2, "tools/call", { name: "brain_list_projects" }),
      frame(3, "tools/list"),
    ].join("\n")
  );
  await done;
  const result = streams.frames();
  assert.equal(result[1].result.isError, true);
  assert.match(result[1].result.content[0].text, /403 forbidden_tier/);
  assert.deepEqual(result[0].result.tools, result[2].result.tools);
  assert.equal(calls, 2);
});

test("protocol response is pinned for four requested versions, package version and metadata are exposed", async () => {
  const dispatch = createDispatcher();
  for (const protocolVersion of ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]) {
    const res = await dispatch({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion },
    });
    assert.equal(res.result.protocolVersion, "2025-11-25");
    assert.match(res.result.instructions, /Read-only/);
    assert.deepEqual(res.result.capabilities.tools, {});
  }
  assert.equal(
    SERVER_VERSION,
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version
  );
  const listed = await dispatch({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(
    listed.result.tools.find((t) => t.name === "aios_loop_collect")._meta[
      "anthropic/maxResultSizeChars"
    ],
    100_000
  );
});

test("stdio serializes asynchronous replies, parse errors and notifications; close drains queued work", async () => {
  const streams = io();
  const done = serveStdio(async (msg) => {
    if (msg.id === 1) await new Promise((res) => setTimeout(res, 10));
    if (msg.id === 3) throw new Error("synthetic dispatch failure");
    return msg.id ? { jsonrpc: "2.0", id: msg.id, result: {} } : null;
  }, streams);
  streams.stdin.end(
    [
      frame(1, "ping"),
      "broken-json",
      frame(undefined, "notification"),
      "",
      frame(2, "ping"),
      frame(3, "ping"),
    ].join("\n")
  );
  await done;
  assert.deepEqual(
    streams.frames().map((m) => m.id),
    [1, null, 2, 3]
  );
  assert.equal(streams.frames()[1].error.code, -32700);
  assert.equal(streams.frames()[3].error.code, -32603);
  assert.match(streams.diagnostics(), /synthetic dispatch failure/);
});
