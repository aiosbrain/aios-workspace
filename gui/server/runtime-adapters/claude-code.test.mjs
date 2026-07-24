// mapAssistantMessage — pure translation of one SDK "assistant" message into
// WS-shaped events. Run: node --test gui/server/runtime-adapters/claude-code.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mapAssistantMessage } from "./claude-code.mjs";

// Shape per the installed SDK's own sdk.d.ts (SDKAssistantMessage.error: SDKAssistantMessageError),
// not the Claude Code CLI's separate on-disk transcript format (which uses different,
// undocumented field names for the same event).
test("SDK error-flagged message (billing) emits a typed error carrying the real text", () => {
  const message = {
    type: "assistant",
    error: "billing_error",
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

test("error-flagged message with no text content falls back to the error enum value", () => {
  const message = { error: "rate_limit", message: { model: "<synthetic>", content: [] } };
  assert.deepEqual(mapAssistantMessage(message), [
    { type: "error", message: "Runtime error: rate_limit" },
  ]);
});

test("every documented SDKAssistantMessageError enum value is treated as an error", () => {
  const values = [
    "authentication_failed",
    "oauth_org_not_allowed",
    "billing_error",
    "rate_limit",
    "overloaded",
    "invalid_request",
    "model_not_found",
    "server_error",
    "unknown",
    "max_output_tokens",
  ];
  for (const error of values) {
    const message = { error, message: { content: [{ type: "text", text: `msg:${error}` }] } };
    assert.deepEqual(
      mapAssistantMessage(message),
      [{ type: "error", message: `msg:${error}` }],
      error
    );
  }
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
