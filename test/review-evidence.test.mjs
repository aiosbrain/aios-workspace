import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import {
  EXEMPTION_LABEL,
  STATUS_CONTEXT,
  evaluateReviewEvidence,
  isEvidenceCandidate,
  validateReviewBody,
} from "../scripts/review-evidence.mjs";
import {
  PARITY_CORPUS,
  decisions,
  disagreements,
} from "../scripts/check-review-evidence-parity.mjs";
import {
  forLog,
  gatherPullRequestFacts,
  parseArgs,
  renderReport,
} from "../scripts/validate-pr-review-evidence.mjs";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const STALE = "76543210fedcba9876543210fedcba9876543210";

function attestation(sha = HEAD, findings = "- no reportable findings") {
  return [
    "## Findings",
    findings,
    "## Mergeability",
    "- Ready to merge",
    "## Open Questions",
    "- none",
    "## Verification",
    `- Reviewed at ${sha}`,
    "",
    "MERGE_READY",
  ].join("\n");
}

const authored = (body, overrides = {}) => ({
  url: "https://github.com/o/r/pull/1#issuecomment-1",
  author: "reviewer",
  authorized: true,
  body,
  ...overrides,
});

describe("review evidence — candidate detection", () => {
  it("treats a whole-line MERGE_READY as a candidate", () => {
    assert.equal(isEvidenceCandidate(attestation()), true);
    assert.equal(isEvidenceCandidate("  MERGE_READY  \ntrailing"), true);
  });

  it("ignores prose that merely mentions the token", () => {
    assert.equal(isEvidenceCandidate("we should add a MERGE_READY token one day"), false);
    assert.equal(isEvidenceCandidate(undefined), false);
    assert.equal(isEvidenceCandidate(null), false);
  });
});

describe("review evidence — the decision", () => {
  it("passes when an authorized reviewer names the current head", () => {
    const verdict = evaluateReviewEvidence({ headSha: HEAD, comments: [authored(attestation())] });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.kind, "evidence");
    assert.match(verdict.summary, /Reviewed at 0123456 by @reviewer/);
  });

  it("goes red when evidence names a STALE sha — the incident this gate exists for", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [authored(attestation(STALE))],
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "invalid");
    assert.equal(verdict.rejected.length, 1);
    assert.match(verdict.rejected[0].reason, /candidate SHA exactly once/);
  });

  it("goes red when there is no evidence at all", () => {
    const verdict = evaluateReviewEvidence({ headSha: HEAD, comments: [authored("lgtm 👍")] });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.kind, "missing");
    assert.deepEqual(verdict.rejected, []);
  });

  it("reports — never silently skips — an attestation from someone without write access", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [authored(attestation(), { authorized: false, author: "drive-by" })],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.rejected[0].reason, /write access/);
  });

  it("rejects a High finding even when the sha is current", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [authored(attestation(HEAD, "- High: auth bypass on the admin route."))],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.rejected[0].reason, /Critical or High/);
  });

  it("accepts the first valid attestation and still reports the ones before it", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [authored(attestation(STALE)), authored(attestation())],
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.rejected.length, 1);
  });

  it("honours an attributed exemption label", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [],
      exemption: { label: EXEMPTION_LABEL, actor: "maintainer" },
    });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.kind, "exempt");
    assert.match(verdict.summary, /applied by @maintainer/);
  });

  it("refuses an exemption nobody can be named for", () => {
    assert.throws(
      () =>
        evaluateReviewEvidence({
          headSha: HEAD,
          comments: [],
          exemption: { label: EXEMPTION_LABEL, actor: "" },
        }),
      /not attributable/
    );
  });

  it("fails closed on inputs it cannot judge", () => {
    assert.throws(() => evaluateReviewEvidence({ headSha: "abc", comments: [] }), /40-character/);
    assert.throws(
      () => evaluateReviewEvidence({ headSha: HEAD.toUpperCase(), comments: [] }),
      /40-character/
    );
    assert.throws(
      () => evaluateReviewEvidence({ headSha: HEAD, comments: null }),
      /could not be read/
    );
    assert.throws(
      () => evaluateReviewEvidence({ headSha: HEAD, comments: undefined }),
      /could not be read/
    );
  });
});

