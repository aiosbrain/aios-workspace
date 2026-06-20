// Recorded-transcript contract tests (BYOA Phase 3 §6).
//
// Each __fixtures__/*.events.json is a REAL transcript captured from the backend
// (`opencode serve` SSE, `hermes acp` session/update, `codex exec --json` JSONL).
// We replay each through its adapter's pure mapper and assert:
//   1. every emitted event satisfies the WS client contract (assertWsEvent), and
//   2. the full WS event-type sequence matches a snapshot.
// So a mapper change that breaks the client contract — or silently reshapes the
// stream — fails CI. See __fixtures__/README.md to re-record.
//
// Run: node --test gui/server/runtime-adapters/fixtures.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapSessionUpdate } from "./acp.mjs";
import { mapCodexEvent } from "./codex.mjs";
import { mapOpencodeEvent } from "./opencode.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const load = (f) => JSON.parse(readFileSync(path.join(FIX, f), "utf8"));

const WS_TYPES = new Set(["delta", "tool_use", "tool_result", "assistant_done", "result", "error"]);

// The single source of truth for the WS event contract the React client consumes.
// Every adapter, on every backend event, must only ever emit these exact shapes.
function assertWsEvent(e, ctx) {
  assert.ok(e && typeof e === "object", `${ctx}: event not an object`);
  assert.ok(WS_TYPES.has(e.type), `${ctx}: unknown WS type '${e.type}'`);
  switch (e.type) {
    case "delta":
      assert.equal(typeof e.text, "string", `${ctx}: delta.text must be string`);
      break;
    case "tool_use":
      assert.equal(typeof e.name, "string", `${ctx}: tool_use.name must be string`);
      assert.ok(e.id != null, `${ctx}: tool_use.id required`);
      assert.equal(typeof e.input, "object", `${ctx}: tool_use.input must be object`);
      break;
    case "tool_result":
      assert.ok(e.id != null, `${ctx}: tool_result.id required`);
      assert.equal(typeof e.text, "string", `${ctx}: tool_result.text must be string`);
      assert.equal(typeof e.is_error, "boolean", `${ctx}: tool_result.is_error must be boolean`);
      break;
    case "result":
      assert.ok("subtype" in e, `${ctx}: result.subtype required`);
      assert.ok(
        e.cost_usd === null || typeof e.cost_usd === "number",
        `${ctx}: result.cost_usd must be number|null`
      );
      break;
    case "error":
      assert.equal(typeof e.message, "string", `${ctx}: error.message must be string`);
      break;
    // assistant_done has no payload
  }
}

// Replay a transcript through `mapFn` and return the flat WS event list, asserting
// each event against the contract as it's produced.
function replay(events, mapFn, label) {
  const out = [];
  events.forEach((raw, i) => {
    for (const ws of mapFn(raw)) {
      assertWsEvent(ws, `${label}[${i}]`);
      out.push(ws);
    }
  });
  return out;
}

test("opencode fixture → valid WS contract + snapshot", () => {
  const { sessionId, events } = load("opencode.events.json");
  const ws = replay(events, (e) => mapOpencodeEvent(e, sessionId), "opencode");
  assert.deepEqual(
    ws.map((e) => e.type),
    ["tool_use", "tool_result"]
  );
  // the write tool: running → tool_use, completed → tool_result(ok)
  assert.equal(ws[1].is_error, false);
  assert.equal(ws[0].id, ws[1].id);
});

test("codex fixture → valid WS contract + snapshot", () => {
  const { events } = load("codex.events.json");
  const ws = replay(events, mapCodexEvent, "codex");
  assert.deepEqual(
    ws.map((e) => e.type),
    ["delta", "assistant_done", "tool_use", "tool_result", "delta", "assistant_done"]
  );
  assert.equal(ws.find((e) => e.type === "tool_use").name, "apply_patch");
  assert.equal(ws.find((e) => e.type === "tool_result").is_error, false);
});

test("acp (hermes) fixture → valid WS contract + snapshot", () => {
  const { updates } = load("acp.events.json");
  const ws = replay(updates, mapSessionUpdate, "acp");
  assert.deepEqual(
    ws.map((e) => e.type),
    ["assistant_done", "tool_use", "delta", "delta", "delta", "delta", "delta"]
  );
  // the 5 agent_message_chunks streamed as deltas
  assert.equal(ws.filter((e) => e.type === "delta").length, 5);
});

test("assertWsEvent rejects off-contract shapes", () => {
  assert.throws(() => assertWsEvent({ type: "nope" }, "t"));
  assert.throws(() =>
    assertWsEvent({ type: "tool_result", id: "x", text: "y", is_error: "no" }, "t")
  );
  assert.throws(() => assertWsEvent({ type: "result", subtype: "ok", cost_usd: "free" }, "t"));
  assert.doesNotThrow(() => assertWsEvent({ type: "result", subtype: "ok", cost_usd: null }, "t"));
});
