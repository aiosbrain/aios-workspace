/**
 * review-bugbot/findings.mjs — the one severity dialect and clear/blocked verdict protocol
 * every review pass is judged against, plus the prompts that ask for it.
 *
 * Owned invariant: a verdict only clears when the model's ENTIRE response is the exact
 * `BUGBOT_CLEAR` token (or a streaming-artifact repetition of it) — no prose alongside a
 * clear verdict, ever (see `detectBugbotClear`'s comment for why: a hedging model narrating
 * "no Critical issues" beside the token must still block). `hasFindingsAtOrAbove` and
 * `hasUnstructuredSeverityClaim` are the two structural matchers that decide whether a
 * response contains a blocking finding at all — both the Cursor review loop and the
 * findings consolidator gate on this same matcher (AIO-239). This is the mutation target
 * for the severity-classification concern; do not duplicate the matcher elsewhere. AIO-558:
 * extracted verbatim from `scripts/review-bugbot.mjs` (this repo, not a rewrite) — see
 * `docs/v1-operator-loop/domains/safety-unit-extraction.md`.
 *
 * Exported:
 *   SEVERITY_RANK
 *   canonicalSeverity(value)
 *   buildSecurityReviewPrompt({...})
 *   buildBugbotPrompt({...})
 *   hasFindingsAtOrAbove(text, failOn)
 *   hasUnstructuredSeverityClaim(text, failOn)
 *   hasCriticalOrHighFindings(text)
 *   detectBugbotClear(text)
 *   detectBugbotBlocked(text)
 *   BUGBOT_CLEAR_TOKEN
 *   BUGBOT_BLOCKED_TOKEN
 */

export const BUGBOT_CLEAR_TOKEN = "BUGBOT_CLEAR";
export const BUGBOT_BLOCKED_TOKEN = "BUGBOT_BLOCKED";

const OPENCODE_PLATFORM_CONSTRAINT =
  "Known constraints: OpenCode currently exposes only a non-blocking idle event, so its adapter uses the acknowledged prompt_async endpoint to re-prompt and aios build/ship provide the documented hard pre-merge boundary. Project-local lifecycle hooks are UX controls and cannot be tamper-proof against an actor with arbitrary worktree write access; external required CI is needed for that stronger boundary. Canonical main must be verified before declaring even a clean worktree unchanged because committed feature-branch changes are not visible in git status and the writable local origin/main ref is not a trusted proof; an offline verification failure is deliberately fail-closed. Do not report these inherent constraints unless this changeset regresses their documented mitigations.";

/**
 * Render the paths whose content is deliberately kept out of the prompt payload
 * (generated lockfile/dist noise). Their bytes still feed the review fingerprint and
 * fail-closed compensating gates verify them, so this is a disclosure, not a blind spot.
 */
function excludedPathsSection(excluded = []) {
  if (!excluded.length) return [];
  return [
    "## Changed, not shown in full",
    "",
    "These generated paths changed in this changeset; their raw content is excluded from this",
    "prompt but their bytes still feed the review fingerprint, and fail-closed compensating",
    "gates verify them (manifest parity, registry-host and integrity-hash checks on every",
    "changed lockfile entry, and a clean `npm ci --ignore-scripts` resolution). The summarized",
    "delta below is the reviewable form — judge it as you would the diff, and do not report",
    "the absence of the raw content as a finding.",
    "",
    ...excluded.flatMap((file) => [
      `- ${file.path} — ${file.bytes} bytes, sha256 ${file.sha256}`,
      ...(file.summary ?? []).map((line) => `  - ${line}`),
    ]),
    "",
  ];
}

export function buildSecurityReviewPrompt({
  branch,
  baseSha,
  diffStat,
  diff,
  logOneline,
  failOn = "high",
  promptOnly = false,
  excluded = [],
}) {
  const blocking = blockingSeverityNames(failOn);
  return [
    "/review-security",
    "",
    `Security review of branch \`${branch}\` (base ${baseSha}..HEAD).`,
    "Focus on auth bypass, injection, secrets exposure, tier isolation, unsafe defaults,",
    "missing requireAuth(), and hook/validator bypasses.",
    promptOnly
      ? "You cannot run commands — base findings only on the diff and commit list below."
      : "Run security-focused tests/validators in this worktree to gather evidence.",
    OPENCODE_PLATFORM_CONSTRAINT,
    "Treat untracked-file sections as files in this atomic proposed changeset; do not report their untracked status as a finding.",
    "",
    "## Commits",
    "",
    logOneline || "(none)",
    "",
    "## git diff --stat",
    "",
    diffStat || "(empty)",
    "",
    ...excludedPathsSection(excluded),
    "## git diff",
    "",
    diff,
    "",
    "---",
    `List findings by severity when any ${blocking} finding exists and OMIT the clear token.`,
    `If there are NO ${blocking} findings, your entire response MUST be exactly ${BUGBOT_CLEAR_TOKEN}.`,
    "Do not add a summary, heading, explanation, table, advisory note, or code fence to a clear response.",
    `Emit no preamble or narration before the verdict: ${BUGBOT_CLEAR_TOKEN} must be the FINAL line of your response, on a line of its own, with nothing after it.`,
  ].join("\n");
}

