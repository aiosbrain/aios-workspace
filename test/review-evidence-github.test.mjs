import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { STATUS_CONTEXT, evaluateReviewEvidence } from "../scripts/review-evidence.mjs";
import {
  gatherPullRequestFacts,
  postStatus,
  resolvePullRequestHead,
  run,
} from "../scripts/validate-pr-review-evidence.mjs";
import { HEAD, attestation, exemption } from "./review-evidence-fixtures.mjs";

/**
 * One stub for every suite in this file. `routes` maps "METHOD /path" to a handler; anything
 * unrouted 404s, which is also how "this collaborator does not exist" is expressed.
 */
function stubGitHub() {
  const state = { routes: new Map(), calls: [], posted: [] };
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.calls.push({ key: `${method} ${pathname}`, body });
    const handler = state.routes.get(`${method} ${pathname}`);
    if (method === "POST" && pathname.includes("/statuses/")) {
      state.posted.push({ pathname, body });
      // Publishing succeeds unless a test deliberately routes it to a failure, so a suite that
      // is not about publishing does not silently exercise the retry loop four times.
      return handler ? handler() : new Response("{}", { status: 201 });
    }
    if (!handler) return new Response("not found", { status: 404 });
    return handler();
  };
  return state;
}

const json = (value) => () => new Response(JSON.stringify(value), { status: 200 });

