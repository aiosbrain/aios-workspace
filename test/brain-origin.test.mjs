import test from "node:test";
import assert from "node:assert/strict";
import {
  brainApiUrl,
  fetchBrainOriginLocked,
  normalizeBrainOrigin,
} from "../scripts/brain-origin.mjs";

for (const value of [
  "https://brain.example.com",
  "https://brain.example.com/",
  "https://brain.example.com/t/aios",
  "https://brain.example.com/api/v1",
  "https://brain.example.com/api/v1/me",
  "https://brain.example.com/api/v1/items/abc",
]) {
  test(`normalizes ${value} to its origin`, () => {
    assert.equal(normalizeBrainOrigin(value), "https://brain.example.com");
  });
}

test("permits HTTP only for exact loopback hosts", () => {
  assert.equal(normalizeBrainOrigin("http://localhost:3000/t/aios"), "http://localhost:3000");
  assert.equal(normalizeBrainOrigin("http://127.0.0.1:3000/api/v1"), "http://127.0.0.1:3000");
  assert.equal(normalizeBrainOrigin("http://[::1]:3000/api/v1/me"), "http://[::1]:3000");
  assert.throws(() => normalizeBrainOrigin("http://brain.example.com"), /require HTTPS/i);
  assert.throws(() => normalizeBrainOrigin("http://localhost.example.com"), /require HTTPS/i);
});

test("rejects credentials, fragments, queries, protocols, and unrecognized paths", () => {
  const credentialedUrl = new URL("https://brain.example.com");
  credentialedUrl.username = "user";
  credentialedUrl.password = "pass";
  assert.throws(
    () => normalizeBrainOrigin(credentialedUrl.href),
    /username or password/i
  );
  assert.throws(() => normalizeBrainOrigin("https://brain.example.com/#settings"), /fragment/i);
  assert.throws(() => normalizeBrainOrigin("https://brain.example.com/?team=acme"), /query/i);
  assert.throws(() => normalizeBrainOrigin("ftp://brain.example.com"), /protocol/i);
  assert.throws(() => normalizeBrainOrigin("https://brain.example.com/admin"), /not a recognized/i);
  assert.throws(
    () => normalizeBrainOrigin("https://brain.example.com/api/v1/not-real"),
    /not a recognized/i
  );
});

test("builds API URLs only from normalized origins", () => {
  assert.equal(
    brainApiUrl("https://brain.example.com/t/acme", "/me"),
    "https://brain.example.com/api/v1/me"
  );
});

test("same-origin redirects are followed explicitly", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, redirect: options.redirect });
    if (calls.length === 1) {
      return { status: 307, headers: new Headers({ location: "/api/v1/me/" }) };
    }
    return { status: 200, ok: true, headers: new Headers(), text: async () => "{}" };
  };
  const response = await fetchBrainOriginLocked(
    fetchImpl,
    "https://brain.example.com/api/v1/me",
    { headers: { Authorization: "Bearer secret" } },
    "https://brain.example.com"
  );
  assert.equal(response.status, 200);
  assert.equal(calls[1].url, "https://brain.example.com/api/v1/me/");
  assert.ok(calls.every((call) => call.redirect === "manual"));
});

test("cross-origin redirects are rejected before credentials can be replayed", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return { status: 302, headers: new Headers({ location: "https://evil.example/api/v1/me" }) };
  };
  await assert.rejects(
    () =>
      fetchBrainOriginLocked(
        fetchImpl,
        "https://brain.example.com/api/v1/me",
        { headers: { Authorization: "Bearer secret" } },
        "https://brain.example.com"
      ),
    /redirect changed origin/i
  );
  assert.equal(calls, 1);
});
