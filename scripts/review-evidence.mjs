/**
 * review-evidence.mjs — per-PR review-evidence semantics (AIO-777).
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
 * PROVENANCE — this is a deliberate vendored copy, not a fresh implementation
 * --------------------------------------------------------------------------
 * The body-validation half of this file (everything from `SHA_PATTERN` down to
 * `htmlCommentCloseEnd`) is copied VERBATIM from the release gate's validator:
 *
 *   repo:   github.com/johnellison/aios   (the AIOS hub / release coordinator)
 *   file:   scripts/validate-adversarial-review.mjs
 *   commit: ad2f9fcb676305547c1981ba32e65af93e21cec9
 *
 * Only the release-specific half was dropped: the comment-URL parser, the
 * review-independence mode/SemVer coupling, the dual-agent artifact digest checks, and the
 * `main()` that takes four release-candidate SHAs. None of that has meaning for one PR.
 * Everything that decides whether a review body is *honest and current* — the four required
 * sections, the MERGE_READY token, the fail-closed severity scan (including the
 * BENIGN_SEVERITY_COMPOUNDS allowlist that exists because suppressing on mere hyphen
 * adjacency was a fail-open), the entity/zero-width/emphasis normalisation, the
 * visible-markdown model, and the exact SHA binding — is a line-for-line copy of the hub (reflowed only by this repo's Prettier config).
 *
 * The route was chosen over checking the hub out inside the workflow: a required check must
 * not be able to go permanently red because another repo moved, was renamed, or rotated the
 * token that reads it.
 *
 * `npm run check:review-evidence-parity` is a USEFUL SPOT CHECK, not a mitigation, and should
 * not be described as one. CI never compares the two repos; the run needs a hub checkout that
 * may not exist on the machine; and a 17-case corpus cannot detect a defect the two copies
 * SHARE — the copies agreed on exactly the severity behaviour that adversarial probes later
 * defeated. It catches one copy being edited and the other not. It cannot tell you the
 * semantics are right. The real answer to drift is the convergence plan: move the shared
 * surface into `@aiosbrain/foundation` and have the hub consume it, at which point this copy
 * is deleted. See docs/pr-review-evidence.md.
 */

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA_TOKEN_PATTERN = /(?<![0-9A-Za-z_])[0-9a-f]{40}(?![0-9A-Za-z_])/g;
const REQUIRED_SECTIONS = ["Findings", "Mergeability", "Open Questions", "Verification"];

// A severity word inside a hyphenated compound is exempt ONLY when the whole compound is
// a known piece of ordinary prose. Suppressing on mere hyphen adjacency was a fail-open:
// `- High-severity: auth bypass` is the most idiomatic way to write a real blocker, and
// `sev-Critical` / `P1-Critical` / `Critical-blocker` are ordinary label formats. Unknown
// hyphen compounds containing a severity word block, by default.
const BENIGN_SEVERITY_COMPOUNDS = new Set([
  "high-level",
  "high-quality",
  "high-water",
  "high-confidence",
  "higher-level",
  "medium-sized",
  "medium-term",
  "non-critical",
  "sub-critical",
  "mission-critical",
  "business-critical",
  // Technical qualifiers whose second element is not a severity/impact word. These are
  // ordinary review prose and cannot be read as a finding label.
  "high-throughput",
  "high-cardinality",
  "high-order",
  "high-availability",
  "medium-complexity",
]);

// Directly negated compounds are statements that a class of problem is ABSENT — the
// opposite of a finding. `- No high-severity issues found.` is the single most likely
// sentence in a clean security review and must not force the reviewer to reword until the
// gate goes green. The exemption is deliberately tiny: it applies ONLY to hyphenated
// compounds (a bare `- No High finding has been resolved; the leak remains.` still
// blocks), ONLY when the negation is adjacent to the compound (see isNegatedCompound),
// and it is withdrawn entirely when the line carries an adversative, so
// `- No issues except a High-severity auth bypass.` blocks.
const ADVERSATIVE_PATTERN =
  /\b(?:except|but|however|aside from|other than|apart from|besides|although|though)\b/i;
