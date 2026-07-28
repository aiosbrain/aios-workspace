// AIO-536 — unit tests for the agent-config route logic.
//
// `config-models-runtime.test.mjs` proves these routes end to end through the real
// server; this file drives the same handlers directly so the branches that an
// end-to-end run can't reach cheaply (a live dynamic catalog, the resolve timeout, a
// failing aios.yaml write) are covered too. These handlers gate which models and
// runtimes can be selected and what may be written to aios.yaml, so they get direct
// tests, not only integration coverage.
//
// Run: node --test gui/server/config-routes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCatalogResolver,
  getConfig,
  postModel,
  getRuntime,
  postRuntime,
} from "./config-routes.mjs";

const REPO = "/tmp/does-not-need-to-exist";
const DYNAMIC = [
  { id: "openrouter/qwen/qwen3.7-plus", label: "Qwen3.7 Plus", group: "OpenRouter" },
  { id: "openai/gpt-5.6", label: "GPT-5.6", group: "OpenAI" },
];
const SEED = ["openrouter/qwen/qwen3.7-plus", "openrouter/qwen/qwen3.7-max"];

/** A resolver with injected cache/resolve seams — no OpenCode server involved. */
function resolver({ cached = null, resolved = [], waitMs = 50, onResolve } = {}) {
  return createCatalogResolver(REPO, {
    waitMs,
    cached: () => cached,
    resolve: (repo) => {
      onResolve?.(repo);
      return Promise.resolve(resolved);
    },
  });
}

const CFG = {
  model: "",
  personality: "aios",
  runtime: "claude-code",
  memoryReview: true,
};

// ── catalog resolution ───────────────────────────────────────────────────────

test("catalogFor: non-opencode runtimes resolve statically, without touching the cache", async () => {
  let resolveCalls = 0;
  const { catalogFor } = resolver({ onResolve: () => resolveCalls++ });
  for (const runtime of ["claude-code", "codex", "hermes", "openclaw"]) {
    const c = await catalogFor(runtime);
    assert.equal(c.source, "static");
    assert.equal(c.runtime, runtime);
  }
  assert.equal(resolveCalls, 0, "a static runtime must never boot an OpenCode server");
  const claude = await catalogFor("claude-code");
  assert.deepEqual(
    claude.models.map((m) => m.id),
    ["claude-sonnet-4-6", "claude-opus-4-8"]
  );
});

test("catalogFor: a cached catalog is used without re-resolving", async () => {
  let resolveCalls = 0;
  const { catalogFor } = resolver({ cached: DYNAMIC, onResolve: () => resolveCalls++ });
  const c = await catalogFor("opencode");
  assert.equal(c.source, "dynamic");
  assert.deepEqual(c.models, DYNAMIC);
  assert.equal(resolveCalls, 0);
});

test("catalogFor: a live resolve populates the catalog", async () => {
  const { catalogFor } = resolver({ resolved: DYNAMIC });
  const c = await catalogFor("opencode");
  assert.equal(c.source, "dynamic");
  assert.deepEqual(
    c.models.map((m) => m.id),
    ["openrouter/qwen/qwen3.7-plus", "openai/gpt-5.6"]
  );
  assert.equal(c.permissive, true);
});

test("catalogFor: an empty resolve falls back to the seeded catalog", async () => {
  const { catalogFor } = resolver({ resolved: [] });
  const c = await catalogFor("opencode");
  assert.equal(c.source, "fallback");
  assert.deepEqual(
    c.models.map((m) => m.id),
    SEED
  );
});