describe("review evidence — vendored validator corpus", () => {
  it("agrees with every recorded corpus verdict", () => {
    const ours = decisions(validateReviewBody);
    assert.deepEqual(
      PARITY_CORPUS.filter((entry, index) => ours[index] !== entry.valid).map((e) => e.name),
      []
    );
  });

  it("reports drift when the two implementations disagree", () => {
    const ours = decisions(validateReviewBody);
    const broken = ours.map((value, index) => (index === 0 ? !value : value));
    assert.deepEqual(disagreements(ours, broken), [PARITY_CORPUS[0].name]);
  });
});

describe("review evidence — CLI surface", () => {
  it("parses flags and values", () => {
    const args = parseArgs(["--repo", "o/r", "--pr", "7", "--no-status", "--target-url", "u"]);
    assert.deepEqual(args, { repo: "o/r", pr: "7", "no-status": true, "target-url": "u" });
  });

  it("rejects malformed invocations rather than guessing", () => {
    assert.throws(() => parseArgs(["--repo", "o/r"]), /--pr is required/);
    assert.throws(() => parseArgs(["--repo", "not-a-repo", "--pr", "1"]), /owner\/name/);
    assert.throws(() => parseArgs(["--repo", "o/r", "--pr", "x"]), /--pr must be a number/);
    assert.throws(() => parseArgs(["--repo", "--pr", "1"]), /--repo requires a value/);
    assert.throws(() => parseArgs(["repo"]), /unexpected argument/);
  });

  it("refuses a repo name that could re-point the API path somewhere else", () => {
    for (const repo of ["../..", "o/..", "./r", "o/r?x=1", "o/r#f", "o/r/extra", "o/r%2e%2e"]) {
      assert.throws(() => parseArgs(["--repo", repo, "--pr", "1"]), /owner\/name/, repo);
    }
    assert.doesNotThrow(() => parseArgs(["--repo", "aiosbrain/aios-workspace", "--pr", "1"]));
    assert.doesNotThrow(() => parseArgs(["--repo", "a-b.c_d/e.f-g_h", "--pr", "1"]));
  });

  it("prints the attestation template, bound to the head, when it fails", () => {
    const report = renderReport(
      { ok: false, kind: "missing", summary: "nope", rejected: [] },
      { repo: "o/r", number: "7", headSha: HEAD }
    );
    assert.match(report, /Review evidence — FAIL/);
    assert.match(report, new RegExp(`- Reviewed at ${HEAD}`));
    assert.match(report, new RegExp(EXEMPTION_LABEL));
  });

  it("cannot be made to forge a workflow command from data it does not control", () => {
    assert.equal(forLog("a\n::add-mask::secret"), "a : :add-mask: :secret");
    assert.equal(forLog("a\r\nb"), "a b");
    assert.equal(forLog(undefined), "");
    assert.equal(forLog("x".repeat(900)).length, 500);
    const report = renderReport(
      {
        ok: false,
        kind: "error",
        summary: "boom",
        rejected: [{ url: "u\n::error::forged", author: "a", reason: "r" }],
      },
      { repo: "o/r", number: "7", headSha: HEAD }
    );
    assert.doesNotMatch(report, /^::error::/m);
  });

  it("lists rejected candidates so the reason is visible on the PR", () => {
    const report = renderReport(
      {
        ok: false,
        kind: "invalid",
        summary: "nope",
        rejected: [{ url: "u", author: "a", reason: "stale" }],
      },
      { repo: "o/r", number: "7", headSha: HEAD }
    );
    assert.match(report, /u \(@a\): stale/);
  });

  it("says PASS without the template when it passes", () => {
    const report = renderReport(
      { ok: true, kind: "evidence", summary: "ok", rejected: [] },
      { repo: "o/r", number: "7", headSha: HEAD }
    );
    assert.match(report, /Review evidence — PASS/);
    assert.doesNotMatch(report, /MERGE_READY/);
  });
});

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
      calls.push(`${method} ${pathname}`);
      const handler = routes.get(`${method} ${pathname}`);
      if (!handler) return new Response("not found", { status: 404 });
      return handler();
    };
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  const json = (value) => () => new Response(JSON.stringify(value), { status: 200 });

  it("resolves the head, the comments, and each author's write access", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, labels: [] }));
    routes.set(
      "GET /repos/o/r/issues/7/comments",
      json([{ html_url: "c1", user: { login: "reviewer" }, body: attestation() }])
    );
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    routes.set("GET /repos/o/r/collaborators/reviewer/permission", json({ permission: "write" }));

    const facts = await gatherPullRequestFacts("o/r", "7");
    assert.equal(facts.headSha, HEAD);
    assert.equal(facts.exemption, null);
    assert.deepEqual(
      facts.comments.map((c) => [c.author, c.authorized]),
      [["reviewer", true]]
    );
    assert.equal(evaluateReviewEvidence(facts).ok, true);
  });

  it("treats a 404 on the permission lookup as 'not a collaborator', not as an outage", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, labels: [] }));
    routes.set(
      "GET /repos/o/r/issues/7/comments",
      json([{ html_url: "c1", user: { login: "stranger" }, body: attestation() }])
    );
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    // No permission route → 404.
    const facts = await gatherPullRequestFacts("o/r", "7");
    assert.equal(facts.comments[0].authorized, false);
    assert.equal(evaluateReviewEvidence(facts).ok, false);
  });

  it("propagates a non-404 permission failure instead of implying 'no access'", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, labels: [] }));
    routes.set(
      "GET /repos/o/r/issues/7/comments",
      json([{ html_url: "c1", user: { login: "reviewer" }, body: attestation() }])
    );
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    routes.set(
      "GET /repos/o/r/collaborators/reviewer/permission",
      () => new Response("boom", { status: 500 })
    );
    await assert.rejects(gatherPullRequestFacts("o/r", "7"), /HTTP 500/);
  });

  it("attributes the exemption label from the timeline", async () => {
    routes.set(
      "GET /repos/o/r/pulls/7",
      json({ head: { sha: HEAD }, labels: [{ name: EXEMPTION_LABEL }] })
    );
    routes.set(
      "GET /repos/o/r/issues/7/timeline",
      json([
        { event: "labeled", label: { name: "other" }, actor: { login: "nobody" } },
        { event: "labeled", label: { name: EXEMPTION_LABEL }, actor: { login: "maintainer" } },
      ])
    );
    const facts = await gatherPullRequestFacts("o/r", "7");
    assert.deepEqual(facts.exemption, { label: EXEMPTION_LABEL, actor: "maintainer" });
    assert.deepEqual(facts.comments, []);
  });

  it("fails closed when the exemption label has no attributable event", async () => {
    routes.set(
      "GET /repos/o/r/pulls/7",
      json({ head: { sha: HEAD }, labels: [{ name: EXEMPTION_LABEL }] })
    );
    routes.set("GET /repos/o/r/issues/7/timeline", json([]));
    await assert.rejects(gatherPullRequestFacts("o/r", "7"), /no 'labeled' event attributes it/);
  });

  it("clears the exemption on a push, so an exemption cannot outlive its commit either", async () => {
    routes.set(
      "GET /repos/o/r/pulls/7",
      json({ head: { sha: HEAD }, labels: [{ name: EXEMPTION_LABEL }] })
    );
    routes.set(
      `DELETE /repos/o/r/issues/7/labels/${EXEMPTION_LABEL}`,
      () => new Response(null, { status: 204 })
    );
    routes.set("GET /repos/o/r/issues/7/comments", json([]));
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));

    const facts = await gatherPullRequestFacts("o/r", "7", { clearExemptionOnPush: true });
    assert.ok(calls.includes(`DELETE /repos/o/r/issues/7/labels/${EXEMPTION_LABEL}`));
    assert.equal(facts.exemption, null);
    assert.equal(evaluateReviewEvidence(facts).ok, false);
  });

  it("fails closed when the head SHA cannot be read", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ labels: [] }));
    await assert.rejects(gatherPullRequestFacts("o/r", "7"), /head SHA is unavailable/);
  });

  it("refuses to judge a comment list it could only read part of", async () => {
    routes.set("GET /repos/o/r/pulls/7", json({ head: { sha: HEAD }, labels: [] }));
    const page = Array.from({ length: 100 }, (_, i) => ({
      html_url: `c${i}`,
      user: { login: "reviewer" },
      body: "noise",
    }));
    routes.set("GET /repos/o/r/issues/7/comments", json(page));
    routes.set("GET /repos/o/r/pulls/7/reviews", json([]));
    await assert.rejects(gatherPullRequestFacts("o/r", "7"), /refusing to judge a truncated list/);
  });

  it("refuses to run without a token", async () => {
    delete process.env.GH_TOKEN;
    await assert.rejects(gatherPullRequestFacts("o/r", "7"), /GH_TOKEN is not set/);
  });
});

describe("review evidence — published contract", () => {
  it("pins the names the branch rule and the label depend on", () => {
    assert.equal(STATUS_CONTEXT, "review-evidence");
    assert.equal(EXEMPTION_LABEL, "review-evidence-exempt");
  });
});
