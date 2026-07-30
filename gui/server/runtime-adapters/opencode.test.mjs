// Contract test: feed canned opencode SSE events through the adapter's mapping
// and assert the exact WS field shapes the React client consumes, including that
// the GLOBAL stream is filtered by sessionID.
//
// Run: node --test gui/server/runtime-adapters/opencode.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mapOpencodeEvent,
  authHeader,
  mapProviderCatalog,
  fetchProviderCatalog,
  readSessionCost,
  splitModel,
  run,
  resolveProviderCatalog,
  cachedProviderCatalog,
  _resetCatalogCache,
} from "./opencode.mjs";
import { modelCatalog } from "@aiosbrain/foundation/runtimes";

test("authHeader: no password → no Authorization header", () => {
  assert.deepEqual(authHeader(undefined), {});
  assert.deepEqual(authHeader(""), {});
});

test("authHeader: uses HTTP Basic auth with username 'opencode' (not Bearer)", () => {
  const h = authHeader("s3cret");
  assert.equal(h.Authorization, `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`);
  // round-trips to opencode:<password>
  const decoded = Buffer.from(h.Authorization.split(" ")[1], "base64").toString();
  assert.equal(decoded, "opencode:s3cret");
});

const SID = "ses_mine";
const textPart = (over) => ({
  id: "p1",
  sessionID: SID,
  messageID: "m1",
  type: "text",
  text: "",
  ...over,
});
const toolPart = (state, over) => ({
  id: "p2",
  sessionID: SID,
  messageID: "m1",
  type: "tool",
  callID: "call_1",
  tool: "bash",
  state,
  ...over,
});

test("text part delta → delta{text}", () => {
  const ev = {
    type: "message.part.updated",
    properties: { part: textPart({ text: "hello world" }), delta: "hello " },
  };
  assert.deepEqual(mapOpencodeEvent(ev, SID), [{ type: "delta", text: "hello " }]);
});

test("text part with no delta → nothing (avoid full-text re-send dupes)", () => {
  const ev = {
    type: "message.part.updated",
    properties: { part: textPart({ text: "hello world" }) },
  };
  assert.deepEqual(mapOpencodeEvent(ev, SID), []);
});

test("events from another session are filtered out", () => {
  const ev = {
    type: "message.part.updated",
    properties: { part: textPart({ sessionID: "ses_other", text: "x" }), delta: "x" },
  };
  assert.deepEqual(mapOpencodeEvent(ev, SID), []);
});

test("tool running → tool_use{name,input,id=callID}", () => {
  const ev = {
    type: "message.part.updated",
    properties: { part: toolPart({ status: "running", input: { command: "ls" } }) },
  };
  assert.deepEqual(mapOpencodeEvent(ev, SID), [
    { type: "tool_use", name: "bash", input: { command: "ls" }, id: "call_1" },
  ]);
});

test("tool completed → tool_result(is_error=false) with output", () => {
  const ev = {
    type: "message.part.updated",
    properties: {
      part: toolPart({ status: "completed", input: {}, output: "file.txt", title: "ls" }),
    },
  };
  const out = mapOpencodeEvent(ev, SID);
  assert.equal(out[0].type, "tool_result");
  assert.equal(out[0].id, "call_1");
  assert.equal(out[0].text, "file.txt");
  assert.equal(out[0].is_error, false);
  assert.equal(typeof out[0].is_error, "boolean");
});

test("tool error → tool_result(is_error=true) with error text", () => {
  const ev = {
    type: "message.part.updated",
    properties: { part: toolPart({ status: "error", input: {}, error: "boom" }) },
  };
  assert.deepEqual(mapOpencodeEvent(ev, SID), [
    { type: "tool_result", id: "call_1", text: "boom", is_error: true },
  ]);
});

test("tool pending → nothing (tool_use waits for running)", () => {
  const ev = {
    type: "message.part.updated",
    properties: { part: toolPart({ status: "pending", input: {}, raw: "" }) },
  };
  assert.deepEqual(mapOpencodeEvent(ev, SID), []);
});