describe("review evidence — GitHub fact gathering", () => {
  const realFetch = globalThis.fetch;
  let gh;

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    gh = stubGitHub();
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  const head = async (pull = {}) => {
    gh.routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, ...pull }));
    return resolvePullRequestHead("o/r", "7");
  };
  const withComments = (comments, reviews = []) => {
    gh.routes.set("GET /repos/o/r/issues/7/comments", json(comments));
    gh.routes.set("GET /repos/o/r/pulls/7/reviews", json(reviews));
  };
  const writeAccess = (login) =>
    gh.routes.set(
      `GET /repos/o/r/collaborators/${login}/permission`,
      json({ permission: "write" })
    );

  it("resolves the head, the comments, and each author's write access", async () => {
    const resolved = await head();
    withComments([{ html_url: "c1", user: { login: "reviewer" }, body: attestation() }]);
    writeAccess("reviewer");
    const facts = await gatherPullRequestFacts("o/r", "7", resolved);
    assert.equal(facts.headSha, HEAD);
    assert.deepEqual(
      facts.comments.map((c) => [c.author, c.authorized]),
      [["reviewer", true]]
    );
    assert.equal(evaluateReviewEvidence(facts).ok, true);
  });

  it("reads PR review bodies as well as issue comments", async () => {
    const resolved = await head();
    withComments([], [{ html_url: "r1", user: { login: "reviewer" }, body: attestation() }]);
    writeAccess("reviewer");
    assert.equal(
      evaluateReviewEvidence(await gatherPullRequestFacts("o/r", "7", resolved)).ok,
      true
    );
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
    gh.routes.set(
      "GET /repos/o/r/collaborators/reviewer/permission",
      () => new Response("boom", { status: 500 })
    );
    await assert.rejects(gatherPullRequestFacts("o/r", "7", resolved), /HTTP 500/);
  });

  it("honours an exemption comment naming the head, end to end", async () => {
    const resolved = await head();
    withComments([{ html_url: "c1", user: { login: "maintainer" }, body: exemption() }]);
    writeAccess("maintainer");
    const verdict = evaluateReviewEvidence(await gatherPullRequestFacts("o/r", "7", resolved));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.kind, "exempt");
  });

  // The redesign deleted the label path outright. These assertions are what stops it coming
  // back by accident: an exemption is a comment, and no label, timeline or commit-date lookup
  // may creep into the gather path — every one of those was a way for an exemption to go stale
  // without saying so.
  it("consults no label, no timeline and no commit date to decide an exemption", async () => {
    const resolved = await head({ labels: [{ name: "review-evidence-exempt" }] });
    withComments([{ html_url: "c1", user: { login: "maintainer" }, body: exemption() }]);
    writeAccess("maintainer");
    await gatherPullRequestFacts("o/r", "7", resolved);
    const paths = gh.calls.map((call) => call.key);
    assert.ok(!paths.some((p) => p.includes("/timeline")), "no timeline fetch");
    assert.ok(!paths.some((p) => p.includes("/commits/")), "no commit-date fetch");
    assert.ok(!paths.some((p) => p.startsWith("DELETE")), "no label mutation");
  });

  it("a bare exemption label without a comment does not exempt anything", async () => {
    const resolved = await head({ labels: [{ name: "review-evidence-exempt" }] });
    withComments([]);
    const verdict = evaluateReviewEvidence(await gatherPullRequestFacts("o/r", "7", resolved));
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "missing");
  });

  it("fails closed when the head SHA cannot be read", async () => {
    gh.routes.set("GET /repos/o/r/pulls/7", json({}));
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
  let gh;
  const argv = ["--repo", "o/r", "--pr", "7"];
  const noWait = { attempts: 4, backoffMs: 0, sleep: async () => {} };

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    gh = stubGitHub();
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  const greenPr = () => {
    gh.routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD } }));
    gh.routes.set(
      "GET /repos/o/r/issues/7/comments",
      json([{ html_url: "c1", user: { login: "reviewer" }, body: attestation() }])
    );
    gh.routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    gh.routes.set(
      "GET /repos/o/r/collaborators/reviewer/permission",
      json({ permission: "write" })
    );
  };

  it("publishes success against the head when evidence is current", async () => {
    greenPr();
    const outcome = await run(argv, { statusOptions: noWait });
    assert.equal(outcome.verdict.ok, true);
    assert.equal(gh.posted.length, 1);
    assert.equal(gh.posted[0].pathname, `/repos/o/r/statuses/${HEAD}`);
    assert.equal(gh.posted[0].body.state, "success");
  });

  // Regression test for "failure did not turn an already-green SHA red": the head is known,
  // everything after it fails, and that failure must still be PUBLISHED against the head.
  it("turns an already-green head RED when it can no longer answer", async () => {
    gh.routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD } }));
    gh.routes.set("GET /repos/o/r/issues/7/comments", () => new Response("up", { status: 500 }));
    gh.routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    const outcome = await run(argv, { statusOptions: noWait });
    assert.equal(outcome.verdict.ok, false);
    assert.equal(outcome.published, true, "a failure after head resolution must be published");
    assert.equal(gh.posted.length, 1);
    assert.equal(gh.posted[0].body.state, "failure");
    assert.match(gh.posted[0].body.description, /Gate error/);
  });

  it("posts nothing — leaving the context pending — when even the head is unknown", async () => {
    gh.routes.set("GET /repos/o/r/pulls/7", () => new Response("gone", { status: 500 }));
    const outcome = await run(argv, { statusOptions: noWait });
    assert.equal(outcome.published, false);
    assert.equal(outcome.failed, true);
    assert.deepEqual(gh.posted, []);
  });

  it("evaluates without publishing under --no-status", async () => {
    gh.routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD } }));
    gh.routes.set("GET /repos/o/r/issues/7/comments", json([]));
    gh.routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    const outcome = await run([...argv, "--no-status"], { statusOptions: noWait });
    assert.equal(outcome.published, false);
    assert.deepEqual(gh.posted, []);
  });

  it("retries a refused status write, with backoff, before giving up", async () => {
    const slept = [];
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return attempts < 3
        ? new Response("flaky", { status: 502 })
        : new Response("{}", { status: 201 });
    };
    const used = await postStatus("o/r", HEAD, { ok: true, summary: "ok" }, undefined, {
      attempts: 4,
      backoffMs: 10,
      sleep: async (ms) => slept.push(ms),
    });
    assert.equal(used, 3, "should have succeeded on the third attempt");
    assert.deepEqual(slept, [10, 20], "backoff should double between attempts");
  });

  it("gives up after the configured number of attempts", async () => {
    let attempts = 0;
    globalThis.fetch = async () => {
      attempts += 1;
      return new Response("nope", { status: 503 });
    };
    await assert.rejects(
      postStatus("o/r", HEAD, { ok: false, summary: "red" }, undefined, {
        attempts: 3,
        backoffMs: 0,
        sleep: async () => {},
      }),
      /HTTP 503/
    );
    assert.equal(attempts, 3);
  });

  // The residual we cannot fix: if publishing is what failed, the previous status stands. The
  // requirement is that the run says so unmistakably rather than exiting quietly non-zero.
  it("is unmistakable when it decided RED and could not publish it", async () => {
    gh.routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD } }));
    gh.routes.set("GET /repos/o/r/issues/7/comments", json([]));
    gh.routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    const errors = [];
    const realError = console.error;
    console.error = (line) => errors.push(String(line));
    const realFetchLocal = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if ((init.method || "GET") === "POST") return new Response("nope", { status: 503 });
      return realFetchLocal(url, init);
    };
    let outcome;
    try {
      outcome = await run(argv, { statusOptions: noWait });
    } finally {
      console.error = realError;
    }
    assert.equal(outcome.published, false);
    assert.equal(outcome.failed, true);
    const joined = errors.join("\n");
    assert.match(joined, /::error title=review-evidence status NOT published::/);
    assert.match(joined, new RegExp(HEAD));
    assert.match(joined, /STILL STANDS/);
    assert.match(joined, /Do not merge/);
  });

  it("refuses to publish against anything that is not a commit SHA", async () => {
    await assert.rejects(
      postStatus("o/r", "not-a-sha", { ok: true, summary: "ok" }, undefined, noWait),
      /not a commit SHA/
    );
  });
});

