import test from "node:test";
import assert from "node:assert/strict";
import { redactedCredential, resolveCredentialRoot } from "../scripts/cli/credential-broker.mjs";

test("one complete highest-precedence root is selected without field assembly", async () => {
  const selected = await resolveCredentialRoot({
    requiredFields: ["url", "token"],
    roots: [
      { name: "explicit", load: async () => null },
      {
        name: "environment",
        load: async () => ({ url: "https://example.invalid", token: "fixture-token" }),
      },
      { name: "lower", load: async () => ({ url: "https://wrong.invalid", token: "wrong" }) },
    ],
  });
  assert.equal(selected.source.name, "environment");
  assert.equal(selected.values.url, "https://example.invalid");
  assert.deepEqual(redactedCredential(selected), {
    configured: true,
    source: { name: "environment", fields: ["token", "url"] },
  });
});

test("an incomplete higher root stops before a lower complete root", async () => {
  let lowerLoads = 0;
  await assert.rejects(
    resolveCredentialRoot({
      requiredFields: ["url", "token"],
      roots: [
        { name: "higher", load: async () => ({ url: "https://example.invalid" }) },
        {
          name: "lower",
          load: async () => (lowerLoads++, { url: "https://lower.invalid", token: "x" }),
        },
      ],
    }),
    (error) => error.code === "AIOS_E_CREDENTIAL_INCOMPLETE"
  );
  assert.equal(lowerLoads, 0);
});

test("reference resolution stays within the selected root", async () => {
  const calls = [];
  const result = await resolveCredentialRoot({
    requiredFields: ["url", "token"],
    roots: [
      {
        name: "named",
        load: async () => ({ url: "url-ref", token: "token-ref", optional: "opt-ref" }),
      },
    ],
    resolveReference: async (value, context) => (calls.push(context), `resolved:${value}`),
  });
  assert.equal(result.values.optional, "resolved:opt-ref");
  assert.deepEqual(new Set(calls.map((call) => call.root)), new Set(["named"]));
});