test("session.error → error event (message extracted)", () => {
  const ev = {
    type: "session.error",
    properties: {
      sessionID: SID,
      error: { name: "ProviderAuthError", data: { message: "no api key" } },
    },
  };
  assert.deepEqual(mapOpencodeEvent(ev, SID), [{ type: "error", message: "no api key" }]);
});

test("session.idle / permission / unknown → nothing (run() owns those)", () => {
  for (const ev of [
    { type: "session.idle", properties: { sessionID: SID } },
    { type: "permission.updated", properties: { id: "perm1", sessionID: SID, title: "write" } },
    { type: "server.connected", properties: {} },
    { type: "message.removed", properties: { sessionID: SID } },
  ]) {
    assert.deepEqual(mapOpencodeEvent(ev, SID), []);
  }
  assert.deepEqual(mapOpencodeEvent(null, SID), []);
  assert.deepEqual(mapOpencodeEvent("nope", SID), []);
});

// ── AIO-536: model catalog, per-turn model, per-turn cost ────────────────────

test("mapProviderCatalog: groups by provider and NEVER leaks the provider api key", () => {
  const models = mapProviderCatalog({
    providers: [
      {
        id: "openrouter",
        name: "OpenRouter",
        key: "sk-SECRET-openrouter",
        models: {
          "qwen/qwen3.7-plus": { id: "qwen/qwen3.7-plus", name: "Qwen3.7 Plus" },
          "qwen/qwen3.7-max": { id: "qwen/qwen3.7-max", name: "Qwen3.7 Max" },
        },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        key: "sk-ant-SECRET",
        models: { "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" } },
      },
    ],
  });
  assert.deepEqual(models, [
    {
      id: "anthropic/claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      group: "Anthropic",
    },
    { id: "openrouter/qwen/qwen3.7-max", label: "Qwen3.7 Max", group: "OpenRouter" },
    { id: "openrouter/qwen/qwen3.7-plus", label: "Qwen3.7 Plus", group: "OpenRouter" },
  ]);
  // Belt and braces: no field of the projection may carry a key fragment.
  assert.ok(!JSON.stringify(models).includes("SECRET"));
});

test("mapProviderCatalog: tolerates junk shapes and skips deprecated models", () => {
  assert.deepEqual(mapProviderCatalog(null), []);
  assert.deepEqual(mapProviderCatalog({}), []);
  assert.deepEqual(mapProviderCatalog({ providers: "nope" }), []);
  assert.deepEqual(mapProviderCatalog({ providers: [{ name: "no id" }] }), []);
  assert.deepEqual(
    mapProviderCatalog({
      providers: [
        {
          id: "p",
          models: { a: { id: "a", status: "deprecated" }, b: { id: "b" }, c: { nope: 1 } },
        },
      ],
    }),
    [{ id: "p/b", label: "b", group: "p" }]
  );
});

test("AC6: fetchProviderCatalog returns the mocked listing, [] when it is unavailable", async () => {
  const payload = {
    providers: [{ id: "openrouter", name: "OpenRouter", models: { m: { id: "m", name: "M" } } }],
  };
  const okFetch = async () => ({ ok: true, json: async () => payload });
  assert.deepEqual(await fetchProviderCatalog("http://x", { fetchImpl: okFetch }), [
    { id: "openrouter/m", label: "M", group: "OpenRouter" },
  ]);
  // Every failure mode degrades to "unavailable" → the caller uses the seeded catalog.
  const notFound = async () => ({ ok: false, status: 404 });
  const throws = async () => {
    throw new Error("ECONNREFUSED");
  };
  const badJson = async () => ({
    ok: true,
    json: async () => {
      throw new Error("not json");
    },
  });
  for (const f of [notFound, throws, badJson]) {
    assert.deepEqual(await fetchProviderCatalog("http://x", { fetchImpl: f }), []);
  }
});

