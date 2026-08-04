import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { EXEMPTION_LABEL, evaluateReviewEvidence } from "../scripts/review-evidence.mjs";
import {
  gatherPullRequestFacts,
  resolvePullRequestHead,
  run,
} from "../scripts/validate-pr-review-evidence.mjs";
import { HEAD, attestation } from "./review-evidence-fixtures.mjs";

describe("review evidence — GitHub fact gathering", () => {
  const realFetch = globalThis.fetch;
  let routes;
  let calls;

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    calls = [];
    routes = new Map();
    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      const method = init.method || "GET";
      calls.push({ key: `${method} ${pathname}`, body: init.body && JSON.parse(init.body) });
      const handler = routes.get(`${method} ${pathname}`);
      if (!handler) return new Response("not found", { status: 404 });
      return handler();
    };
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  const json = (value) => () => new Response(JSON.stringify(value), { status: 200 });
  const keys = () => calls.map((call) => call.key);

  /** Head resolution is its own request now, so every fixture starts from the same place. */
  const head = async (labels = []) => {
    routes.set(
      "GET /repos/o/r/pulls/7",
      json({ head: { sha: HEAD }, labels: labels.map((name) => ({ name })) })
    );
    return resolvePullRequestHead("o/r", "7");
  };
  const withComments = (comments) => {
    routes.set("GET /repos/o/r/issues/7/comments", json(comments));
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
  };
  const commitAt = (date) =>
    routes.set(`GET /repos/o/r/commits/${HEAD}`, json({ commit: { committer: { date } } }));
  const labelEvent = (createdAt, actor = "maintainer") =>
    routes.set(
      "GET /repos/o/r/issues/7/timeline",
      json([
        {
          event: "labeled",
          label: { name: EXEMPTION_LABEL },
          actor: { login: actor },
          created_at: createdAt,
        },
      ])
    );

  it("resolves the head, the comments, and each author's write access", async () => {
    const resolved = await head();
    withComments([{ html_url: "c1", user: { login: "reviewer" }, body: attestation() }]);
    routes.set("GET /repos/o/r/collaborators/reviewer/permission", json({ permission: "write" }));
    const facts = await gatherPullRequestFacts("o/r", "7", resolved);
    assert.equal(facts.headSha, HEAD);
    assert.equal(facts.exemption, null);
    assert.deepEqual(
      facts.comments.map((c) => [c.author, c.authorized]),
      [["reviewer", true]]
    );
    assert.equal(evaluateReviewEvidence(facts).ok, true);
  });

  it("treats a 404 on the permission lookup as 'not a collaborator', not as an outage", async () => {
    const resolved = await head();
    withComments([{ html_url: "c1", user: { login: "stranger" }, body: attestation() }]);
    const facts = await gatherPullRequestFacts("o/r", "7", resolved);
    assert.equal(facts.comments[0].authorized, false);
    assert.equal(evaluateReviewEvidence(facts).ok, false);
  });

  it("propagates a non-404 permission failure instead of implying 'no access'", async () => {
    const resolved = await head();
    withComments([{ html_url: "c1", user: { login: "reviewer" }, body: attestation() }]);
    routes.set(
      "GET /repos/o/r/collaborators/reviewer/permission",
      () => new Response("boom", { status: 500 })
    );
    await assert.rejects(gatherPullRequestFacts("o/r", "7", resolved), /HTTP 500/);
  });

  it("honours an exemption whose label was applied AFTER the current head", async () => {
    const resolved = await head([EXEMPTION_LABEL]);
    commitAt("2026-08-04T10:00:00Z");
    labelEvent("2026-08-04T10:05:00Z");
    const facts = await gatherPullRequestFacts("o/r", "7", resolved);
    assert.deepEqual(facts.exemption, { label: EXEMPTION_LABEL, actor: "maintainer" });
    assert.equal(evaluateReviewEvidence(facts).ok, true);
  });

  // THE regression test for P1-1. The first design removed the label on `synchronize` and
  // trusted that removal; when it failed transiently the stale label survived and the next
  // head went green attributed to whoever labelled it BEFORE the push. Nothing here deletes
  // anything — the label is simply too old to qualify, which is the whole point.
  it("refuses a stale exemption whose label predates the current head, with no cleanup having run", async () => {
    const resolved = await head([EXEMPTION_LABEL]);
    commitAt("2026-08-04T11:00:00Z"); // the push
    labelEvent("2026-08-04T10:00:00Z"); // labelled an hour before it
    withComments([]);
    const facts = await gatherPullRequestFacts("o/r", "7", resolved);
    assert.equal(facts.exemption.stale, true);
    const verdict = evaluateReviewEvidence(facts);
    assert.equal(verdict.ok, false, "a stale exemption must not turn the gate green");
    assert.match(verdict.rejected[0].reason, /predates the current head/);
    assert.equal(verdict.rejected[0].author, "maintainer");
    // And it is derived, not cleaned up: the gate never asked GitHub to delete anything.
    assert.ok(
      !keys().some((key) => key.startsWith("DELETE")),
      "the fix must not be a cleanup step"
    );
  });

  it("treats a label applied in the same instant as the head as stale, not fresh", async () => {
    const resolved = await head([EXEMPTION_LABEL]);
    commitAt("2026-08-04T10:00:00Z");
    labelEvent("2026-08-04T10:00:00Z");
    withComments([]);
    assert.equal((await gatherPullRequestFacts("o/r", "7", resolved)).exemption.stale, true);
  });

  it("fails closed when the exemption cannot be dated on either side", async () => {
    const resolved = await head([EXEMPTION_LABEL]);
    commitAt(undefined);
    labelEvent("2026-08-04T10:00:00Z");
    await assert.rejects(gatherPullRequestFacts("o/r", "7", resolved), /cannot be dated/);
    commitAt("2026-08-04T10:00:00Z");
    labelEvent(undefined);
    await assert.rejects(gatherPullRequestFacts("o/r", "7", resolved), /cannot be dated/);
  });

  it("fails closed when the exemption label has no attributable event", async () => {
    const resolved = await head([EXEMPTION_LABEL]);
    commitAt("2026-08-04T10:00:00Z");
    routes.set("GET /repos/o/r/issues/7/timeline", json([]));
    await assert.rejects(
      gatherPullRequestFacts("o/r", "7", resolved),
      /no 'labeled' event attributes it/
    );
  });

  it("fails closed when the head SHA cannot be read", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ labels: [] }));
    await assert.rejects(resolvePullRequestHead("o/r", "7"), /head SHA is unavailable/);
  });

  it("refuses to judge a comment list it could only read part of", async () => {
    const resolved = await head();
    withComments(
      Array.from({ length: 100 }, (_, i) => ({
        html_url: `c${i}`,
        user: { login: "reviewer" },
        body: "noise",
      }))
    );
    await assert.rejects(
      gatherPullRequestFacts("o/r", "7", resolved),
      /refusing to judge a truncated list/
    );
  });

  it("refuses to run without a token", async () => {
    delete process.env.GH_TOKEN;
    await assert.rejects(resolvePullRequestHead("o/r", "7"), /GH_TOKEN is not set/);
  });
});

