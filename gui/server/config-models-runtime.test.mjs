// AIO-536 — runtime-aware model catalogs + runtime selection, end to end.
//
// These are INTEGRATION tests: each case boots the real GUI server
// (`node gui/server/index.mjs --repo <tmp workspace> --port 0`) against a throwaway
// workspace, drives the token-gated HTTP API, and (for the capability handshake)
// opens one WebSocket. Nothing here calls a model or spawns a runtime — an
// `opencode serve` boot is the ONE thing the opencode catalog path may attempt, and
// the server is written to fall back to the seeded catalog when it isn't there, so
// the suite passes with or without OpenCode installed.
//
// Run: node --test gui/server/config-models-runtime.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { WebSocket } from "ws";
import { RUNTIME_MODEL_CATALOGS } from "@aios-alpha/monorepo/runtimes";
// Shared with ws-session-guard.test.mjs — one spawn/boot helper, not two.
import { withServer } from "./server-test-harness.mjs";

const CLAUDE_MODELS = RUNTIME_MODEL_CATALOGS["claude-code"].models.map((m) => m.id);
const OPENCODE_SEED = RUNTIME_MODEL_CATALOGS.opencode.models.map((m) => m.id);

const aiosYaml = (repo) => readFileSync(path.join(repo, "aios.yaml"), "utf8");

// ── AC1: the catalog follows the ACTIVE runtime ──────────────────────────────

test("AC1 regression: untouched aios.yaml → the Claude catalog, exactly as before", async () => {
  await withServer("", async (srv) => {
    const { status, body } = await srv.get("/api/config");
    assert.equal(status, 200);
    assert.equal(body.runtime, "claude-code");
    assert.deepEqual(body.models, CLAUDE_MODELS);
    assert.equal(body.capabilities.modelSwitching, true);
    assert.deepEqual(
      body.capabilities.models.map((m) => m.id),
      CLAUDE_MODELS
    );
    assert.equal(body.capabilities.memoryReviewer, true);
    assert.equal(body.capabilities.contextWindow, 200000);
    // No key beyond the pre-AIO-536 shape may appear on this path.
    assert.deepEqual(Object.keys(body).sort(), [
      "capabilities",
      "memoryReview",
      "model",
      "models",
      "personality",
      "runtime",
    ]);
  });
});

test("AC1 regression: explicit agent_runtime: claude-code is identical to unset", async () => {
  let unset, explicit;
  await withServer("", async (srv) => {
    unset = (await srv.get("/api/config")).body;
  });
  await withServer('agent_runtime: "claude-code"', async (srv) => {
    explicit = (await srv.get("/api/config")).body;
  });
  assert.deepEqual(explicit, unset);
});

test("AC1: agent_runtime: opencode → the opencode catalog, modelSwitching true", async () => {
  await withServer('agent_runtime: "opencode"', async (srv) => {
    const { body } = await srv.get("/api/config");
    assert.equal(body.runtime, "opencode");
    assert.equal(body.capabilities.modelSwitching, true);
    // Never the Claude list.
    for (const id of CLAUDE_MODELS) assert.ok(!body.models.includes(id), `leaked ${id}`);
    assert.ok(body.models.length > 0, "opencode catalog must not be empty");
    // Every id is a provider/model reference — seeded fallback or a live listing.
    for (const id of body.models) assert.match(id, /^[^/\s]+\/.+$/);
    // With no OpenCode server reachable this is exactly the seeded fallback.
    const isSeed = body.models.length === OPENCODE_SEED.length;
    if (isSeed) assert.deepEqual(body.models, OPENCODE_SEED);
    // Capabilities downgrade honestly for a native runtime.
    assert.equal(body.capabilities.memoryReviewer, false);
    assert.equal(body.capabilities.permissionStyle, "options");
  });
});

// ── AC2: POST /api/config/model validates against the active runtime ─────────