test("AC6: modelCatalog falls back to the seeded opencode list, and takes a dynamic one", () => {
  const fallback = modelCatalog("opencode", []);
  assert.equal(fallback.source, "fallback");
  assert.deepEqual(
    fallback.models.map((m) => m.id),
    ["openrouter/qwen/qwen3.7-plus", "openrouter/qwen/qwen3.7-max"]
  );
  assert.equal(fallback.permissive, true);

  const dynamic = modelCatalog("opencode", [
    { id: "openai/gpt-5.6", label: "GPT", group: "OpenAI" },
  ]);
  assert.equal(dynamic.source, "dynamic");
  assert.deepEqual(
    dynamic.models.map((m) => m.id),
    ["openai/gpt-5.6"]
  );

  // claude-code is static: a "dynamic" list can never replace the Anthropic catalog.
  const claude = modelCatalog("claude-code", [{ id: "openai/gpt-5.6", label: "GPT" }]);
  assert.equal(claude.source, "static");
  assert.deepEqual(
    claude.models.map((m) => m.id),
    ["claude-sonnet-4-6", "claude-opus-4-8"]
  );
});

test("AC4: splitModel splits at the FIRST slash (nested model ids survive)", () => {
  assert.deepEqual(splitModel("openrouter/qwen/qwen3.7-plus"), {
    providerID: "openrouter",
    modelID: "qwen/qwen3.7-plus",
  });
  assert.deepEqual(splitModel("anthropic/claude-sonnet-4-6"), {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  });
  // Malformed / empty → undefined ⇒ "let opencode pick its own default".
  for (const bad of ["", "noslash", "/leading", "trailing/", undefined, null, 42]) {
    assert.equal(
      splitModel(bad),
      undefined,
      `${JSON.stringify(bad)} must not produce a model body`
    );
  }
});

test("AC5: readSessionCost returns the server's number, null on any failure", async () => {
  const at =
    (body, ok = true) =>
    async () => ({ ok, json: async () => body });
  assert.equal(await readSessionCost("http://x", "s", { fetchImpl: at({ cost: 0.42 }) }), 0.42);
  assert.equal(await readSessionCost("http://x", "s", { fetchImpl: at({ cost: 0 }) }), 0);
  // Never estimate: an absent / non-finite / non-numeric cost is null, not a guess.
  for (const body of [{}, { cost: null }, { cost: "0.5" }, { cost: NaN }, { cost: Infinity }]) {
    assert.equal(await readSessionCost("http://x", "s", { fetchImpl: at(body) }), null);
  }
  assert.equal(await readSessionCost("http://x", "s", { fetchImpl: at({ cost: 1 }, false) }), null);
  assert.equal(
    await readSessionCost("http://x", "s", {
      fetchImpl: async () => {
        throw new Error("gone");
      },
    }),
    null
  );
});

// ── AIO-536: run() end-to-end against a STUB opencode binary ─────────────────
//
// `run()` shells out to `opencode serve`, so these cases put a fake `opencode` on
// PATH: a tiny node HTTP server that speaks the four endpoints the adapter uses
// (POST /session, GET /event as SSE, POST /session/{id}/message, GET /session/{id})
// and records every request body. No provider, no model call, no network.

const STUB = `
import http from "node:http";
import { writeFileSync } from "node:fs";
const log = [];
const costs = JSON.parse(process.env.STUB_COSTS || "[]");
const costFails = process.env.STUB_COST_FAILS === "1";
let turn = 0;
const sse = [];
const srv = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    log.push({ method: req.method, url: req.url, body });
    writeFileSync(process.env.STUB_LOG, JSON.stringify(log));
    if (req.url === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse.push(res);
      return;
    }
    if (req.url === "/session" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: "ses_stub" }));
    }
    if (req.url === "/session/ses_stub" && req.method === "GET") {
      if (costFails) {
        res.writeHead(500);
        return res.end("nope");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ cost: costs[Math.min(turn - 1, costs.length - 1)] ?? 0 }));
    }
    if (req.url === "/session/ses_stub/message" && req.method === "POST") {
      turn++;
      // Announce turn-end on the global SSE stream, then complete the POST.
      for (const r of sse)
        r.write("data: " + JSON.stringify({ type: "session.idle", properties: { sessionID: "ses_stub" } }) + "\\n\\n");
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end("{}");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});
srv.listen(0, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + srv.address().port));
`;