test("catalogFor: a slow resolve times out to the seeded catalog instead of hanging", async () => {
  const { catalogFor } = createCatalogResolver(REPO, {
    waitMs: 20,
    cached: () => null,
    resolve: () => new Promise((r) => setTimeout(() => r(DYNAMIC), 5000).unref?.()),
  });
  // The wait timer is deliberately unref'd in production (it must never hold the
  // server process open), so the test holds its own ref'd keepalive — otherwise the
  // event loop drains and node:test cancels the pending await.
  const keepAlive = setInterval(() => {}, 5);
  const t0 = Date.now();
  let c;
  try {
    c = await catalogFor("opencode");
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - t0 < 2000, "must not wait on the full resolve");
  assert.equal(c.source, "fallback");
  assert.deepEqual(
    c.models.map((m) => m.id),
    SEED
  );
});

test("catalogFor: a rejected resolve degrades to the seed, never throws", async () => {
  const { catalogFor } = createCatalogResolver(REPO, {
    waitMs: 50,
    cached: () => null,
    resolve: () => Promise.reject(new Error("opencode exploded")),
  });
  const c = await catalogFor("opencode");
  assert.equal(c.source, "fallback");
});

test("catalogNow: never blocks, and warms the cache exactly once when cold", () => {
  let resolveCalls = 0;
  const { catalogNow } = resolver({ onResolve: () => resolveCalls++ });
  const c = catalogNow("opencode"); // synchronous — no await
  assert.equal(c.source, "fallback");
  assert.equal(resolveCalls, 1, "a cold read kicks off a background warm");

  const warm = resolver({ cached: DYNAMIC, onResolve: () => resolveCalls++ });
  assert.equal(warm.catalogNow("opencode").source, "dynamic");
  assert.equal(resolveCalls, 1, "a warm read must not re-resolve");
});

test("catalogNow: a rejected background warm is swallowed, not an unhandled rejection", () => {
  const { catalogNow } = createCatalogResolver(REPO, {
    cached: () => null,
    resolve: () => Promise.reject(new Error("boom")),
  });
  assert.equal(catalogNow("opencode").source, "fallback");
});

// ── GET /api/config ──────────────────────────────────────────────────────────

test("getConfig: claude-code returns the pre-AIO-536 body shape exactly", async () => {
  const { catalogFor } = resolver();
  const { status, body } = await getConfig({ cfg: CFG, catalogFor });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    "capabilities",
    "memoryReview",
    "model",
    "models",
    "personality",
    "runtime",
  ]);
  assert.deepEqual(body.models, ["claude-sonnet-4-6", "claude-opus-4-8"]);
  assert.equal(body.capabilities.memoryReviewer, true);
  assert.equal(body.capabilities.contextWindow, 200000);
});

test("getConfig: opencode returns its catalog and downgraded capabilities", async () => {
  const { catalogFor } = resolver({ cached: DYNAMIC });
  const { body } = await getConfig({ cfg: { ...CFG, runtime: "opencode" }, catalogFor });
  assert.deepEqual(body.models, ["openrouter/qwen/qwen3.7-plus", "openai/gpt-5.6"]);
  assert.equal(body.capabilities.modelSwitching, true);
  assert.equal(body.capabilities.memoryReviewer, false);
  assert.equal(body.capabilities.costTracking, true);
  assert.deepEqual(body.capabilities.models, DYNAMIC, "labels + groups reach the picker");
});

// ── POST /api/config/model ───────────────────────────────────────────────────

