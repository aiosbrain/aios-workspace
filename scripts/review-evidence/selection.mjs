/**
 * review-evidence/selection.mjs — per-PR selection: which comment, if any, speaks for this head.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two PRs (#533, #546) merged while their adversarial review was still running. Both
 * reviews came back BLOCKED with High findings that were then live on `main`. The failure
 * mode is not "nobody reviewed it" — it is **evidence outliving the commit it described**.
 * So the unit of evidence here is not "a review happened"; it is "a review names THIS
 * 40-character head SHA". A push makes every prior attestation stale by construction, and
 * the gate goes red until the new head is re-attested.
 *
 *
 * THREAT MODEL — read this before assuming the gate protects something it does not
 * ---------------------------------------------------------------------------------
 * This gate answers "has anything reviewed this exact commit?" — NOT "is that review
 * honest?". Every actor with write access to the repository is trusted. The failure it
 * prevents is a merge racing a review that is still running; that is what happened twice,
 * and in neither case did anyone fake anything — nothing checked.
 *
 * That is a deliberate scope call, not an oversight. All the code here is AI-generated and
 * the reviewer, the attester and the merger are the same account by design: reviews are
 * posted under the maintainer's account by an agent running the harness locally. A gate
 * demanding an independent human reviewer would break the workflow on day one and still
 * would not stop a determined forger.
 *
 * So the following all satisfy the gate, ACCEPTED AND DOCUMENTED rather than missed:
 *
 *   - The PR author can attest to their own PR. There is no author/attester comparison
 *     anywhere in this file, on purpose.
 *   - A head SHA reaches the Verification section by any route that renders — a commit URL,
 *     a quotation inside the section, a comment edited long after it was posted. GitHub
 *     exposes no "was this edited" signal that the gate consults.
 *   - Anything holding a token with `statuses: write` can POST the `review-evidence` status
 *     directly and skip the workflow entirely. The status is the protected context, so the
 *     workflow is a producer of it, not a guard on it.
 *   - A write-authorised bot or machine user can attest exactly like a human.
 *
 * Each of those is pinned by a test in test/review-evidence.test.mjs ("accepted under the
 * stated threat model") so the acceptance stays a recorded decision with an expected value.
 * What the gate DOES guarantee is narrow and worth having: no commit merges unless something
 * with write access put its name against that 40-character SHA, after the SHA existed.
 *
 */
import {
  SHA_PATTERN,
  normalizeForScan,
  validateCandidateShaBinding,
  validateReviewBody,
  visibleMarkdown,
} from "./body.mjs";

/** The token a review attestation must end with. */
export const EVIDENCE_MARKER = "MERGE_READY";

/** The token an exemption must end with. */
export const EXEMPTION_MARKER = "REVIEW_EXEMPT";

/** The status context the branch-protection rule must require. */
export const STATUS_CONTEXT = "review-evidence";

/**
 * A comment is a *candidate* when it carries the marker on a whole line of its own.
 * Deliberately cheap and non-throwing: the validators reject hostile markdown by throwing, and
 * we want those rejections reported as candidate failures rather than silently skipping the
 * comment (which would read as "nothing here" and hide the reason).
 */
function hasMarker(body, marker) {
  return typeof body === "string" && new RegExp(`^[ \\t]*${marker}[ \\t]*$`, "m").test(body);
}

export const isEvidenceCandidate = (body) => hasMarker(body, EVIDENCE_MARKER);
export const isExemptionCandidate = (body) => hasMarker(body, EXEMPTION_MARKER);

/**
 * An exemption says "this commit does not need an adversarial review", and it must name the
 * commit — the same binding evidence has, for the same reason.
 *
 * The first design made the exemption a LABEL and re-validated it against a clock: first by
 * deleting the label on push (which silently kept a stale exemption alive whenever that one API
 * call failed), then by requiring the `labeled` event to be newer than the head commit. Both were
 * wrong, and the second was wrong in a way worth recording: a commit's committer date is
 * arbitrary — it can be old, it can be in the future, and it never says *when this became the
 * head*. A label applied at 10:00 could exempt a head pushed at 12:00 that carried an older
 * committer date.
 *
 * A label cannot carry a SHA, so no amount of care makes a label-only exemption non-stale. Naming
 * the commit removes the question rather than answering it: an exemption either names the current
 * head or it does not. No clocks, no timeline ordering, no page-two event, no equal-timestamp
 * edge, no force-push confusion — and the gate's two paths become one idea instead of two:
 * SOMETHING ON THIS PR, POSTED BY SOMEONE WITH WRITE ACCESS, NAMES THIS EXACT COMMIT.
 *
 * Visibility is the vendored `visibleMarkdown`, so an exemption cannot hide in raw HTML, a link
 * reference definition, or an ambiguous fence any more than a review can; the SHA binding is the
 * vendored `validateCandidateShaBinding`, so the head must appear exactly once and no other
 * SHA-shaped token may ride along.
 */
