/**
 * review-bugbot.mjs — local Cursor Bugbot review (CLI hook for agents + aios build).
 *
 * Runs code (`/review-bugbot`) and security review passes against the real branch
 * diff, blocking at the configured severity threshold. Use standalone or via
 * `aios build --merge`.
 *
 * Exported:
 *   runLocalBugbotReview({ repo, worktree, baseSha, branch, cursorTimeout, skill })
 *   cmdReviewBugbot(repo, args)
 */

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { c, die, callCursorAgent } from "./relay-core.mjs";
import { callPromptModel } from "./model-call.mjs";
import { parseModelRef } from "./model-providers.mjs";

export const DEFAULT_BUGBOT_SKILL = "/review-bugbot";
export const BUGBOT_CLEAR_TOKEN = "BUGBOT_CLEAR";
export const BUGBOT_BLOCKED_TOKEN = "BUGBOT_BLOCKED";
export const BUGBOT_CLEAR_MARKER = "AIOS_BUGBOT_RESULT=clear";
export const BUGBOT_BLOCKED_MARKER = "AIOS_BUGBOT_RESULT=blocked";
export const REQUIRED_BUGBOT_FAIL_ON = "medium";
export const REQUIRED_BUGBOT_MODEL = "cursor:composer-2.5";
export const CANONICAL_BUGBOT_MAIN_URL = "https://github.com/aiosbrain/aios-workspace.git";
const CURSOR_REVIEW_FLAGS = ["--force", "--trust"];
export const LOCAL_BUGBOT_DIFF_CAP = 500_000;
const DEFAULT_TIMEOUT = 300;
const CURSOR_TIMEOUT_RETRY_BUDGET_MULTIPLIER = 3;
const CURSOR_RETRIABLE_ATTEMPTS = 2;
const CURSOR_RETRIABLE_BASE_DELAY_MS = 2_000;
const OPENCODE_PLATFORM_CONSTRAINT =
  "Known constraints: OpenCode currently exposes only a non-blocking idle event, so its adapter uses the acknowledged prompt_async endpoint to re-prompt and aios build/ship provide the documented hard pre-merge boundary. Project-local lifecycle hooks are UX controls and cannot be tamper-proof against an actor with arbitrary worktree write access; external required CI is needed for that stronger boundary. Canonical main must be verified before declaring even a clean worktree unchanged because committed feature-branch changes are not visible in git status and the writable local origin/main ref is not a trusted proof; an offline verification failure is deliberately fail-closed. Do not report these inherent constraints unless this changeset regresses their documented mitigations.";
const TRUSTED_GIT_BIN = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
  existsSync
);
const TRUSTED_BASH_BIN = ["/bin/bash", "/usr/bin/bash"].find(existsSync);
const TRUSTED_ACCOUNT = userInfo();
const TRUSTED_HOME = TRUSTED_ACCOUNT.homedir;
const TRUSTED_CURSOR_BIN = [
  path.join(TRUSTED_HOME, ".local", "bin", "cursor"),
  path.join(TRUSTED_HOME, ".cursor", "bin", "cursor"),
  "/opt/homebrew/bin/cursor",
  "/usr/local/bin/cursor",
  "/usr/bin/cursor",
].find(existsSync);

function trustedUserEnv(source = process.env) {
  const env = { ...source };
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "CURSOR_CONFIG_DIR",
    "ZDOTDIR",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (/^CURSOR_.*(?:_PATH|_PATHS|_DIR|_HOME)$/.test(key)) delete env[key];
  }
  env.HOME = TRUSTED_HOME;
  env.USER = TRUSTED_ACCOUNT.username;
  env.LOGNAME = TRUSTED_ACCOUNT.username;
  env.XDG_CONFIG_HOME = path.join(TRUSTED_HOME, ".config");
  env.XDG_DATA_HOME = path.join(TRUSTED_HOME, ".local", "share");
  env.XDG_STATE_HOME = path.join(TRUSTED_HOME, ".local", "state");
  env.XDG_CACHE_HOME = path.join(TRUSTED_HOME, ".cache");
  env.SHELL = "/bin/sh";
  return env;
}

