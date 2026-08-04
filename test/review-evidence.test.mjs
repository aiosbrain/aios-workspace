import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXEMPTION_MARKER,
  STATUS_CONTEXT,
  evaluateReviewEvidence,
  isEvidenceCandidate,
  isExemptionCandidate,
  validateExemptionBody,
  validateReviewBody,
} from "../scripts/review-evidence.mjs";
import { HEAD, STALE, attestation, exemption } from "./review-evidence-fixtures.mjs";
import {
  PARITY_CORPUS,
  decisions,
  disagreements,
} from "../scripts/check-review-evidence-parity.mjs";
import { forLog, parseArgs, renderReport } from "../scripts/validate-pr-review-evidence.mjs";

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

  it("recognises an exemption by its own marker", () => {
    assert.equal(isExemptionCandidate(exemption()), true);
    assert.equal(isExemptionCandidate(attestation()), false);
    assert.equal(isEvidenceCandidate(exemption()), false);
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

  it("honours an exemption comment that names the current head", () => {
    const verdict = evaluateReviewEvidence({ headSha: HEAD, comments: [authored(exemption())] });
    assert.equal(verdict.ok, true);
    assert.equal(verdict.kind, "exempt");
    assert.match(verdict.summary, /Exempt at 0123456 by @reviewer/);
  });

  // The whole point of the redesign: an exemption cannot be stale, because it either names the
  // current head or it does not. No clock is consulted anywhere on this path.
  it("refuses an exemption that names an older commit", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [authored(exemption(STALE))],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.rejected[0].reason, /candidate SHA exactly once/);
  });

  it("refuses an exemption from someone without write access", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [authored(exemption(), { authorized: false, author: "drive-by" })],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.rejected[0].reason, /write access/);
  });

  it("refuses an exemption with no stated reason", () => {
    const verdict = evaluateReviewEvidence({
      headSha: HEAD,
      comments: [authored(exemption(HEAD, ""))],
    });
    assert.equal(verdict.ok, false);
    assert.match(verdict.rejected[0].reason, /Exemption must not be empty/);
  });

  it("refuses a comment claiming to be both a review and an exemption", () => {
    const hybrid = `${attestation()}\n\n${EXEMPTION_MARKER}`;
    const verdict = evaluateReviewEvidence({ headSha: HEAD, comments: [authored(hybrid)] });
    assert.equal(verdict.ok, false);
    assert.match(verdict.rejected[0].reason, /may not carry both/);
  });

  it("applies the vendored visibility rules to exemptions too", () => {
    const hidden = exemption().replace(
      "- dependabot lockfile bump, no source change",
      "- <details>x</details>"
    );
    assert.throws(() => validateExemptionBody(hidden, [HEAD]), /raw HTML/);
    const linkRef = exemption().replace(
      `- Exempt at ${HEAD}`,
      `- Exempt at ${HEAD}\n[ref]: https://example.invalid`
    );
    assert.throws(() => validateExemptionBody(linkRef, [HEAD]), /link reference definition/);
  });

  it("refuses an exemption that never declares itself", () => {
    assert.throws(
      () => validateExemptionBody(exemption().replace("\nREVIEW_EXEMPT", ""), [HEAD]),
      /REVIEW_EXEMPT token/
    );
    assert.throws(() => validateExemptionBody(undefined, [HEAD]), /has no body/);
    assert.throws(
      () => validateExemptionBody(`## Verification\n- Exempt at ${HEAD}\n\nREVIEW_EXEMPT`, [HEAD]),
      /exactly once and in order/
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
    assert.match(report, new RegExp(EXEMPTION_MARKER));
    assert.match(report, new RegExp(`- Exempt at ${HEAD}`));
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

describe("review evidence — published contract", () => {
  it("pins the names the branch rule and the label depend on", () => {
    assert.equal(STATUS_CONTEXT, "review-evidence");
    assert.equal(EXEMPTION_MARKER, "REVIEW_EXEMPT");
  });
});