const BLOCKER_SEVERITY_PATTERN = /(?<![0-9A-Za-z_])(?:Critical|High)(?![0-9A-Za-z_])/gi;
const MEDIUM_SEVERITY_PATTERN = /(?<![0-9A-Za-z_])Medium(?![0-9A-Za-z_])/gi;
const CONTRADICTION_PATTERNS = [
  /\b(?:not ready to merge|do not merge|merge blocked|blocked from merge|not mergeable|changes requested|no-go|conditionally ready to merge|ready to merge if|remains blocked|blocked pending)\b/i,
  /(?:^|\n)\s*[-*]\s+(?:blocked|failed)\b/im,
  /(?:^|\n)\s*[-*]?\s*(?:blocked|fail(?:ed)?)\s*[.!]?\s*$/im,
];

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["hyphen", "-"],
  ["ndash", "-"],
  ["mdash", "-"],
  ["num", "#"],
]);

// Severity words may be entity-encoded (`&#67;ritical`) or emphasis-split
// (`Crit*ical*`) and still render as the plain word on GitHub. Normalising before the
// scan removes both obfuscations; it can only create matches, never suppress them.
export function decodeHtmlEntities(text) {
  return text.replace(
    /&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (match, token) => {
      if (token.startsWith("#")) {
        const code = /^#[xX]/.test(token)
          ? Number.parseInt(token.slice(2), 16)
          : Number.parseInt(token.slice(1), 10);
        if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff) return match;
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return NAMED_ENTITIES.get(token.toLowerCase()) ?? match;
    }
  );
}

// Zero-width and other format characters are invisible on GitHub, so `Crit<U+200B>ical`
// reads as a declared Critical finding to a human while a raw scan sees nothing.
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u2060\uFEFF]|\p{Cf}/gu;