function trustedGitEnv(source = process.env) {
  const env = trustedUserEnv(source);
  // Git has many environment-only configuration and helper escape hatches
  // (`GIT_CONFIG_PARAMETERS`, `GIT_EXEC_PATH`, transport helpers, object dirs,
  // and more). Deny the whole namespace, then add back only the fixed controls
  // below. A partial denylist would let a poisoned parent shell redirect the
  // canonical-main lookup before any review runs.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_") ||
      /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key) ||
      key === "SSL_CERT_FILE" ||
      key === "SSL_CERT_DIR"
    ) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
  return env;
}

function trustedScannerEnv(source = process.env) {
  const env = trustedGitEnv(source);
  for (const key of [
    "BASH_ENV",
    "ENV",
    "CDPATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
  ]) {
    delete env[key];
  }
  env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

export function trustedReviewerEnv(source = process.env) {
  const allowed = {};
  for (const key of [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
  ]) {
    if (source[key] !== undefined) allowed[key] = source[key];
  }
  return trustedScannerEnv(allowed);
}

function gitQuiet(args, cwd) {
  if (!TRUSTED_GIT_BIN) throw new Error("trusted system git binary not found");
  try {
    return execFileSync(TRUSTED_GIT_BIN, ["--no-replace-objects", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: trustedGitEnv(),
    }).trim();
  } catch {
    return "";
  }
}

function gitRaw(args, cwd) {
  if (!TRUSTED_GIT_BIN) throw new Error("trusted system git binary not found");
  try {
    return execFileSync(TRUSTED_GIT_BIN, ["--no-replace-objects", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: trustedGitEnv(),
    });
  } catch {
    return "";
  }
}

function gitRequired(args, cwd) {
  if (!TRUSTED_GIT_BIN) throw new Error("trusted system git binary not found");
  return execFileSync(TRUSTED_GIT_BIN, ["--no-replace-objects", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: trustedGitEnv(),
  }).trim();
}

function gitObjectExists(repo, sha) {
  try {
    gitRequired(["cat-file", "-e", `${sha}^{commit}`], repo);
    return true;
  } catch {
    return false;
  }
}

export function resolveRequiredBugbotBase(repo, { canonicalUrl = CANONICAL_BUGBOT_MAIN_URL } = {}) {
  let listing;
  try {
    // Resolve main outside the checkout with global/system Git configuration disabled,
    // so a rewritten local tracking ref or url.* rule cannot choose the review base.
    listing = gitRequired(["ls-remote", "--exit-code", canonicalUrl, "refs/heads/main"], tmpdir());
  } catch {
    return {
      ok: false,
      reason:
        "cannot verify origin/main against the canonical remote; network access is required even for a clean worktree because committed branch changes must not be skipped",
    };
  }
  const remoteSha = listing.match(/^([a-f0-9]{40,64})\s+refs\/heads\/main$/m)?.[1];
  if (!remoteSha) {
    return { ok: false, reason: "canonical remote did not return a valid main commit" };
  }
  if (!gitObjectExists(repo, remoteSha)) {
    try {
      gitRequired(["fetch", "--no-tags", "--quiet", canonicalUrl, "refs/heads/main"], repo);
    } catch {
      return { ok: false, reason: "cannot fetch the verified canonical main commit" };
    }
  }
  if (!gitObjectExists(repo, remoteSha)) {
    return { ok: false, reason: "canonical fetch did not provide the verified main commit" };
  }
  const baseSha = gitQuiet(["merge-base", "HEAD", remoteSha], repo);
  if (!baseSha) {
    return { ok: false, reason: "current HEAD has no merge base with canonical main" };
  }
  return { ok: true, baseSha, remoteSha };
}

export function buildSecurityReviewPrompt({
  branch,
  baseSha,
  diffStat,
  diff,
  logOneline,
  failOn = "high",
  promptOnly = false,
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

function canonicalSeverity(value) {
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

export async function retryReviewTimeoutOnce(call, timeoutMs, onRetry = () => {}) {
  try {
    return await call(timeoutMs);
  } catch (error) {
    if (!/timed out after/i.test(error?.message ?? "")) throw error;
    const retryTimeoutMs = timeoutMs * 2;
    onRetry(retryTimeoutMs, error);
    return call(retryTimeoutMs);
  }
}

export function cursorReviewRetryBudgetMs(timeoutMs) {
  const timeoutCycleMs = CURSOR_TIMEOUT_RETRY_BUDGET_MULTIPLIER * timeoutMs;
  const exhaustionBackoffMs =
    CURSOR_RETRIABLE_BASE_DELAY_MS * (2 ** (CURSOR_RETRIABLE_ATTEMPTS - 1) - 1);
  return CURSOR_RETRIABLE_ATTEMPTS * timeoutCycleMs + exhaustionBackoffMs;
}

// Transient exhaustion the reviewer can recover from on a retry (rate-limit contention when
// several agents run the gate at once). NOT the same as a timeout (handled above): these fail
// fast, so a bounded backoff is cheap against the child-timeout budget.
const RETRIABLE_REVIEW_RE = /resource_exhausted|RetriableError|\b429\b|rate.?limit/i;

/**
 * Retry `call` with bounded exponential backoff, but ONLY on a retriable-exhaustion error —
 * any other failure (including a timeout, which `retryReviewTimeoutOnce` owns) rethrows
 * immediately. Compose this AROUND the timeout retry, not inside it.
 *
 * Budget contract: `cursorReviewRetryBudgetMs` describes this outer retry composed with the
 * timeout retry above, and the parent hook imports it when setting the child deadline. Both
 * review passes retry concurrently under Promise.all, so their budgets are not additive.
 */
export async function retryReviewOnRetriable(
  call,
  { attempts = 2, baseDelayMs = 2_000 } = {},
  onRetry = () => {}
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !RETRIABLE_REVIEW_RE.test(error?.message ?? "")) throw error;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry(attempt, delayMs, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function captureUntracked(worktree) {
  const listed = gitRaw(["ls-files", "--others", "--exclude-standard", "-z"], worktree);
  const files = listed.split("\0").filter(Boolean).sort();
  const blocks = [];
  const hashes = [];
  const withheldFiles = [];
  for (const rel of files) {
    try {
      const body = readFileSync(path.join(worktree, rel));
      const digest = createHash("sha256").update(body).digest("hex");
      hashes.push(`${rel}\0${digest}`);
      withheldFiles.push(rel);
      const rendered = `(untracked content withheld locally: ${body.length} bytes, sha256 ${digest})`;
      blocks.push(`### Untracked file: ${rel}\n\n${rendered}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hashes.push(`${rel}\0unreadable:${message}`);
      withheldFiles.push(rel);
      blocks.push(`### Untracked file: ${rel}\n\n(unreadable: ${message})`);
    }
  }
  return { files, blocks, fingerprintMaterial: hashes.join("\n"), withheldFiles };
}

function captureSuppressedTrackedFiles(worktree) {
  const listed = gitRaw(["ls-files", "-v", "-z"], worktree);
  return listed
    .split("\0")
    .filter(Boolean)
    .flatMap((entry) => {
      const tag = entry[0];
      return tag === "S" || /^[a-z]$/.test(tag) ? [entry.slice(2)] : [];
    })
    .sort();
}

export function captureBranchDiff(worktree, baseSha, { includeWorktree = false } = {}) {
  const range = includeWorktree ? baseSha : `${baseSha}..HEAD`;
  let diffStat = gitQuiet(["diff", "--stat", range], worktree);
  const logOneline = gitQuiet(["log", "--oneline", `${baseSha}..HEAD`], worktree);
  let rawDiff = gitQuiet(["diff", "--binary", range], worktree);
  let untrackedMaterial = "";
  let withheldUntrackedFiles = [];
  const suppressedTrackedFiles = includeWorktree ? captureSuppressedTrackedFiles(worktree) : [];
  if (includeWorktree) {
    const untracked = captureUntracked(worktree);
    if (untracked.files.length) {
      const suffix = `${untracked.files.length} untracked file${untracked.files.length === 1 ? "" : "s"}`;
      diffStat = diffStat ? `${diffStat}\n ${suffix}` : suffix;
      rawDiff = [rawDiff, ...untracked.blocks].filter(Boolean).join("\n\n");
      untrackedMaterial = untracked.fingerprintMaterial;
      withheldUntrackedFiles = untracked.withheldFiles;
    }
  }
  const fingerprint = createHash("sha256")
    .update(`${baseSha}\0${rawDiff}\0${untrackedMaterial}`)
    .digest("hex");
  const reviewTooLarge = rawDiff.length > LOCAL_BUGBOT_DIFF_CAP;
  let diff = rawDiff;
  if (diff.length > LOCAL_BUGBOT_DIFF_CAP) {
    const files = includeWorktree
      ? gitQuiet(["status", "--short"], worktree)
      : gitQuiet(["diff", "--name-only", range], worktree);
    diff = `(diff truncated at ${LOCAL_BUGBOT_DIFF_CAP} chars — files:\n${files})`;
  }
  return {
    diffStat,
    logOneline,
    diff,
    fingerprint,
    // A review must see the atomic changeset. Oversized diffs fail closed below.
    reviewDiff: rawDiff,
    reviewTooLarge,
    withheldUntrackedFiles,
    suppressedTrackedFiles,
  };
}

async function runReviewPrompt({
  label,
  prompt,
  worktree,
  timeoutMs,
  model = "deepseek-v4-pro",
  readOnly = false,
}) {
  const ref = parseModelRef(model);
  // Read-only review needs only the supplied diff. Every provider runs outside the
  // checkout so project config and lifecycle hooks cannot mutate or recurse.
  const reviewCwd = readOnly ? mkdtempSync(path.join(tmpdir(), "aios-bugbot-review-")) : worktree;
  try {
    if (ref.provider === "cursor") {
      if (!TRUSTED_CURSOR_BIN) die("trusted Cursor CLI binary not found");
      console.log(c.dim(`[cursor] ${label} (${model})...`));
      const invoke = (attemptTimeoutMs) =>
        callCursorAgent(prompt, attemptTimeoutMs, {
          cwd: reviewCwd,
          bin: TRUSTED_CURSOR_BIN,
          env: trustedReviewerEnv(),
          // Cursor may stream progress narration before its terminal result event. Keep
          // both: the transcript is scanned for findings and the terminal payload must
          // independently satisfy the exact machine-verdict protocol.
          resultEventBundle: true,
          extraArgs: [
            ...CURSOR_REVIEW_FLAGS,
            ...(readOnly ? ["--mode", "ask"] : []),
            ...(ref.modelId ? ["--model", ref.modelId] : []),
          ],
        });
      return await retryReviewOnRetriable(
        () =>
          retryReviewTimeoutOnce(invoke, timeoutMs, (retryTimeoutMs) => {
            console.warn(
              c.yellow(
                `[cursor] ${label} timed out after ${timeoutMs / 1000}s; retrying once with ${retryTimeoutMs / 1000}s`
              )
            );
          }),
        {
          attempts: CURSOR_RETRIABLE_ATTEMPTS,
          baseDelayMs: CURSOR_RETRIABLE_BASE_DELAY_MS,
        },
        (attempt, delayMs) => {
          console.warn(
            c.yellow(
              `[cursor] ${label} hit transient exhaustion (attempt ${attempt}); backing off ${delayMs / 1000}s before retry`
            )
          );
        }
      );
    }
    console.log(c.dim(`[${ref.provider}] ${label} (${model})...`));
    return await callPromptModel({ model, prompt, timeoutMs, opts: { cwd: reviewCwd } });
  } finally {
    if (readOnly) rmSync(reviewCwd, { recursive: true, force: true });
  }
}

export function runLocalSecretsPreflight(worktree, sourceEnv = process.env) {
  const scanner = path.join(worktree, "validation", "check-secrets.sh");
  if (!TRUSTED_BASH_BIN) {
    return { ok: false, reason: "required trusted bash binary is missing" };
  }
  if (!existsSync(scanner)) {
    return {
      ok: false,
      reason: "required local secrets preflight is missing: validation/check-secrets.sh",
    };
  }
  try {
    execFileSync(TRUSTED_BASH_BIN, [scanner, worktree], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      env: trustedScannerEnv(sourceEnv),
    });
    return { ok: true };
  } catch {
    // Never return scanner output: even a faulty pattern must not echo secret material
    // into hook evidence or an external agent prompt.
    return {
      ok: false,
      reason:
        "local secrets preflight failed; run `bash validation/check-secrets.sh .` locally and fix every finding before Bugbot",
    };
  }
}

/** Pre-PR local pass: code (/review-bugbot persona) + security, via DeepSeek when keyed. */
export async function runLocalPrePrReview({
  worktree,
  baseSha,
  branch,
  timeoutMs = DEFAULT_TIMEOUT * 1000,
  model = REQUIRED_BUGBOT_MODEL,
  reviewPrompt = runReviewPrompt,
  failOn = REQUIRED_BUGBOT_FAIL_ON,
  includeWorktree = true,
  readOnly = true,
  skill = DEFAULT_BUGBOT_SKILL,
  secretsPreflight = runLocalSecretsPreflight,
}) {
  if (!worktree || !existsSync(worktree)) {
    return { ok: true, skipped: true, output: "(worktree missing — pre-PR review skipped)" };
  }
  if (!baseSha) die("baseSha required for pre-PR review");

  const secrets = secretsPreflight(worktree);
  if (!secrets.ok) {
    return { ok: false, error: true, output: secrets.reason };
  }

  const promptOnly = parseModelRef(model).provider !== "cursor" || readOnly;
  const {
    diffStat,
    logOneline,
    reviewDiff,
    reviewTooLarge,
    withheldUntrackedFiles,
    suppressedTrackedFiles,
    fingerprint,
  } = captureBranchDiff(worktree, baseSha, { includeWorktree });
  if (suppressedTrackedFiles.length) {
    return {
      ok: false,
      error: true,
      output: `refusing full-worktree review while tracked paths use skip-worktree/assume-unchanged: ${suppressedTrackedFiles.join(", ")}`,
    };
  }
  if (withheldUntrackedFiles.length) {
    return {
      ok: false,
      error: true,
      output: `refusing to send untracked content to Bugbot; stage the files you intend to have reviewed, or gitignore them if they are machine-local (build output, runtime/session state): ${withheldUntrackedFiles.join(", ")}`,
    };
  }
  if (reviewTooLarge) {
    return {
      ok: false,
      error: true,
      output: `changeset exceeds the ${LOCAL_BUGBOT_DIFF_CAP}-character local Bugbot limit; split the changeset so code and security reviewers can inspect it atomically`,
    };
  }
  if (!diffStat && !logOneline) {
    return { ok: true, output: "(no diff to review)" };
  }

  const runPass = async (label, makePrompt) => {
    const classify = (response) => {
      const bundled =
        response && typeof response === "object" && !Array.isArray(response)
          ? {
              transcript: String(response.transcript ?? ""),
              terminals: [response.result, response.eventResult]
                .filter((value) => value != null)
                .map(String),
            }
          : { transcript: String(response ?? ""), terminals: [String(response ?? "")] };
      const evidence = [bundled.transcript, ...bundled.terminals]
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join("\n\n--- terminal result ---\n\n");
      // Findings FIRST: streamed or terminal Medium+ evidence blocks even if another terminal
      // shape says clear. Only the exact terminal protocol can clear an otherwise clean pass.
      const finding =
        detectBugbotBlocked(bundled.transcript) ||
        bundled.terminals.some(detectBugbotBlocked) ||
        hasFindingsAtOrAbove(evidence, failOn) ||
        hasUnstructuredSeverityClaim(evidence, failOn);
      const error = !finding && !bundled.terminals.some(detectBugbotClear);
      return {
        finding,
        error,
        output: finding || error ? evidence : BUGBOT_CLEAR_TOKEN,
      };
    };
    const once = async () => {
      const response = await reviewPrompt({
        label,
        prompt: makePrompt(reviewDiff),
        worktree,
        timeoutMs,
        model,
        readOnly,
      });
      return classify(response);
    };

    let pass = await once();
    // Retry ONCE on a protocol error only — NEVER on a finding. This is the fix for
    // AIO-468, and it is deliberately at the caller rather than in `detectBugbotClear`:
    // a protocol error is the ABSENCE of a readable verdict, so re-asking is not a second
    // chance to pass. A real finding is captured by `finding` and short-circuits here
    // untouched — re-asking after a finding WOULD be a bypass, and must never be added.
    // Same precedent as `retryReviewTimeoutOnce` above. Without this, one malformed
    // response hard-blocks a merge (observed ~3 runs in 6), which pressures operators
    // toward bypassing the one gate that must never be bypassed.
    if (pass.error) {
      process.stderr.write(
        `[local-bugbot] ${label}: unreadable verdict — re-asking once (protocol error, not a finding)\n`
      );
      pass = await once();
    }
    return {
      ok: !pass.finding && !pass.error,
      finding: pass.finding,
      error: pass.error,
      output: pass.error
        ? `${pass.output}\n\n(review protocol error in the ${label} pass: expected terminal result to be exactly ${BUGBOT_CLEAR_TOKEN}, ${BUGBOT_BLOCKED_TOKEN}, or a structured finding)`
        : pass.output,
    };
  };

  const shared = { branch, baseSha, diffStat, logOneline, failOn };
  // Both passes are mandatory but independent. Concurrent execution avoids
  // doubling Stop-hook latency while preserving fail-closed aggregation.
  const [code, security] = await Promise.all([
    runPass("pre-PR code review", (diff) =>
      buildBugbotPrompt({ skill, promptOnly, diff, ...shared })
    ),
    runPass("pre-PR security review", (diff) =>
      buildSecurityReviewPrompt({ diff, promptOnly, ...shared })
    ),
  ]);
  const current = captureBranchDiff(worktree, baseSha, { includeWorktree });
  if (current.suppressedTrackedFiles.length) {
    return {
      ok: false,
      error: true,
      output: `tracked paths gained skip-worktree/assume-unchanged while Bugbot was reviewing: ${current.suppressedTrackedFiles.join(", ")}`,
    };
  }
  if (current.fingerprint !== fingerprint) {
    return {
      ok: false,
      error: true,
      output: "worktree changed while Bugbot was reviewing; run a fresh review before completing",
    };
  }
  const finding = code.finding || security.finding;
  return {
    ok: code.ok && security.ok,
    // A concrete Medium+ finding is already a deterministic block even when the
    // sibling pass also suffers an infrastructure error. Preserve that evidence as
    // the primary verdict; pure infrastructure failures remain errors.
    finding,
    error: !finding && (code.error || security.error),
    output: [code.output, security.output].join("\n\n--- security pass ---\n\n"),
    pass: !code.ok ? "code" : !security.ok ? "security" : "both",
  };
}

export async function runLocalBugbotReview({
  worktree,
  baseSha,
  branch,
  cursorTimeout = DEFAULT_TIMEOUT * 1000,
  skill = DEFAULT_BUGBOT_SKILL,
  model = REQUIRED_BUGBOT_MODEL,
  reviewPrompt = runReviewPrompt,
  failOn = REQUIRED_BUGBOT_FAIL_ON,
  includeWorktree = false,
  readOnly = false,
  secretsPreflight = runLocalSecretsPreflight,
}) {
  if (!worktree || !existsSync(worktree)) die("worktree path missing for Bugbot review");
  if (!baseSha) die("baseSha required for Bugbot review");
  return runLocalPrePrReview({
    worktree,
    baseSha,
    branch,
    timeoutMs: cursorTimeout,
    model,
    reviewPrompt,
    failOn,
    includeWorktree,
    readOnly,
    skill,
    secretsPreflight,
  });
}

export async function cmdReviewBugbot(repo, args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      [
        "",
        c.blue("aios review-bugbot — local code + security review on branch changes"),
        "",
        "usage:",
        "  aios review-bugbot [branch] [options]",
        "",
        "options:",
        "  --base <ref>            explicit diff base (default: verified canonical main)",
        "  --worktree <path>       worktree to review (default: existing or ../<repo>-<branch>)",
        "  --cursor-timeout N      seconds per review call (default: 300)",
        "  --skill /name           default: /review-bugbot",
        `  --model provider:model  reviewer model (default: ${REQUIRED_BUGBOT_MODEL})`,
        `  --fail-on severity      threshold (default: ${REQUIRED_BUGBOT_FAIL_ON})`,
        "  --include-worktree      include staged, unstaged, and untracked changes",
        "  --read-only             review supplied diff without running commands",
        "",
        "Requires a checked-out worktree for the branch. Exits 0 on BUGBOT_CLEAR / no blockers.",
      ].join("\n")
    );
    return;
  }

  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const positional = args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      !["--base", "--worktree", "--cursor-timeout", "--skill", "--model", "--fail-on"].includes(
        args[i - 1]
      )
  );
  const branch = positional[0];
  if (!branch) die("branch name required");

  const worktreePath =
    flag("--worktree") ??
    path.resolve(
      repo,
      "..",
      `${path.basename(repo)}-${branch.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
    );

  if (!existsSync(worktreePath)) {
    die(`worktree not found: ${worktreePath} — run aios build first or pass --worktree`);
  }

  const explicitBase = flag("--base");
  let baseSha;
  if (explicitBase) {
    baseSha = gitQuiet(["rev-parse", explicitBase], worktreePath) || explicitBase;
  } else {
    const verifiedBase = resolveRequiredBugbotBase(worktreePath);
    if (!verifiedBase.ok) die(verifiedBase.reason);
    baseSha = verifiedBase.baseSha;
  }

  const timeout = parseInt(flag("--cursor-timeout") ?? String(DEFAULT_TIMEOUT), 10) * 1000;
  const skill = flag("--skill") ?? DEFAULT_BUGBOT_SKILL;
  const model = flag("--model") ?? REQUIRED_BUGBOT_MODEL;
  const failOn = flag("--fail-on") ?? REQUIRED_BUGBOT_FAIL_ON;
  if (!canonicalSeverity(failOn)) {
    die("--fail-on must be one of: critical, high, medium, low");
  }

  const {
    ok,
    output,
    error: reviewError,
  } = await runLocalBugbotReview({
    repo,
    worktree: worktreePath,
    baseSha,
    branch,
    cursorTimeout: timeout,
    skill,
    model,
    failOn,
    includeWorktree: args.includes("--include-worktree"),
    readOnly: args.includes("--read-only"),
  });
  if (!ok) {
    if (reviewError) {
      console.error(c.red("\n✗ Bugbot could not complete — merge blocked."));
      console.error(output);
      process.exit(1);
    }
    if (args.includes("--hook-protocol")) console.error(`\n${BUGBOT_BLOCKED_MARKER}`);
    console.error(c.red(`\n✗ Bugbot found ${canonicalSeverity(failOn)}+ issues — merge blocked.`));
    console.error(output);
    process.exit(1);
  }
  // Cursor streams review text without guaranteeing a trailing newline. Prefix the
  // machine marker so the parent can require an exact standalone protocol line.
  if (args.includes("--hook-protocol")) console.log(`\n${BUGBOT_CLEAR_MARKER}`);
  console.log(c.green(`\n✓ ${BUGBOT_CLEAR_TOKEN} — no blocking Bugbot findings.`));
}
