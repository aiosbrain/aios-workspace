// Contract test: feed canned opencode SSE events through the adapter's mapping
// and assert the exact WS field shapes the React client consumes, including that
// the GLOBAL stream is filtered by sessionID.
//
// Run: node --test gui/server/runtime-adapters/opencode.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOpencodeEvent } from "./opencode.mjs";

const SID = "ses_mine";
const textPart = (over) => ({ id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "", ...over });
const toolPart = (state, over) => ({ id: "p2", sessionID: SID, messageID: "m1", type: "tool", callID: "call_1", tool: "bash", state, ...over });

test("text part delta → delta{text}", () => {
  const ev = { type: "message.part.updated", properties: { part: textPart({ text: "hello world" }), delta: "hello " } };
  assert.deepEqual(mapOpencodeEvent(ev, SID), [{ type: "delta", text: "hello " }]);
});

test("text part with no delta → nothing (avoid full-text re-send dupes)", () => {
  const ev = { type: "message.part.updated", properties: { part: textPart({ text: "hello world" }) } };
  assert.deepEqual(mapOpencodeEvent(ev, SID), []);
});

test("events from another session are filtered out", () => {
  const ev = { type: "message.part.updated", properties: { part: textPart({ sessionID: "ses_other", text: "x" }), delta: "x" } };
  assert.deepEqual(mapOpencodeEvent(ev, SID), []);
});

test("tool running → tool_use{name,input,id=callID}", () => {
  const ev = { type: "message.part.updated", properties: { part: toolPart({ status: "running", input: { command: "ls" } }) } };
  assert.deepEqual(mapOpencodeEvent(ev, SID), [{ type: "tool_use", name: "bash", input: { command: "ls" }, id: "call_1" }]);
});

test("tool completed → tool_result(is_error=false) with output", () => {
  const ev = { type: "message.part.updated", properties: { part: toolPart({ status: "completed", input: {}, output: "file.txt", title: "ls" }) } };
  const out = mapOpencodeEvent(ev, SID);
  assert.equal(out[0].type, "tool_result");
  assert.equal(out[0].id, "call_1");
  assert.equal(out[0].text, "file.txt");
  assert.equal(out[0].is_error, false);
  assert.equal(typeof out[0].is_error, "boolean");
});

test("tool error → tool_result(is_error=true) with error text", () => {
  const ev = { type: "message.part.updated", properties: { part: toolPart({ status: "error", input: {}, error: "boom" }) } };
  assert.deepEqual(mapOpencodeEvent(ev, SID), [{ type: "tool_result", id: "call_1", text: "boom", is_error: true }]);
});

test("tool pending → nothing (tool_use waits for running)", () => {
  const ev = { type: "message.part.updated", properties: { part: toolPart({ status: "pending", input: {}, raw: "" }) } };
  assert.deepEqual(mapOpencodeEvent(ev, SID), []);
});

test("session.error → error event (message extracted)", () => {
  const ev = { type: "session.error", properties: { sessionID: SID, error: { name: "ProviderAuthError", data: { message: "no api key" } } } };
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