test("AC2: opencode accepts openrouter/qwen/qwen3.7-plus and writes agent_model", async () => {
  await withServer('agent_runtime: "opencode"', async (srv, repo) => {
    const { status, body } = await srv.post("/api/config/model", {
      model: "openrouter/qwen/qwen3.7-plus",
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.match(aiosYaml(repo), /^agent_model: "openrouter\/qwen\/qwen3\.7-plus"$/m);
  });
});

test("AC2: claude-code rejects an opencode id with a runtime-naming 400", async () => {
  await withServer("", async (srv, repo) => {
    const { status, body } = await srv.post("/api/config/model", {
      model: "openrouter/qwen/qwen3.7-plus",
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.match(body.error, /claude-code/);
    assert.match(body.error, /claude-sonnet-4-6/);
    assert.ok(!/agent_model/.test(aiosYaml(repo)), "must not write on a rejection");
  });
});

test("AC2: opencode rejects a malformed id (no slash) with a 400", async () => {
  await withServer('agent_runtime: "opencode"', async (srv, repo) => {
    for (const model of ["qwen3.7-plus", "/leading", "trailing/", "has space/x", ""]) {
      const { status, body } = await srv.post("/api/config/model", { model });
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(model)}`);
      assert.match(body.error, /opencode/);
    }
    assert.ok(!/agent_model/.test(aiosYaml(repo)), "must not write on a rejection");
  });
});

test("AC2 regression: claude-code still accepts its own ids", async () => {
  await withServer("", async (srv, repo) => {
    for (const model of CLAUDE_MODELS) {
      const { status, body } = await srv.post("/api/config/model", { model });
      assert.equal(status, 200);
      assert.equal(body.model, model);
    }
    assert.match(aiosYaml(repo), /^agent_model: "claude-opus-4-8"$/m);
  });
});

// ── AC3: POST /api/config/runtime ────────────────────────────────────────────

test("AC3: GET lists only GUI-drivable runtimes (claude-api absent)", async () => {
  await withServer("", async (srv) => {
    const { status, body } = await srv.get("/api/config/runtime");
    assert.equal(status, 200);
    assert.equal(body.runtime, "claude-code");
    const ids = body.runtimes.map((r) => r.id);
    assert.ok(ids.includes("claude-code") && ids.includes("opencode"));
    assert.ok(!ids.includes("claude-api"), "claude-api is not GUI-drivable");
  });
});

test("AC3: accepts every GUI-drivable runtime and the write lands in aios.yaml", async () => {
  await withServer("", async (srv, repo) => {
    const { body: list } = await srv.get("/api/config/runtime");
    for (const { id } of list.runtimes) {
      const { status, body } = await srv.post("/api/config/runtime", { runtime: id });
      assert.equal(status, 200, `${id} should be accepted`);
      assert.equal(body.ok, true);
      assert.equal(body.appliesTo, "next-chat");
      assert.match(aiosYaml(repo), new RegExp(`^agent_runtime: "${id}"$`, "m"));
      // …and it is what the config endpoint reports back.
      assert.equal((await srv.get("/api/config")).body.runtime, id);
    }
  });
});

test("AC3: rejects claude-api and unknown ids with a 400, writing nothing", async () => {
  await withServer("", async (srv, repo) => {
    for (const runtime of ["claude-api", "nope", "", "../../etc/passwd", "constructor"]) {
      const { status, body } = await srv.post("/api/config/runtime", { runtime });
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(runtime)}`);
      assert.equal(body.ok, false);
      assert.match(body.error, /runtime must be one of/);
    }
    assert.ok(!/agent_runtime/.test(aiosYaml(repo)), "must not write on a rejection");
  });
});

test("AC3: the runtime endpoint is token-gated", async () => {
  await withServer("", async (srv) => {
    for (const [method, body] of [
      ["GET", undefined],
      ["POST", JSON.stringify({ runtime: "opencode" })],
    ]) {
      const res = await fetch(`${srv.base}/api/config/runtime?token=wrong`, { method, body });
      assert.equal(res.status, 401);
    }
  });
});

// ── AC7: the WS capability handshake downgrades honestly ─────────────────────

/** Connect one WebSocket and resolve its `hello` frame. */
function readHello(srv) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${srv.wsUrl}/ws?token=${srv.token}`);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no hello in 20s"));
    }, 20000);
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type !== "hello") return;
      clearTimeout(timer);
      ws.close();
      resolve(msg);
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

test("AC7: opencode hello advertises memoryReviewer:false, a safety note, and its catalog", async () => {
  await withServer('agent_runtime: "opencode"', async (srv) => {
    const hello = await readHello(srv);
    assert.equal(hello.runtime, "opencode");
    assert.equal(hello.capabilities.memoryReviewer, false);
    assert.match(hello.safetyNote, /validated after each turn/);
    assert.equal(hello.capabilities.modelSwitching, true);
    assert.ok(hello.capabilities.models.length > 0);
    for (const m of hello.capabilities.models) assert.match(m.id, /^[^/\s]+\/.+$/);
  });
});

test("AC7 regression: claude-code hello is unchanged (reviewer on, no safety note)", async () => {
  await withServer("", async (srv) => {
    const hello = await readHello(srv);
    assert.equal(hello.runtime, "claude-code");
    assert.equal(hello.safetyNote, null);
    assert.equal(hello.capabilities.memoryReviewer, true);
    assert.deepEqual(
      hello.capabilities.models.map((m) => m.id),
      CLAUDE_MODELS
    );
  });
});

// ── the runtime-switch / model-persist interaction ───────────────────────────

test("after a runtime switch, persisting the OLD runtime's model is refused", async () => {
  await withServer("", async (srv, repo) => {
    // Start on claude-code and persist Opus — fine.
    assert.equal((await srv.post("/api/config/model", { model: "claude-opus-4-8" })).status, 200);
    // Switch the configured runtime; the write lands.
    assert.equal((await srv.post("/api/config/runtime", { runtime: "opencode" })).status, 200);
    // Persisting a Claude id now 400s: agent_model must agree with agent_runtime.
    // This does NOT block a live claude-code session from switching models — that
    // travels on the WebSocket (`user_message.model`), which this route never gates.
    const { status, body } = await srv.post("/api/config/model", { model: "claude-sonnet-4-6" });
    assert.equal(status, 400);
    assert.match(body.error, /opencode/);
    // aios.yaml keeps the last consistent write; nothing was corrupted.
    assert.match(aiosYaml(repo), /^agent_model: "claude-opus-4-8"$/m);
    assert.match(aiosYaml(repo), /^agent_runtime: "opencode"$/m);
  });
});
