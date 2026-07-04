// Contributor avatars (AIO-206): brain-first resolution, public-CDN fallback, no-PII fallback path.
import test from "node:test";
import assert from "node:assert/strict";

import { fetchBrainMembers, resolveAvatarUrl } from "../../dist/timeline/index.js";

const MEMBERS = [
  {
    github_login: "john-ellison",
    avatar_url: "https://avatars.githubusercontent.com/u/1?v=4",
    email: "john@example.com",
  },
  { github_login: "chetan-dev", avatar_url: null, email: "chetan@example.com" },
  {
    github_login: null,
    avatar_url: "https://avatars.githubusercontent.com/u/3?v=4",
    email: "nologin@example.com",
  },
];

test("known brain member by login → brain avatar_url", () => {
  assert.equal(
    resolveAvatarUrl({ login: "John-Ellison" }, MEMBERS),
    "https://avatars.githubusercontent.com/u/1?v=4"
  );
});

test("known brain member by email → brain avatar_url (commit authors have no login)", () => {
  assert.equal(
    resolveAvatarUrl({ email: "nologin@example.com" }, MEMBERS),
    "https://avatars.githubusercontent.com/u/3?v=4"
  );
});

test("unknown login → GitHub public CDN fallback, no error, no token", () => {
  assert.equal(
    resolveAvatarUrl({ login: "new-contributor" }, MEMBERS),
    "https://github.com/new-contributor.png"
  );
  assert.equal(
    resolveAvatarUrl({ login: "new-contributor" }, []),
    "https://github.com/new-contributor.png"
  );
});

test("known member with no synced avatar → CDN fallback", () => {
  assert.equal(
    resolveAvatarUrl({ login: "chetan-dev" }, MEMBERS),
    "https://github.com/chetan-dev.png"
  );
});

test("no login and unknown email → null (renderer draws initials)", () => {
  assert.equal(resolveAvatarUrl({ email: "stranger@example.com" }, MEMBERS), null);
  assert.equal(resolveAvatarUrl({}, MEMBERS), null);
});

test("fetchBrainMembers: happy path sends bearer + team header", async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 200, json: async () => ({ members: MEMBERS }) };
  };
  const members = await fetchBrainMembers({
    brainUrl: "https://brain.example/",
    apiKey: "aios_k_s",
    team: "acme",
    fetchImpl,
  });
  assert.equal(members.length, 3);
  assert.equal(seen.url, "https://brain.example/api/v1/members");
  assert.equal(seen.init.headers.Authorization, "Bearer aios_k_s");
  assert.equal(seen.init.headers["X-AIOS-Team"], "acme");
});

test("fetchBrainMembers: missing config / non-200 / network error all degrade to []", async () => {
  assert.deepEqual(await fetchBrainMembers({ brainUrl: null, apiKey: "k" }), []);
  assert.deepEqual(await fetchBrainMembers({ brainUrl: "https://b", apiKey: null }), []);
  assert.deepEqual(
    await fetchBrainMembers({
      brainUrl: "https://b",
      apiKey: "k",
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    }),
    []
  );
  assert.deepEqual(
    await fetchBrainMembers({
      brainUrl: "https://b",
      apiKey: "k",
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    }),
    []
  );
});