describe("review evidence — publishing the verdict", () => {
  const realFetch = globalThis.fetch;
  let routes;
  let posted;

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    posted = [];
    routes = new Map();
    globalThis.fetch = async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      const method = init.method || "GET";
      if (method === "POST" && pathname.includes("/statuses/")) {
        posted.push({ pathname, body: JSON.parse(init.body) });
        return new Response("{}", { status: 201 });
      }
      const handler = routes.get(`${method} ${pathname}`);
      if (!handler) return new Response("not found", { status: 404 });
      return handler();
    };
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  const json = (value) => () => new Response(JSON.stringify(value), { status: 200 });
  const argv = ["--repo", "o/r", "--pr", "7"];

  it("publishes success against the head when evidence is current", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, labels: [] }));
    routes.set(
      "GET /repos/o/r/issues/7/comments",
      json([{ html_url: "c1", user: { login: "reviewer" }, body: attestation() }])
    );
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    routes.set("GET /repos/o/r/collaborators/reviewer/permission", json({ permission: "write" }));
    const outcome = await run(argv);
    assert.equal(outcome.verdict.ok, true);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].pathname, `/repos/o/r/statuses/${HEAD}`);
    assert.equal(posted[0].body.state, "success");
  });

  // THE regression test for P1-2. The head is known, then everything after it fails. The old
  // shape assigned headSha only after the whole gather succeeded, so this posted NOTHING and a
  // SHA that had gone green on an earlier run silently stayed green.
  it("turns an already-green head RED when it can no longer answer", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, labels: [] }));
    routes.set("GET /repos/o/r/issues/7/comments", () => new Response("upstream", { status: 500 }));
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    const outcome = await run(argv);
    assert.equal(outcome.verdict.ok, false);
    assert.equal(outcome.published, true, "a failure after head resolution must be published");
    assert.equal(posted.length, 1, "exactly one status, against the head we already knew");
    assert.equal(posted[0].pathname, `/repos/o/r/statuses/${HEAD}`);
    assert.equal(posted[0].body.state, "failure");
    assert.match(posted[0].body.description, /Gate error/);
  });

  it("publishes failure when a stale exemption is the only thing on the PR", async () => {
    routes.set(
      "GET /repos/o/r/pulls/7",
      json({ head: { sha: HEAD }, labels: [{ name: EXEMPTION_LABEL }] })
    );
    routes.set(
      `GET /repos/o/r/commits/${HEAD}`,
      json({ commit: { committer: { date: "2026-08-04T11:00:00Z" } } })
    );
    routes.set(
      "GET /repos/o/r/issues/7/timeline",
      json([
        {
          event: "labeled",
          label: { name: EXEMPTION_LABEL },
          actor: { login: "maintainer" },
          created_at: "2026-08-04T10:00:00Z",
        },
      ])
    );
    routes.set("GET /repos/o/r/issues/7/comments", json([]));
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    const outcome = await run(argv);
    assert.equal(outcome.verdict.ok, false);
    assert.equal(posted[0].body.state, "failure");
  });

  it("posts nothing — leaving the context pending — when even the head is unknown", async () => {
    routes.set("GET /repos/o/r/pulls/7", () => new Response("gone", { status: 500 }));
    const outcome = await run(argv);
    assert.equal(outcome.verdict.ok, false);
    assert.equal(outcome.published, false);
    assert.equal(outcome.failed, true);
    assert.deepEqual(posted, []);
  });

  it("evaluates without publishing under --no-status", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, labels: [] }));
    routes.set("GET /repos/o/r/issues/7/comments", json([]));
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    const outcome = await run([...argv, "--no-status"]);
    assert.equal(outcome.published, false);
    assert.deepEqual(posted, []);
  });
});

// Every entry here is a way the gate can be satisfied that it deliberately does NOT stop.
// They are pinned as tests so the acceptance is a recorded decision with an expected value,
// not a paragraph of prose that quietly stops being true. See the threat model in
