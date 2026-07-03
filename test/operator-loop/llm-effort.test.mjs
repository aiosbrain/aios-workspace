// runCompletion effort/model threading (AIO-192, Major #4) — a fake Anthropic client records the
// request so we can assert the resolved model + output_config.effort reach the SDK, that the
// forced-`emit` tool is used, and that the banned sampling params are never sent (they 400 on 4.8).

import test from "node:test";
import assert from "node:assert/strict";
import { runCompletion, makeAnthropicCompletion, DRAFTER_MODEL } from "../../dist/operator-loop/index.js";

function fakeClient(capture) {
  return {
    messages: {
      create: async (body, opts) => {
        capture.body = body;
        capture.opts = opts;
        return { content: [{ type: "tool_use", name: "emit", input: { ok: true } }] };
      },
    },
  };
}

test("runCompletion threads model + output_config.effort + timeout; forced emit tool; no sampling params", async () => {
  const capture = {};
  const out = await runCompletion(
    fakeClient(capture),
    { system: "sys", user: "usr", schema: { type: "object" }, maxTokens: 1234 },
    { model: "claude-opus-4-8", effort: "high", timeoutMs: 42000 }
  );
  assert.deepEqual(out, { ok: true }, "returns the tool_use.input");
  assert.equal(capture.body.model, "claude-opus-4-8");
  assert.deepEqual(capture.body.output_config, { effort: "high" });
  assert.equal(capture.body.max_tokens, 1234);
  assert.equal(capture.body.tool_choice.name, "emit");
  assert.equal(capture.body.tools[0].name, "emit");
  assert.equal(capture.opts.timeout, 42000);
  for (const banned of ["temperature", "top_p", "top_k", "budget_tokens"]) {
    assert.ok(!(banned in capture.body), `${banned} must not be sent`);
  }
});

test("runCompletion without effort omits output_config and defaults the model", async () => {
  const capture = {};
  await runCompletion(fakeClient(capture), { system: "s", user: "u" }, {});
  assert.equal(capture.body.model, DRAFTER_MODEL);
  assert.ok(!("output_config" in capture.body), "no effort → no output_config");
  assert.equal(capture.opts, undefined, "no timeout → no request options");
});

test("runCompletion throws when the model returns no tool_use block (fail-closed)", async () => {
  const client = { messages: { create: async () => ({ content: [{ type: "text", text: "nope" }] }) } };
  await assert.rejects(() => runCompletion(client, { system: "s", user: "u" }), /no structured tool_use/);
});

test("makeAnthropicCompletion returns a CompletionFn (constructing the client needs the egress key)", async () => {
  // No ANTHROPIC_API_KEY here → invoking it must fail when it tries to build the client.
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const fn = makeAnthropicCompletion({ model: "claude-opus-4-8", effort: "high" });
    assert.equal(typeof fn, "function");
    await assert.rejects(async () => {
      await fn({ system: "s", user: "u" });
    }, /ANTHROPIC_API_KEY is not set/);
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});