test("postModel: claude-code accepts its own ids and rejects everything else", async () => {
  const { catalogFor } = resolver();
  const writes = [];
  const setKey = (k, v) => writes.push([k, v]);

  const ok = await postModel({
    model: "claude-opus-4-8",
    runtime: "claude-code",
    catalogFor,
    setKey,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(writes, [["agent_model", "claude-opus-4-8"]]);

  const bad = await postModel({
    model: "openrouter/qwen/qwen3.7-plus",
    runtime: "claude-code",
    catalogFor,
    setKey,
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /claude-code/);
  assert.equal(writes.length, 1, "a rejection must not write");
});

test("postModel: opencode accepts catalog hits AND any well-formed provider/model", async () => {
  const { catalogFor } = resolver({ cached: DYNAMIC });
  const writes = [];
  const setKey = (k, v) => writes.push([k, v]);
  for (const model of [
    "openrouter/qwen/qwen3.7-plus", // in the catalog
    "anthropic/claude-sonnet-4-6", // not in the catalog, but well-formed
    "openrouter/meta-llama/llama-4-70b", // nested id
  ]) {
    const r = await postModel({ model, runtime: "opencode", catalogFor, setKey });
    assert.equal(r.status, 200, `${model} should be accepted`);
  }
  assert.equal(writes.length, 3);
});

test("postModel: opencode rejects malformed ids with a runtime-naming 400", async () => {
  const { catalogFor } = resolver({ cached: DYNAMIC });
  let wrote = false;
  for (const model of [
    "",
    "noslash",
    "/leading",
    "trailing/",
    "has space/x",
    'quote"/x',
    "a\\b/c",
  ]) {
    const r = await postModel({
      model,
      runtime: "opencode",
      catalogFor,
      setKey: () => (wrote = true),
    });
    assert.equal(r.status, 400, `${JSON.stringify(model)} must be rejected`);
    assert.match(r.body.error, /opencode/);
  }
  assert.equal(wrote, false);
});

test("postModel: a runtime with no catalog accepts nothing", async () => {
  const { catalogFor } = resolver();
  const r = await postModel({
    model: "anything",
    runtime: "codex",
    catalogFor,
    setKey: () => assert.fail("must not write"),
  });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /does not support model selection/);
});

test("postModel: a failing aios.yaml write surfaces as a 500, not a crash", async () => {
  const { catalogFor } = resolver();
  const r = await postModel({
    model: "claude-sonnet-4-6",
    runtime: "claude-code",
    catalogFor,
    setKey: () => {
      throw new Error("EACCES: read-only file system");
    },
  });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /EACCES/);
});

// ── /api/config/runtime ──────────────────────────────────────────────────────

test("getRuntime: lists every GUI-drivable runtime with its driver, never claude-api", () => {
  const { status, body } = getRuntime({ runtime: "opencode" });
  assert.equal(status, 200);
  assert.equal(body.runtime, "opencode");
  const ids = body.runtimes.map((r) => r.id);
  assert.deepEqual(ids, ["claude-code", "hermes", "openclaw", "codex", "opencode"]);
  assert.ok(!ids.includes("claude-api"), "claude-api has gui: null — not selectable");
  assert.equal(body.runtimes.find((r) => r.id === "opencode").driver, "opencode");
  assert.equal(body.runtimes.find((r) => r.id === "hermes").driver, "acp");
});

test("postRuntime: accepts every GUI-drivable runtime", () => {
  for (const id of ["claude-code", "hermes", "openclaw", "codex", "opencode"]) {
    const writes = [];
    const r = postRuntime({ runtime: id, setKey: (k, v) => writes.push([k, v]) });
    assert.equal(r.status, 200);
    assert.equal(r.body.appliesTo, "next-chat", "a switch must announce next-chat semantics");
    assert.deepEqual(writes, [["agent_runtime", id]]);
  }
});

test("postRuntime: rejects claude-api, unknown ids, and prototype keys", () => {
  for (const runtime of [
    "claude-api", // registered but gui: null
    "nope",
    "",
    "../../etc/passwd",
    "constructor", // must not slip through via prototype lookup
    "toString",
    "__proto__",
  ]) {
    const r = postRuntime({ runtime, setKey: () => assert.fail(`wrote for ${runtime}`) });
    assert.equal(r.status, 400, `${JSON.stringify(runtime)} must be rejected`);
    assert.match(r.body.error, /runtime must be one of/);
  }
});

test("postRuntime: a failing aios.yaml write surfaces as a 500", () => {
  const r = postRuntime({
    runtime: "opencode",
    setKey: () => {
      throw new Error("EACCES");
    },
  });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /EACCES/);
});