export function normalizeForScan(text) {
  return decodeHtmlEntities(text)
    .replace(INVISIBLE_CHARACTERS, "")
    .normalize("NFKC")
    .replace(/[*_`~\\]+/g, "");
}

// Returns true when `text` contains a severity word that is neither part of an
// allowlisted benign compound nor a negated compound. The whole hyphen-joined compound
// around each hit is resolved first, so `non-critical` and `- No high-severity issues
// found.` pass while `sev-Critical`, `High-severity:` and `Critical-path` block.
export function hasGovernedSeverity(text, pattern) {
  for (const match of text.matchAll(pattern)) {
    const { compound, start } = hyphenCompoundAt(text, match.index, match[0].length);
    if (BENIGN_SEVERITY_COMPOUNDS.has(compound)) continue;
    if (isNegatedCompound(text, compound, start)) continue;
    return true;
  }
  return false;
}

// The negation must be ADJACENT to the compound — at most one intervening word, and no
// clause-boundary punctuation between them. English negation scope is not lexical order:
// `- Not resolved: High-severity auth bypass.` and `- Not yet triaged: Medium-severity
// data leak.` both carry a negation earlier on the line, but it negates the *status*, not
// the finding — those sentences mean the blocker is still open. Testing the whole prefix
// exempted exactly the still-open statuses the gate exists to catch. `index` is the start
// of the whole hyphen compound, so `- Nothing safety-critical was touched.` stays exempt.
function isNegatedCompound(text, compound, index) {
  if (!compound.includes("-")) return false;
  if (ADVERSATIVE_PATTERN.test(text)) return false;
  return /\b(?:no|zero|none|nothing|without|unchanged|not)\b(?:\s+[0-9A-Za-z]+)?\s*$/i.test(
    text.slice(0, index)
  );
}

// Returns the whole hyphen-joined compound around the severity hit, plus its start index.
function hyphenCompoundAt(text, index, length) {
  const isWordCharacter = (value) => value !== undefined && /[0-9A-Za-z]/.test(value);
  let start = index;
  while (text[start - 1] === "-" && isWordCharacter(text[start - 2])) {
    let cursor = start - 2;
    while (isWordCharacter(text[cursor - 1])) cursor -= 1;
    start = cursor;
  }
  let end = index + length;
  while (text[end] === "-" && isWordCharacter(text[end + 1])) {
    let cursor = end + 2;
    while (isWordCharacter(text[cursor])) cursor += 1;
    end = cursor;
  }
  return { compound: text.slice(start, end).toLowerCase(), start };
}

export function validateReviewBody(body, candidateShas) {
  if (typeof body !== "string") throw new Error("review comment has no body");
  const { sections, preamble, visibleBody } = parseReviewSections(body);
  if (!/(?:^|\n)MERGE_READY\s*$/.test(visibleBody)) {
    throw new Error("review does not end with the verified MERGE_READY token");
  }
  const governedText = [preamble, ...Object.values(sections)].join("\n");
  for (const raw of governedText.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const scanned = normalizeForScan(line);
    if (hasGovernedSeverity(scanned, BLOCKER_SEVERITY_PATTERN)) {
      throw new Error("review contains a Critical or High finding");
    }
    if (hasGovernedSeverity(scanned, MEDIUM_SEVERITY_PATTERN)) {
      const explicitlyResolved = /^[-*]\s+\[RESOLVED\]\s+/i.test(line);
      const contradictsResolution =
        /\b(?:not|unresolved|remains?|remaining|open|pending|still)\b/i.test(scanned);
      if (!explicitlyResolved || contradictsResolution) {
        throw new Error("review contains an unresolved Medium finding");
      }
    }
  }
  for (const variant of [decodeHtmlEntities(governedText), normalizeForScan(governedText)]) {
    if (CONTRADICTION_PATTERNS.some((pattern) => pattern.test(variant))) {
      throw new Error("review contains contradictory mergeability declarations");
    }
  }
  if (sections.Mergeability.trim() !== "- Ready to merge") {
    throw new Error("review does not declare Ready to merge");
  }
  validateCandidateShaBinding(sections.Verification, candidateShas);
}

// The Verification section must name the candidate SHA set EXACTLY: every candidate
// once, nothing else, order-insensitive. Presence-only matching let one token satisfy
// two identical candidates and let extra/negated SHAs ride along unnoticed.
function validateCandidateShaBinding(verification, candidateShas) {
  const candidates = [...candidateShas];
  if (candidates.some((sha) => !SHA_PATTERN.test(sha ?? ""))) {
    throw new Error("every immutable candidate SHA must be a lowercase 40-character commit SHA");
  }
  const expected = new Set(candidates);
  if (expected.size !== candidates.length) {
    throw new Error("immutable candidate SHAs must be distinct");
  }
  const observed = [...verification.matchAll(SHA_TOKEN_PATTERN)].map((match) => match[0]);
  if (
    observed.length !== candidates.length ||
    new Set(observed).size !== observed.length ||
    observed.some((sha) => !expected.has(sha))
  ) {
    throw new Error("review does not identify every immutable candidate SHA exactly once");
  }
}

function parseReviewSections(body) {
  const visibleBody = visibleMarkdown(body);
  const headings = [...visibleBody.matchAll(/^##\s+(.+?)\s*$/gm)];
  if (
    headings.length !== REQUIRED_SECTIONS.length ||
    headings.some((match, index) => match[1] !== REQUIRED_SECTIONS[index])
  ) {
    throw new Error(
      "review must contain only the four required sections, exactly once and in order"
    );
  }
  const sections = Object.fromEntries(
    headings.map((match) => {
      const next = headings.find((heading) => heading.index > match.index);
      const start = match.index + match[0].length;
      return [match[1], visibleBody.slice(start, next?.index ?? visibleBody.length)];
    })
  );
  for (const name of REQUIRED_SECTIONS) {
    if (!sections[name].trim()) {
      throw new Error(`review section ${name} must not be empty`);
    }
  }
  return { preamble: visibleBody.slice(0, headings[0].index), sections, visibleBody };
}

// Blanks only what GitHub genuinely hides: fenced code and whole-line HTML comments.
// Everything a reader can see stays governed. Constructs whose rendering is ambiguous,
// and raw HTML of any kind (which GitHub may drop entirely), are rejected rather than
// guessed at, so the validator can never see an approval the human cannot.
function visibleMarkdown(body) {
  const visible = [];
  let fence;
  let htmlComment = false;
  let lineNumber = 0;
  for (const line of body.split("\n")) {
    lineNumber += 1;
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)[ \t]*\r?$/);
      if (close && close[1][0] === fence.character && close[1].length >= fence.length) {
        fence = undefined;
      }
      visible.push("");
      continue;
    }
    if (htmlComment) {
      const commentEnd = line.indexOf("-->");
      if (commentEnd !== -1) {
        if (line.slice(commentEnd + 3).trim()) {
          throw new Error(`review contains a mixed-line HTML comment on line ${lineNumber}`);
        }
        htmlComment = false;
      }
      visible.push("");
      continue;
    }
    const commentStart = line.indexOf("<!--");
    if (commentStart !== -1) {
      if (line.slice(0, commentStart).trim()) {
        throw new Error(`review contains a mixed-line HTML comment on line ${lineNumber}`);
      }
      const closeEnd = htmlCommentCloseEnd(line, commentStart);
      if (closeEnd === -1) htmlComment = true;
      else if (line.slice(closeEnd).trim()) {
        throw new Error(`review contains a mixed-line HTML comment on line ${lineNumber}`);
      }
      visible.push("");
      continue;
    }
    // CommonMark: a backtick fence's info string may not contain a backtick, so
    // ```` ```x`y ```` is a paragraph, not a fence. Refuse to pick an interpretation.
    // Tilde fences have no such restriction and may carry backticks in their info.
    const backtickOpener = line.match(/^ {0,3}(`{3,})(?!`)([^\r\n]*?)\r?$/);
    if (backtickOpener?.[2].includes("`")) {
      throw new Error(`review contains an ambiguous code fence opener on line ${lineNumber}`);
    }
    const opener = backtickOpener ?? line.match(/^ {0,3}(~{3,})(?!~)([^\r\n]*?)\r?$/);
    if (opener) {
      fence = { character: opener[1][0], length: opener[1].length };
      visible.push("");
      continue;
    }
    // Raw HTML (`<details>`, `<script>`, `<style>`, `<? ?>`, `<!DECL >`, `<![CDATA[`)
    // renders as nothing, or as collapsed content, on GitHub. Fail closed.
    if (/<[A-Za-z!/?]/.test(line)) {
      throw new Error(`review contains raw HTML on line ${lineNumber}`);
    }
    // A link reference definition (`[label]: destination`, including the markdown-comment
    // idiom `[//]: # (text)`) renders as nothing at all, yet contains no HTML — so it
    // could carry candidate SHAs that satisfy the binding while the human-visible
    // Verification section names none of them. Matched at ANY indentation: CommonMark's
    // `^ {0,3}` block-start anchor assumes 4 spaces means indented code, but this
    // validator deliberately no longer treats indentation as code, so an indented
    // definition nested under a list item is still a definition that renders as nothing.
    if (/^[ \t]*\[[^\]]*\]:/.test(line)) {
      throw new Error(`review contains a link reference definition on line ${lineNumber}`);
    }
    visible.push(line);
  }
  if (fence) throw new Error("review contains an unterminated code fence");
  if (htmlComment) throw new Error("review contains an unterminated HTML comment");
  return visible.join("\n");
}

// CommonMark allows the abrupt closings `<!-->` and `<!--->`; a naive search from
// `commentStart + 4` misses them and swallows every following visible line.
function htmlCommentCloseEnd(line, commentStart) {
  const rest = line.slice(commentStart);
  if (rest.startsWith("<!--->")) return commentStart + 6;
  if (rest.startsWith("<!-->")) return commentStart + 5;
  const commentEnd = line.indexOf("-->", commentStart + 4);
  return commentEnd === -1 ? -1 : commentEnd + 3;
}

/* ------------------------------------------------------------------------------------ *
 * Per-PR selection layer — the only part that is NOT vendored from the hub.
 * ------------------------------------------------------------------------------------ */

/** The label that exempts a PR from needing review evidence. */
export const EXEMPTION_LABEL = "review-evidence-exempt";

/** The status context the branch-protection rule must require. */
export const STATUS_CONTEXT = "review-evidence";

/**
 * A comment is a *candidate* attestation when it carries a whole-line MERGE_READY token.
 * Deliberately cheap and non-throwing: `validateReviewBody` rejects hostile markdown by
 * throwing, and we want those rejections reported as candidate failures rather than
 * silently skipping the comment (which would read as "no evidence" and hide the reason).
 */
export function isEvidenceCandidate(body) {
  return typeof body === "string" && /^[ \t]*MERGE_READY[ \t]*$/m.test(body);
}

/**
 * Decide whether a PR at `headSha` has valid, current review evidence.
 *
 * Pure and synchronous on purpose: every network fact (head SHA, comment bodies, whether
 * each author has write access, whether the exemption label is attributable) is resolved
 * by the caller, so the decision itself is fully testable without a network.
 *
 * FAIL CLOSED. Every path that cannot answer "yes, valid evidence exists" either throws or
 * returns `ok: false`. There is no branch that returns `ok: true` on missing input.
 *
 * @param {object} input
 * @param {string} input.headSha            40-char lowercase head SHA of the PR.
 * @param {Array<{id:string,url:string,author:string,authorized:boolean,body:string}>} input.comments
 * @param {{label:string, actor:string, stale?:boolean}|null} [input.exemption]  Attributed
 *   exemption, or null. `stale: true` means the label was applied before the current head —
 *   it is reported as a named rejection, never honoured.
 * @returns {{ok:boolean, kind:string, summary:string, rejected:Array<object>}}
 */
export function evaluateReviewEvidence({ headSha, comments, exemption = null }) {
  if (!SHA_PATTERN.test(headSha ?? "")) {
    throw new Error("head SHA must be a lowercase 40-character commit SHA");
  }
  if (!Array.isArray(comments)) {
    throw new Error("PR comment list could not be read");
  }
  const rejected = [];
  if (exemption) {
    if (!exemption.actor) {
      throw new Error(`${exemption.label} label is not attributable to a user`);
    }
    // A label that predates the current head is reported, not honoured. Its staleness is
    // derived from the data by the caller, so no cleanup step has to have run for this to
    // be correct — see resolveExemption in scripts/validate-pr-review-evidence.mjs.
    if (exemption.stale) {
      rejected.push({
        url: `label:${exemption.label}`,
        author: exemption.actor,
        reason: "exemption label predates the current head — re-apply it to exempt this commit",
      });
    } else {
      return {
        ok: true,
        kind: "exempt",
        summary: `Exempt: '${exemption.label}' applied by @${exemption.actor}`,
        rejected: [],
      };
    }
  }
  for (const comment of comments) {
    if (!isEvidenceCandidate(comment.body)) continue;
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
      validateReviewBody(comment.body, [headSha]);
      return {
        ok: true,
        kind: "evidence",
        summary: `Reviewed at ${headSha.slice(0, 7)} by @${comment.author}`,
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
      : `No review evidence names head ${headSha.slice(0, 7)}`,
    rejected,
  };
}
