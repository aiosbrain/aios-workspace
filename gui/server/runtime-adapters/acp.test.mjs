// Contract test (Codex #3): feed canned ACP session/update notifications through
// the ACP adapter's mapping and assert it emits the EXACT WS field shapes the
// React client consumes (delta | tool_use | tool_result), so the adapter can't
// drift from the client contract without this failing.
//
// Run: node --test gui/server/runtime-adapters/acp.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { mapSessionUpdate, acpSpawnArgs, jsonRpcLines, openclawSessionKey } from "./acp.mjs";

test("jsonRpcLines drops non-JSON stdout noise (banners), keeps JSON-RPC lines", async () => {
  // Simulate OpenClaw's stdout: a boxed config-warning banner interleaved with
  // real ndJSON-RPC messages.
  const raw =
    [
      "Config warnings:",
      "┌─────────────────────────────────────────┐",
      "│  - plugins.entries.minimax-portal-auth   │",
      "└─────────────────────────────────────────┘",
      '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"x":1}}',
    ].join("\n") + "\n";
  const web = jsonRpcLines(Readable.from([raw]));
  const reader = web.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 2); // only the two JSON-RPC objects survive
  assert.deepEqual(JSON.parse(lines[0]), { jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
  assert.equal(JSON.parse(lines[1]).method, "session/update");
});

test("acpSpawnArgs: hermes appends --accept-hooks", () => {
  assert.deepEqual(acpSpawnArgs("hermes", ["acp"], {}), ["acp", "--accept-hooks"]);
});

test("acpSpawnArgs: openclaw with no gateway password is unchanged", () => {
  assert.deepEqual(acpSpawnArgs("openclaw", ["acp"], {}), ["acp"]);
});

test("acpSpawnArgs: openclaw prefers --password-file over --password", () => {
  const env = {
    OPENCLAW_GATEWAY_PASSWORD_FILE: "/secrets/pw",
    OPENCLAW_GATEWAY_PASSWORD: "inline",
  };
  assert.deepEqual(acpSpawnArgs("openclaw", ["acp"], env), [
    "acp",
    "--password-file",
    "/secrets/pw",
  ]);
});

test("acpSpawnArgs: openclaw falls back to --password when only the inline var is set", () => {
  assert.deepEqual(acpSpawnArgs("openclaw", ["acp"], { OPENCLAW_GATEWAY_PASSWORD: "s3cret" }), [
    "acp",
    "--password",
    "s3cret",
  ]);
});

test("acpSpawnArgs: unknown bin is unchanged", () => {
  assert.deepEqual(acpSpawnArgs("somebin", ["acp"], { OPENCLAW_GATEWAY_PASSWORD: "x" }), ["acp"]);
});

test("acpSpawnArgs: openclaw pins --session before the password flag", () => {
  // Without a session key the bridge mints acp:<uuid> sessions the Gateway can't
  // run (ACP_SESSION_INIT_FAILED). The session key must be passed for every turn.
  assert.deepEqual(
    acpSpawnArgs(
      "openclaw",
      ["acp"],
      { OPENCLAW_GATEWAY_PASSWORD: "s3cret" },
      { sessionKey: "agent:main:aios-gui-abc" }
    ),
    ["acp", "--session", "agent:main:aios-gui-abc", "--password", "s3cret"]
  );
});

test("acpSpawnArgs: openclaw with a session key and no password", () => {
  assert.deepEqual(
    acpSpawnArgs("openclaw", ["acp"], {}, { sessionKey: "agent:main:aios-gui-abc" }),
    ["acp", "--session", "agent:main:aios-gui-abc"]
  );
});

test("openclawSessionKey: stable, repo-scoped, under the main agent", () => {
  const a = openclawSessionKey("/repo/one");
  const b = openclawSessionKey("/repo/one");
  const c = openclawSessionKey("/repo/two");
  assert.equal(a, b); // stable per repo (reused across turns)
  assert.notEqual(a, c); // isolated between repos
  assert.match(a, /^agent:main:aios-gui-[0-9a-f]{12}$/); // routes to the main agent, not acp:<uuid>
});

test("agent_message_chunk (text) → delta{text}", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "hello " },
  });
  assert.deepEqual(out, [{ type: "delta", text: "hello " }]);
});

test("non-text agent_message_chunk → nothing", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "image", data: "..." },
  });
  assert.deepEqual(out, []);
});

test("agent_thought_chunk → nothing (no UI channel)", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "hmm" },
  });
  assert.deepEqual(out, []);
});

test("tool_call → assistant_done then tool_use{name,input,id}", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc_1",
    title: "Write file",
    kind: "edit",
    rawInput: { path: "a.md", content: "x" },
  });
  assert.deepEqual(out, [
    { type: "assistant_done" },
    { type: "tool_use", name: "Write file", input: { path: "a.md", content: "x" }, id: "tc_1" },
  ]);
});

test("tool_call without title/rawInput falls back to kind + {}", () => {
  const out = mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "tc_2", kind: "read" });
  assert.equal(out[1].name, "read");
  assert.deepEqual(out[1].input, {});
  assert.equal(out[1].id, "tc_2");
});

test("tool_call_update completed → tool_result with extracted text, is_error false", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "done" } }],
  });
  assert.equal(out.length, 1);
  const ev = out[0];
  assert.equal(ev.type, "tool_result");
  assert.equal(ev.id, "tc_1");
  assert.equal(ev.text, "done");
  assert.equal(ev.is_error, false);
  assert.equal(typeof ev.is_error, "boolean"); // client contract: is_error is a boolean
});

test("tool_call_update failed → tool_result is_error true", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_3",
    status: "failed",
    content: [],
  });
  assert.equal(out[0].is_error, true);
});

test("tool_call_update in_progress → nothing (not terminal)", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_1",
    status: "in_progress",
  });
  assert.deepEqual(out, []);
});

test("tool_call_update extracts diff content", () => {
  const out = mapSessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_4",
    status: "completed",
    content: [{ type: "diff", path: "a.md", newText: "new body" }],
  });
  assert.equal(out[0].text, "new body");
});

test("unknown / unhandled updates → nothing", () => {
  for (const u of ["plan", "current_mode_update", "usage_update", "available_commands_update"]) {
    assert.deepEqual(mapSessionUpdate({ sessionUpdate: u }), []);
  }
  assert.deepEqual(mapSessionUpdate(null), []);
  assert.deepEqual(mapSessionUpdate("nope"), []);
});