/** Put a fake \`opencode\` on PATH and run the adapter against it. */
async function runAgainstStub({ turns, costs = [], costFails = false }) {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-stub-"));
  const repo = mkdtempSync(path.join(tmpdir(), "oc-repo-"));
  writeFileSync(path.join(repo, "aios.yaml"), "version: 1\n");
  const stubJs = path.join(dir, "stub.mjs");
  writeFileSync(stubJs, STUB);
  const bin = path.join(dir, "opencode");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${stubJs}"\n`, { mode: 0o755 });
  const logFile = path.join(dir, "log.json");

  const prevPath = process.env.PATH;
  const prevLog = process.env.STUB_LOG;
  process.env.PATH = `${dir}:${prevPath}`;
  process.env.STUB_LOG = logFile;
  process.env.STUB_COSTS = JSON.stringify(costs);
  process.env.STUB_COST_FAILS = costFails ? "1" : "0";

  const events = [];
  let requests = [];
  try {
    await run({
      repo,
      model: turns[0]?.seedModel ?? "",
      emit: (e) => events.push(e),
      requestPermission: async () => "reject",
      guardWrite: async () => ({ ok: true }),
      input: (async function* () {
        for (const t of turns) yield { type: "user", text: t.text, model: t.model };
      })(),
    });
  } finally {
    process.env.PATH = prevPath;
    if (prevLog === undefined) delete process.env.STUB_LOG;
    else process.env.STUB_LOG = prevLog;
    try {
      requests = JSON.parse(readFileSync(logFile, "utf8"));
    } catch {
      requests = [];
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
  const messages = requests
    .filter((r) => r.method === "POST" && r.url.endsWith("/message"))
    .map((r) => JSON.parse(r.body));
  return { events, requests, messages };
}

test("AC4: run() sends {providerID, modelID} and re-splits after a mid-session change", async () => {
  const { events, messages } = await runAgainstStub({
    turns: [
      {
        text: "hi",
        model: "openrouter/qwen/qwen3.7-plus",
        seedModel: "openrouter/qwen/qwen3.7-plus",
      },
      { text: "again", model: "anthropic/claude-sonnet-4-6" },
    ],
    costs: [0.25, 0.4],
  });
  assert.equal(messages.length, 2);
  // Turn 1: the nested OpenRouter id splits at the FIRST slash only.
  assert.deepEqual(messages[0].model, {
    providerID: "openrouter",
    modelID: "qwen/qwen3.7-plus",
  });
  assert.deepEqual(messages[0].parts, [{ type: "text", text: "hi" }]);
  // Turn 2: the mid-session picker change is re-split and sent, no reconnect.
  assert.deepEqual(messages[1].model, {
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
  });
  // The picker change is announced exactly once, for the NEW model only.
  const modelEvents = events.filter((e) => e.type === "model");
  assert.deepEqual(modelEvents, [{ type: "model", model: "anthropic/claude-sonnet-4-6" }]);
  // Both turns completed.
  assert.equal(events.filter((e) => e.type === "result").length, 2);
});

test("AC5: result carries the per-turn cost delta from the server, null when it errors", async () => {
  const ok = await runAgainstStub({
    turns: [{ text: "a", model: "openrouter/qwen/qwen3.7-plus" }, { text: "b" }],
    costs: [0.25, 0.4], // cumulative session cost after turn 1 / turn 2
  });
  const costs = ok.events.filter((e) => e.type === "result").map((e) => e.cost_usd);
  assert.equal(costs.length, 2);
  assert.equal(costs[0], 0.25);
  assert.ok(Math.abs(costs[1] - 0.15) < 1e-9, `expected the 0.15 delta, got ${costs[1]}`);

  const failed = await runAgainstStub({ turns: [{ text: "a" }], costFails: true });
  const nulls = failed.events.filter((e) => e.type === "result").map((e) => e.cost_usd);
  assert.deepEqual(nulls, [null], "a failed cost read is null — never an estimate");
});

// ── AIO-536: the cached catalog resolver (boots a stub `opencode serve`) ──────

const CATALOG_STUB = `
import http from "node:http";
import { appendFileSync } from "node:fs";
const srv = http.createServer((req, res) => {
  appendFileSync(process.env.STUB_BOOTS, "boot\\n");
  if (req.url === "/config/providers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      providers: [{
        id: "openrouter",
        name: "OpenRouter",
        key: "sk-SECRET-must-not-escape",
        models: { "qwen/qwen3.7-plus": { id: "qwen/qwen3.7-plus", name: "Qwen3.7 Plus" } },
      }],
    }));
  }
  res.writeHead(404);
  res.end("{}");
});
srv.listen(0, "127.0.0.1", () => console.log("listening on http://127.0.0.1:" + srv.address().port));
`;

/** Install a fake \`opencode\` on PATH for the duration of \`fn\`. */
async function withStubOpencode(script, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-cat-"));
  const bootLog = path.join(dir, "boots.txt");
  writeFileSync(bootLog, "");
  const prevPath = process.env.PATH;
  const prevBoots = process.env.STUB_BOOTS;
  process.env.STUB_BOOTS = bootLog;
  if (script) {
    const js = path.join(dir, "stub.mjs");
    writeFileSync(js, script);
    writeFileSync(path.join(dir, "opencode"), `#!/bin/sh\nexec "${process.execPath}" "${js}"\n`, {
      mode: 0o755,
    });
    process.env.PATH = `${dir}:${prevPath}`;
  } else {
    // No `opencode` anywhere on PATH → the ENOENT / not-installed branch.
    process.env.PATH = dir;
  }
  try {
    return await fn({
      boots: () => readFileSync(bootLog, "utf8").trim().split("\n").filter(Boolean).length,
    });
  } finally {
    process.env.PATH = prevPath;
    if (prevBoots === undefined) delete process.env.STUB_BOOTS;
    else process.env.STUB_BOOTS = prevBoots;
    rmSync(dir, { recursive: true, force: true });
    _resetCatalogCache();
  }
}

test("AC6: resolveProviderCatalog boots a server, maps the listing, and caches it", async () => {
  _resetCatalogCache();
  await withStubOpencode(CATALOG_STUB, async ({ boots }) => {
    const repo = mkdtempSync(path.join(tmpdir(), "oc-repo-"));
    try {
      assert.equal(cachedProviderCatalog(repo), null, "nothing cached before the first resolve");

      const models = await resolveProviderCatalog(repo);
      assert.deepEqual(models, [
        { id: "openrouter/qwen/qwen3.7-plus", label: "Qwen3.7 Plus", group: "OpenRouter" },
      ]);
      assert.ok(!JSON.stringify(models).includes("SECRET"), "the provider key must not escape");
      const after = boots();
      assert.ok(after >= 1, "the first resolve boots a server");

      // Cached: neither accessor re-boots.
      assert.deepEqual(cachedProviderCatalog(repo), models);
      assert.deepEqual(await resolveProviderCatalog(repo), models);
      assert.equal(boots(), after, "a cached read must not boot another server");

      // Concurrent cold callers share ONE boot.
      _resetCatalogCache();
      const before = boots();
      const [a, b, c] = await Promise.all([
        resolveProviderCatalog(repo),
        resolveProviderCatalog(repo),
        resolveProviderCatalog(repo),
      ]);
      assert.deepEqual(a, b);
      assert.deepEqual(b, c);
      assert.ok(boots() - before <= 2, "three concurrent resolves must not boot three servers");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

test("AC6: a missing OpenCode install resolves to [] and is not cached", async () => {
  _resetCatalogCache();
  await withStubOpencode(null, async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "oc-repo-"));
    try {
      assert.deepEqual(await resolveProviderCatalog(repo), [], "no throw when opencode is absent");
      assert.equal(cachedProviderCatalog(repo), null, "a failed probe must be retried, not cached");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