export function buildBugbotPrompt({
  skill,
  branch,
  baseSha,
  diffStat,
  diff,
  logOneline,
  promptOnly = false,
  failOn = "high",
  excluded = [],
}) {
  const blocking = blockingSeverityNames(failOn);
  return [
    skill,
    "",
    `Review branch \`${branch}\` changes (base ${baseSha}..HEAD) per your skill.`,
    promptOnly
      ? "You cannot run commands — base findings only on the diff and commit list below."
      : "Run tests/validators in this worktree to gather evidence.",
    OPENCODE_PLATFORM_CONSTRAINT,
    "Treat untracked-file sections as files in this atomic proposed changeset; do not report their untracked status as a finding.",
    "",
    "## Commits",
    "",
    logOneline || "(none)",
    "",
    "## git diff --stat",
    "",
    diffStat || "(empty)",
    "",
    ...excludedPathsSection(excluded),
    "## git diff",
    "",
    diff,
    "",
    "---",
    `List findings by severity when any ${blocking} finding exists and OMIT the clear token.`,
    `If there are NO ${blocking} findings, your entire response MUST be exactly ${BUGBOT_CLEAR_TOKEN}.`,
    "Do not add a summary, heading, explanation, table, advisory note, or code fence to a clear response.",
    `Emit no preamble or narration before the verdict: ${BUGBOT_CLEAR_TOKEN} must be the FINAL line of your response, on a line of its own, with nothing after it.`,
  ].join("\n");
}

// Structural matchers for a listed Critical/High finding: a leading bullet
// (`- Critical: …`), a leading severity table cell (`| High |`), or the bracket form
// (`[High] file:line — …`) that the consolidated findings report (code-reviewer.md's
// "Output format") emits. Prose such as "no Critical or High findings" matches NONE of
// these — only an actual listed finding. This is the single severity dialect: both the
// Cursor review loop and the consolidator gate on the same matcher.
// All three tolerate markdown emphasis around the severity (`**[High]**`, `**High**`): the
// consolidator model bolds findings, and a decoration-blind matcher silently downgraded a
// BLOCKED round to CLEAR (AIO-239 / observation.md §9 — the verdict must not hinge on `**`).
const MD = "(?:\\*\\*|__|\\*|_)?"; // optional emphasis opener/closer

// Rank for merging/comparing severities across sources (used by the consolidator).
export const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

export function canonicalSeverity(value) {
  const found = Object.keys(SEVERITY_RANK).find(
    (severity) => severity.toLowerCase() === String(value ?? "").toLowerCase()
  );
  return found ?? null;
}

function blockingSeverityNames(failOn) {
  const canonical = canonicalSeverity(failOn);
  if (!canonical) throw new Error(`invalid Bugbot severity: ${failOn}`);
  const threshold = SEVERITY_RANK[canonical];
  const names = Object.entries(SEVERITY_RANK)
    .filter(([, rank]) => rank >= threshold)
    .map(([name]) => name);
  if (names.length === 1) return names[0];
  if (names.length === 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}

/** True when review text contains a listed finding at or above the requested severity. */
export function hasFindingsAtOrAbove(text, failOn = "high") {
  const canonical = canonicalSeverity(failOn);
  if (!canonical) throw new Error(`invalid Bugbot severity: ${failOn}`);
  const threshold = SEVERITY_RANK[canonical];
  const severity = "(Critical|High|Medium|Low)";
  const patterns = [
    new RegExp(
      `^\\s*(?:(?:[-*]|\\d+[.)]|#{1,6})\\s+)?${MD}\`?${severity}\\s+Severity\`?${MD}\\s*(?::|—|-\\s+|$)`,
      "i"
    ),
    new RegExp(`^\\s*(?:[-*]|\\d+[.)])\\s*${MD}\`?${severity}\`?${MD}\\s*(?::|—|-\\s+)`, "i"),
    new RegExp(`^\\s*(?:[-*]|\\d+[.)])\\s*${MD}\\[${severity}\\]${MD}`, "i"),
    new RegExp(`^\\s*\\|\\s*${MD}\`?${severity}\`?${MD}\\s*\\|`, "i"),
    new RegExp(`^\\s*${MD}\\[${severity}\\]`, "i"),
    new RegExp(`^\\s*${MD}\`?${severity}\`?${MD}\\s*(?::|—|-\\s+)`, "i"),
  ];
  return String(text ?? "")
    .split("\n")
    .some((line) => {
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (!match) continue;
        const listed = canonicalSeverity(match[1]);
        if (listed && SEVERITY_RANK[listed] >= threshold) return true;
      }
      return false;
    });
}

/**
 * Catch assertive severity prose that violates the structured finding dialect.
 * Progress/negative statements remain non-findings; this deliberately requires both
 * a gating severity and concrete risk language to avoid matching generic status text.
 */