// A bare list marker: `-`, `*`, `+`, `1.` or `1)`, with nothing after it that renders.
const LIST_MARKER = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]*/;

/**
 * Does this section render as nothing?
 *
 * `- ` is a non-empty string and an empty bullet, so `reason.trim()` said "there is a reason"
 * about a record that shows the reader nothing — the exemption looked filled in while stating
 * none. Under this gate's threat model that is an audit-trail defect rather than a bypass
 * (anyone with write access is already trusted to exempt, and could simply type a word), but a
 * record that can be blank while looking complete is exactly the kind of thing this gate exists
 * to not do.
 *
 * `normalizeForScan` is the vendored normalisation the severity scan already uses — it decodes
 * entities, strips zero-width and other format characters, applies NFKC and removes emphasis
 * marks. Reusing it keeps ONE notion of "invisible" in this codebase rather than inventing a
 * second one here. After that and the list marker, a line has to carry at least one letter or
 * digit in any script; punctuation alone is not a reason, and CJK is.
 */
function rendersEmpty(section) {
  return !section
    .split("\n")
    .some((line) => /[\p{L}\p{N}]/u.test(normalizeForScan(line).replace(LIST_MARKER, "")));
}

export function validateExemptionBody(body, candidateShas) {
  if (typeof body !== "string") throw new Error("exemption comment has no body");
  const visible = visibleMarkdown(body);
  if (!new RegExp(`(?:^|\\n)${EXEMPTION_MARKER}\\s*$`).test(visible)) {
    throw new Error(`exemption does not end with the verified ${EXEMPTION_MARKER} token`);
  }
  const headings = [...visible.matchAll(/^##\s+(.+?)\s*$/gm)];
  const expected = ["Exemption", "Verification"];
  if (headings.length !== expected.length || headings.some((m, i) => m[1] !== expected[i])) {
    throw new Error(
      "exemption must contain only the Exemption and Verification sections, exactly once and in order"
    );
  }
  const reason = visible.slice(headings[0].index + headings[0][0].length, headings[1].index);
  if (rendersEmpty(reason)) throw new Error("exemption section Exemption must not be empty");
  validateCandidateShaBinding(
    visible.slice(headings[1].index + headings[1][0].length),
    candidateShas
  );
}

/**
 * Decide whether a PR at `headSha` has something current standing behind it.
 *
 * Pure and synchronous on purpose: every network fact (the head SHA, comment bodies, whether each
 * author has write access) is resolved by the caller, so the decision itself is fully testable
 * without a network.
 *
 * FAIL CLOSED. Every path that cannot answer "yes, something current names this commit" either
 * throws or returns `ok: false`. There is no branch that returns `ok: true` on missing input.
 *
 * @param {object} input
 * @param {string} input.headSha  40-char lowercase head SHA of the PR.
 * @param {Array<{url:string,author:string,authorized:boolean,body:string}>} input.comments
 * @returns {{ok:boolean, kind:string, summary:string, rejected:Array<object>}}
 */
export function evaluateReviewEvidence({ headSha, comments }) {
  if (!SHA_PATTERN.test(headSha ?? "")) {
    throw new Error("head SHA must be a lowercase 40-character commit SHA");
  }
  if (!Array.isArray(comments)) {
    throw new Error("PR comment list could not be read");
  }
  const rejected = [];
  for (const comment of comments) {
    const evidence = isEvidenceCandidate(comment.body);
    const exemption = isExemptionCandidate(comment.body);
    if (!evidence && !exemption) continue;
    // An unauthorized author is reported, never skipped: "a stranger posted a green
    // attestation" is something a reviewer must see, not something the gate swallows.
    if (!comment.authorized) {
      rejected.push({
        url: comment.url,
        author: comment.author,
        reason: "author does not have write access to this repository",
      });
      continue;
    }
    try {
      if (evidence && exemption) {
        throw new Error(`a comment may not carry both ${EVIDENCE_MARKER} and ${EXEMPTION_MARKER}`);
      }
      if (evidence) validateReviewBody(comment.body, [headSha]);
      else validateExemptionBody(comment.body, [headSha]);
      return {
        ok: true,
        kind: evidence ? "evidence" : "exempt",
        summary: evidence
          ? `Reviewed at ${headSha.slice(0, 7)} by @${comment.author}`
          : `Exempt at ${headSha.slice(0, 7)} by @${comment.author}`,
        evidence: { url: comment.url, author: comment.author },
        rejected,
      };
    } catch (error) {
      rejected.push({ url: comment.url, author: comment.author, reason: error.message });
    }
  }
  return {
    ok: false,
    kind: rejected.length ? "invalid" : "missing",
    summary: rejected.length
      ? `No valid evidence for ${headSha.slice(0, 7)} (${rejected.length} rejected)`
      : `Nothing on this PR names head ${headSha.slice(0, 7)}`,
    rejected,
  };
}
