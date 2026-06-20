// Contract test: feed canned `codex exec --json` JSONL events through the Codex
// adapter's mapping and assert the exact WS field shapes the React client
// consumes (delta | tool_use | tool_result | assistant_done | error), so the
// adapter can't drift from the client contract without this failing.
//
// Run: node --test gui/server/runtime-adapters/codex.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapCodexEvent } from "./codex.mjs";

test("agent_message completed → delta + assistant_done", () => {
  const out = mapCodexEvent({
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "hello world" },
  });
  assert.deepEqual(out, [{ type: "delta", text: "hello world" }, { type: "assistant_done" }]);
});

test("empty agent_message → nothing", () => {
  assert.deepEqual(
    mapCodexEvent({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "" } }),
    []
  );
});

test("command_execution started → tool_use{shell, command}", () => {
  const out = mapCodexEvent({
    type: "item.started",
    item: { id: "c1", type: "command_execution", command: "ls -la", status: "in_progress" },
  });
  assert.deepEqual(out, [
    { type: "tool_use", name: "shell", input: { command: "ls -la" }, id: "c1" },
  ]);
});

test("command_execution completed → tool_result with output, is_error from status", () => {
  const ok = mapCodexEvent({
    type: "item.completed",
    item: {
      id: "c1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "file.txt\n",
      exit_code: 0,
      status: "completed",
    },
  });
  assert.equal(ok[0].type, "tool_result");
  assert.equal(ok[0].id, "c1");
  assert.equal(ok[0].text, "file.txt\n");
  assert.equal(ok[0].is_error, false);
  assert.equal(typeof ok[0].is_error, "boolean");

  const bad = mapCodexEvent({
    type: "item.completed",
    item: {
      id: "c2",
      type: "command_execution",
      command: "nope",
      aggregated_output: "err",
      status: "failed",
    },
  });
  assert.equal(bad[0].is_error, true);
});

test("file_change started → tool_use{apply_patch}; completed → summarized tool_result", () => {
  const started = mapCodexEvent({
    type: "item.started",
    item: {
      id: "f1",
      type: "file_change",
      changes: [{ path: "a.md", kind: "add" }],
      status: "completed",
    },
  });
  assert.equal(started[0].type, "tool_use");
  assert.equal(started[0].name, "apply_patch");
  assert.equal(started[0].id, "f1");

  const done = mapCodexEvent({
    type: "item.completed",
    item: {
      id: "f1",
      type: "file_change",
      changes: [
        { path: "a.md", kind: "add" },
        { path: "b.md", kind: "update" },
      ],
      status: "completed",
    },
  });
  assert.equal(done[0].type, "tool_result");
  assert.equal(done[0].text, "add a.md\nupdate b.md");
  assert.equal(done[0].is_error, false);
});

test("mcp_tool_call started → tool_use{server/tool}; completed → text from result", () => {
  const started = mapCodexEvent({
    type: "item.started",
    item: {
      id: "m1",
      type: "mcp_tool_call",
      server: "fs",
      tool: "read",
      arguments: { p: "x" },
      status: "in_progress",
    },
  });
  assert.deepEqual(started[0], { type: "tool_use", name: "fs/read", input: { p: "x" }, id: "m1" });

  const done = mapCodexEvent({
    type: "item.completed",
    item: {
      id: "m1",
      type: "mcp_tool_call",
      server: "fs",
      tool: "read",
      result: { content: [{ type: "text", text: "data" }] },
      status: "completed",
    },
  });
  assert.equal(done[0].text, "data");
  assert.equal(done[0].is_error, false);

  const err = mapCodexEvent({
    type: "item.completed",
    item: {
      id: "m2",
      type: "mcp_tool_call",
      server: "fs",
      tool: "read",
      error: { message: "boom" },
      status: "failed",
    },
  });
  assert.equal(err[0].text, "boom");
  assert.equal(err[0].is_error, true);
});

test("web_search → tool_use then tool_result", () => {
  assert.deepEqual(
    mapCodexEvent({
      type: "item.started",
      item: { id: "w1", type: "web_search", query: "acp spec" },
    }),
    [{ type: "tool_use", name: "web_search", input: { query: "acp spec" }, id: "w1" }]
  );
  assert.deepEqual(
    mapCodexEvent({
      type: "item.completed",
      item: { id: "w1", type: "web_search", query: "acp spec" },
    }),
    [{ type: "tool_result", id: "w1", text: "searched: acp spec", is_error: false }]
  );
});

test("turn.failed and fatal error → error event", () => {
  assert.deepEqual(mapCodexEvent({ type: "turn.failed", error: { message: "rate limited" } }), [
    { type: "error", message: "rate limited" },
  ]);
  assert.deepEqual(mapCodexEvent({ type: "error", message: "stream died" }), [
    { type: "error", message: "stream died" },
  ]);
});

test("error item → error event", () => {
  assert.deepEqual(
    mapCodexEvent({
      type: "item.completed",
      item: { id: "e1", type: "error", message: "tool blew up" },
    }),
    [{ type: "error", message: "tool blew up" }]
  );
});

test("lifecycle/no-UI events → nothing (run loop owns thread_id + result)", () => {
  for (const ev of [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.started" },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } },
    {
      type: "item.updated",
      item: { id: "c1", type: "command_execution", command: "ls", status: "in_progress" },
    },
    { type: "item.completed", item: { id: "r1", type: "reasoning", text: "thinking" } },
    { type: "item.completed", item: { id: "t1", type: "todo_list", items: [] } },
  ]) {
    assert.deepEqual(mapCodexEvent(ev), []);
  }
  assert.deepEqual(mapCodexEvent(null), []);
  assert.deepEqual(mapCodexEvent("nope"), []);
});
