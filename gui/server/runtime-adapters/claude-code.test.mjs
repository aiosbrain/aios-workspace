// mapAssistantMessage — pure translation of one SDK "assistant" message into
// WS-shaped events. Run: node --test gui/server/runtime-adapters/claude-code.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapAssistantMessage } from "./claude-code.mjs";

test("synthetic API-error message (billing) emits a typed error carrying the real text", () => {
  const message = {
    isApiErrorMessage: true,
    error: "billing_error",
    apiErrorStatus: 400,
    message: {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: "Credit balance is too low" }],
    },
  };
  assert.deepEqual(mapAssistantMessage(message), [
    { type: "error", message: "Credit balance is too low" },
  ]);
});

test("synthetic message with no text content falls back to a generic error message", () => {
  const message = { isApiErrorMessage: true, message: { model: "<synthetic>", content: [] } };
  assert.deepEqual(mapAssistantMessage(message), [
    { type: "error", message: "The runtime returned an error with no message." },
  ]);
});

test("synthetic model without the isApiErrorMessage flag is still treated as an error", () => {
  const message = {
    message: { model: "<synthetic>", content: [{ type: "text", text: "Prompt is too long" }] },
  };
  assert.deepEqual(mapAssistantMessage(message), [
    { type: "error", message: "Prompt is too long" },
  ]);
});

test("normal assistant message with tool_use emits tool_use, not error", () => {
  const message = {
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "tool_use", name: "Read", input: { file_path: "/x" }, id: "t1" }],
    },
  };
  assert.deepEqual(mapAssistantMessage(message), [
    { type: "tool_use", name: "Read", input: { file_path: "/x" }, id: "t1" },
  ]);
});

test("normal assistant message with only text emits nothing — text already streamed via delta", () => {
  const message = {
    message: {
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "already streamed via content_block_delta" }],
    },
  };
  assert.deepEqual(mapAssistantMessage(message), []);
});

test("normal assistant message with mixed text + tool_use only forwards tool_use", () => {
  const message = {
    message: {
      model: "claude-sonnet-4-6",
      content: [
        { type: "text", text: "already streamed" },
        { type: "tool_use", name: "Bash", input: { command: "ls" }, id: "t2" },
      ],
    },
  };
  assert.deepEqual(mapAssistantMessage(message), [
    { type: "tool_use", name: "Bash", input: { command: "ls" }, id: "t2" },
  ]);
});
