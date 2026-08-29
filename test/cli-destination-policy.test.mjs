import test from "node:test";
import assert from "node:assert/strict";
import { trustedFetch, validateDestination } from "../scripts/cli/destination-policy.mjs";

const response = (status = 200, location = null) => ({
  status,
  headers: { get: (name) => (name === "location" ? location : null) },
});

test("trust is established before credential materialization", async () => {
  let materialized = 0;
  await assert.rejects(
    trustedFetch("http://example.invalid", {
      credentialFactory: async () => (materialized++, { authorization: "fixture" }),
      fetch: async () => response(),
    }),
    (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED"
  );
  assert.equal(materialized, 0);
});

test("insecure loopback is literal, explicit, and credential-free", async () => {
  assert.equal(
    validateDestination("http://127.2.3.4:8080", { env: { AIOS_ALLOW_INSECURE_LOOPBACK: "1" } })
      .hostname,
    "127.2.3.4"
  );
  for (const input of [
    "http://localhost",
    "http://2130706433",
    "http://0177.0.0.1",
    "http://127.0.0.1@example.invalid",
  ]) {
    assert.throws(
      () => validateDestination(input, { env: { AIOS_ALLOW_INSECURE_LOOPBACK: "1" } }),
      (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED",
      input
    );
  }
  assert.throws(
    () =>
      validateDestination("http://127.0.0.1", { allowInsecureLoopback: true, credentialed: true }),
    (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED"
  );
  await assert.rejects(
    trustedFetch("http://127.0.0.1", {
      allowInsecureLoopback: true,
      headers: { Authorization: "fixture" },
      fetch: async () => response(),
    }),
    (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED"
  );
});

test("explicit and inferred credential state rejects insecure loopback", async () => {
  let fetches = 0;
  const rejectLoopback = async (options) =>
    assert.rejects(
      trustedFetch("http://127.0.0.1", {
        allowInsecureLoopback: true,
        fetch: async () => (fetches++, response()),
        ...options,
      }),
      (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED"
    );

  await rejectLoopback({ credentialed: true });
  for (const name of [
    "X-Auth",
    "x_CREDENTIALS",
    "X.Session-ID",
    "X-Signature",
    "X-Access_Key",
    "X-Bearer",
    "X-Sig",
    "X-JWT",
    "X-Custom-Metadata",
    "Content_Type",
    "Content--Type",
    "Content.Type",
  ]) {
    await rejectLoopback({ headers: { [name]: "fixture" } });
  }
  assert.equal(fetches, 0);
});

test("redirects are revalidated and credentials never cross origins", async () => {
  const seen = [];
  await assert.rejects(
    trustedFetch("https://one.invalid/start", {
      credentialFactory: async () => ({ authorization: "fixture" }),
      fetch: async (url, init) => (
        seen.push({ url: String(url), headers: init.headers }),
        response(302, "https://two.invalid/end")
      ),
    }),
    (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED"
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.authorization, "fixture");

  await assert.rejects(
    trustedFetch("https://one.invalid/start", {
      headers: { "X-Api-Key": "fixture" },
      fetch: async () => response(302, "https://two.invalid/end"),
    }),
    (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED"
  );
});

test("explicit and inferred credential state never crosses origins", async () => {
  const cases = [
    ["explicit flag", { credentialed: true }],
    ...[
      "X-Auth",
      "x_CREDENTIALS",
      "X.Session-ID",
      "X-Signature",
      "X-Access_Key",
      "X-Bearer",
      "X-Sig",
      "X-JWT",
      "X-Custom-Metadata",
      "Content_Type",
      "Content--Type",
      "Content.Type",
    ].map((name) => [name, { headers: { [name]: "fixture" } }]),
  ];
  for (const [name, options] of cases) {
    let fetches = 0;
    await assert.rejects(
      trustedFetch("https://one.invalid/start", {
        fetch: async () => (fetches++, response(302, "https://two.invalid/end")),
        ...options,
      }),
      (error) => error.code === "AIOS_E_DESTINATION_UNTRUSTED",
      name
    );
    assert.equal(fetches, 1, name);
  }
});

test("content-only headers may follow cross-origin redirects", async () => {
  const seen = [];
  const result = await trustedFetch("https://one.invalid/start", {
    headers: { "cOnTeNt-TyPe": "text/plain", "CONTENT-LENGTH": "7" },
    fetch: async (url) => {
      seen.push(String(url));
      return seen.length === 1 ? response(307, "https://two.invalid/end") : response();
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(seen, ["https://one.invalid/start", "https://two.invalid/end"]);
});

test("redirect method rewriting follows fetch semantics without forwarding content headers", async () => {
  const seen = [];
  const result = await trustedFetch("https://one.invalid/start", {
    method: "POST",
    body: "fixture-body",
    headers: { "Content-Type": "text/plain" },
    fetch: async (_url, init) => {
      seen.push(init);
      return seen.length === 1 ? response(303, "/done") : response();
    },
  });
  assert.equal(result.status, 200);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[1].body, undefined);
  assert.deepEqual(seen[1].headers, {});
});