/**
 * Every entry here is a way the gate can be satisfied that it deliberately does NOT stop.
 *
 * These run through the REAL gathering path with the identities and timestamps that a regression
 * would have to consult, so each one fails if the accepted behaviour changes. An earlier version
 * of this block called the pure evaluator with synthetic input and would have passed no matter
 * what the gate did — which is worse than no test, because it gets cited as evidence.
 */
describe("review evidence — accepted under the stated threat model", () => {
  const realFetch = globalThis.fetch;
  let gh;

  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    gh = stubGitHub();
  });
  after(() => {
    globalThis.fetch = realFetch;
  });

  const verdictFor = async ({ author, comment }) => {
    gh.routes.set(
      "GET /repos/o/r/pulls/7",
      json({ head: { sha: HEAD }, user: { login: author }, labels: [] })
    );
    gh.routes.set("GET /repos/o/r/issues/7/comments", json([comment]));
    gh.routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    gh.routes.set(
      `GET /repos/o/r/collaborators/${encodeURIComponent(comment.user.login)}/permission`,
      json({ permission: "write" })
    );
    const head = await resolvePullRequestHead("o/r", "7");
    return evaluateReviewEvidence(await gatherPullRequestFacts("o/r", "7", head));
  };

  it("ACCEPTED: the PR author can attest to their own PR", async () => {
    // The PR payload names `author` as the opener and the attestation is authored by the same
    // login, so this goes red the moment anyone introduces an author/attester comparison.
    const verdict = await verdictFor({
      author: "author",
      comment: {
        html_url: "c1",
        user: { login: "author" },
        body: attestation(),
        created_at: "2026-08-04T12:00:00Z",
        updated_at: "2026-08-04T12:00:00Z",
      },
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.evidence.author, "author");
  });

  it("ACCEPTED: an attestation edited long after it was posted still counts", async () => {
    // `updated_at` is hours after `created_at`; GitHub exposes the edit and the gate ignores it.
    const verdict = await verdictFor({
      author: "author",
      comment: {
        html_url: "c1",
        user: { login: "reviewer" },
        body: attestation(),
        created_at: "2026-08-04T09:00:00Z",
        updated_at: "2026-08-04T17:30:00Z",
      },
    });
    assert.equal(verdict.ok, true);
  });

  it("ACCEPTED: the head SHA may arrive inside a commit URL", async () => {
    const verdict = await verdictFor({
      author: "author",
      comment: {
        html_url: "c1",
        user: { login: "reviewer" },
        body: attestation().replace(
          `- Reviewed at ${HEAD}`,
          `- https://github.com/o/r/commit/${HEAD}`
        ),
        created_at: "2026-08-04T12:00:00Z",
        updated_at: "2026-08-04T12:00:00Z",
      },
    });
    assert.equal(verdict.ok, true);
  });

  it("ACCEPTED: a write-authorized bot or machine user can attest", async () => {
    const verdict = await verdictFor({
      author: "author",
      comment: {
        html_url: "c1",
        user: { login: "some-bot[bot]", type: "Bot" },
        body: attestation(),
        created_at: "2026-08-04T12:00:00Z",
        updated_at: "2026-08-04T12:00:00Z",
      },
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.evidence.author, "some-bot[bot]");
  });

  // The missing row. The protected context is an ordinary COMMIT STATUS, so anything holding a
  // token with `statuses: write` can publish it directly and skip the workflow entirely. The
  // observable property in our code is the endpoint we publish through: switching to a check run
  // (`POST /repos/:o/:r/check-runs`, which is app-scoped and not writable this way) is exactly the
  // change that would close this hole, and it would fail here.
  it("ACCEPTED: the verdict is a commit status, so any statuses:write token can forge it", async () => {
    gh.routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD } }));
    gh.routes.set("GET /repos/o/r/issues/7/comments", json([]));
    gh.routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    await run(["--repo", "o/r", "--pr", "7"], {
      statusOptions: { attempts: 1, backoffMs: 0, sleep: async () => {} },
    });
    assert.equal(gh.posted.length, 1);
    assert.equal(
      gh.posted[0].pathname,
      `/repos/o/r/statuses/${HEAD}`,
      "the verdict must go to the commit-status endpoint; a check run would not be forgeable this way"
    );
    assert.equal(gh.posted[0].body.context, STATUS_CONTEXT);
    assert.ok(
      !gh.calls.some((call) => call.key.includes("/check-runs")),
      "no check run is created, so nothing app-scoped guards the context"
    );
  });

  it("NOT accepted: quoting an attestation does not attest", async () => {
    const verdict = await verdictFor({
      author: "author",
      comment: {
        html_url: "c1",
        user: { login: "reviewer" },
        body: attestation()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
        created_at: "2026-08-04T12:00:00Z",
        updated_at: "2026-08-04T12:00:00Z",
      },
    });
    assert.equal(verdict.ok, false);
  });
});