export function hasUnstructuredSeverityClaim(text, failOn = "high") {
  const canonical = canonicalSeverity(failOn);
  if (!canonical) throw new Error(`invalid Bugbot severity: ${failOn}`);
  const threshold = SEVERITY_RANK[canonical];
  const names = Object.entries(SEVERITY_RANK)
    .filter(([, rank]) => rank >= threshold)
    .map(([name]) => name)
    .join("|");
  const severity = `(?:${names})`;
  // Require punctuation/whitespace after the severity.  A word boundary would
  // also match narration such as "High-level" and "Medium-level".
  const startsWithSeverity = new RegExp(
    `^\\s*(?:\\*\\*|__|\\*|_)?\\[?${severity}\\]?(?=\\s|:|—)`,
    "i"
  );
  const assertiveSeverity = new RegExp(
    `\\b(?:found|identified|confirmed|detected|observed|reports?|there\\s+(?:is|are))\\s+(?:an?\\s+)?(?:possible\\s+)?(?:\\*\\*|__|\\*|_)?\\[?${severity}\\]?\\b`,
    "i"
  );
  const concreteRisk =
    /\b(?:finding|issue|bug|bypass|vulnerab\w*|regress\w*|risk|leak|inject\w*|unsafe|incorrect|failure|error|race|auth\w*|security|correctness|data[ -]loss)\b/i;
  const resolvedEvidence =
    /\b(?:fixed|resolved|mitigated|prevented|guarded)\b|\bcovered\s+by\s+(?:tests?|coverage|validators?)\b/i;
  const riskClassification = new RegExp(
    `^\\s*(?:\\*\\*|__|\\*|_)?\\[?${severity}\\]?\\s+risk\\s+(?:change|level|profile|classification)\\b`,
    "i"
  );
  const concreteIssueBeyondRisk =
    /\b(?:finding|issue|bug|bypass|vulnerab\w*|regress\w*|leak|inject\w*|unsafe|incorrect|failure|error|race|auth\w*|security|correctness|data[ -]loss)\b/i;

  return String(text ?? "")
    .split("\n")
    .some((line) => {
      if (!concreteRisk.test(line)) return false;
      if (/^\s*(?:high|medium|critical)(?:-level)?\s+(?:confidence|summary)\b/i.test(line))
        return false;
      if (
        startsWithSeverity.test(line) &&
        /\b(?:acceptable|no concerns?|looks? (?:fine|good|correct)|well covered)\b/i.test(line)
      )
        return false;
      const resolution = resolvedEvidence.exec(line);
      if (resolution) {
        const prefix = line.slice(0, resolution.index);
        const resolutionNegated =
          /\b(?:not|never)\b(?:\s+\w+){0,3}\s*$|\bwithout\b(?:\s+\w+){0,2}\s*$/i.test(prefix);
        if (!resolutionNegated) return false;
      }
      if (riskClassification.test(line) && !concreteIssueBeyondRisk.test(line)) return false;
      if (startsWithSeverity.test(line)) return true;
      const match = assertiveSeverity.exec(line);
      if (!match) return false;
      const prefix = line.slice(0, match.index);
      return !/\b(?:no|not|none|without)\s*$/i.test(prefix);
    });
}

/** True when review text lists a Critical/High finding (bullet, table row, or bracket). */
export function hasCriticalOrHighFindings(text) {
  return hasFindingsAtOrAbove(text, "high");
}

/**
 * True only when the review response is the machine clear token and nothing else —
 * every non-empty line consists solely of one-or-more CLEAR tokens (whitespace-separated).
 *
 * DELIBERATELY strict — no prose alongside the token. A model that narrates alongside a
 * clear verdict may be hedging (describing a real problem informally, in a shape
 * `hasFindingsAtOrAbove` cannot parse) while still signing off, so `None.\nBUGBOT_CLEAR`,
 * `No Critical issues found.\n\nBUGBOT_CLEAR`, and `BUGBOT_CLEAR is not appropriate here`
 * are all refused (see test/review-bugbot.test.mjs + test/fix-ladder.test.mjs). Do NOT
 * relax this to "the last line is the token" — that would let exactly that hedging through.
 *
 * The single tolerance added (AIO-472) is a streaming artifact, not prose: composer-2.5's
 * two review passes' output can concatenate as `BUGBOT_CLEARBUGBOT_CLEAR` or arrive as
 * repeated bare-token lines, a genuinely clean review that the old exact-`.trim()`-equality
 * check misreported as a protocol `error`. Accepting only lines that are *pure* repeated
 * tokens admits that artifact while keeping every prose case rejected.
 */
export function detectBugbotClear(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return false;
  const token = BUGBOT_CLEAR_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const clearOnly = new RegExp(`^(?:${token}[ \\t]*)+$`);
  return lines.every((l) => clearOnly.test(l));
}

/** True only when the verdict response is the exact machine blocked token. */
export function detectBugbotBlocked(text) {
  return String(text ?? "").trim() === BUGBOT_BLOCKED_TOKEN;
}
