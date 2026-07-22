#!/usr/bin/env node
/**
 * wait-for-bots.mjs — block until async bot reviews have posted substantive feedback on a PR.
 *
 * Polls every 30s until coderabbitai[bot] has posted a substantive issue comment,
 * inline comment, or submitted review after the PR's latest commit. Rate-limit stubs,
 * stale pre-push comments, and successful check runs without review text do not satisfy
 * the gate.
 *
 * Usage:
 *   node scripts/wait-for-bots.mjs --pr <number> [--repo owner/repo] [--timeout 10]
 *   node scripts/wait-for-bots.mjs --pr 44 --repo aiosbrain/aios-team-brain
 *
 * Can be invoked cross-repo — pass --repo explicitly to target any aiosbrain repo.
 *
 * Exit codes:
 *   0 — CodeRabbit posted a substantive current-head signal (or timeout reached with --any)
 *   1 — usage error
 *   2 — timeout reached with CodeRabbit still missing (the default)
 *
 * The default is require-all: a missing bot at timeout exits 2 so the caller does NOT
 * proceed to the Code Reviewer on incomplete signals. Pass --any to restore the old
 * proceed-anyway behavior (exit 0 on timeout). --require-all is accepted as a no-op
 * alias for the default (back-compat).
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const BOT_CONFIG = {
  "coderabbitai[bot]": {
    // Only substantive text is evidence. A successful CodeRabbit check run alone is not.
    stubPatterns: [
      /rate limited/i,
      /review limit reached/i,
      /prepaid credits/i,
      /review was skipped/i,
      /unable to review/i,
      /<summary>\s*Action performed\s*<\/summary>/i,
      /\bReview triggered\./i,
      /incremental review system/i,
    ],
  },
};

const POLL_INTERVAL_MS = 30_000;
const SUMMARY_LINES = 4;

// Select which bots to gate on from a --bots value (comma-separated or repeated), validating
// each name against BOT_CONFIG. Unknown names are a usage error (throws). Absent/empty → all
// configured bots (default behavior). Exported + pure so `aios ship` can select CodeRabbit
// without re-implementing validation. `botsArg` may be a string, an array (repeated
// flag), or null/undefined.
export function selectBots(config, botsArg) {
  const keys = Object.keys(config);
  if (botsArg == null || botsArg === "" || (Array.isArray(botsArg) && botsArg.length === 0)) {
    return keys;
  }
  const requested = (Array.isArray(botsArg) ? botsArg : [botsArg])
    .flatMap((s) => String(s).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
  const unknown = requested.filter((b) => !keys.includes(b));
  if (unknown.length) {
    throw new Error(`unknown bot(s): ${unknown.join(", ")} — known bots: ${keys.join(", ")}`);
  }
  // De-dupe while preserving BOT_CONFIG order.
  return keys.filter((k) => requested.includes(k));
}

function usage() {
  console.error(
    [
      "",
      "wait-for-bots.mjs — poll until CodeRabbit posts substantive current-head PR feedback",
      "",
      "usage:",
      "  node scripts/wait-for-bots.mjs --pr <number> [--repo owner/repo] [--timeout 10]",
      "",
      "options:",
      "  --pr <n>          PR number (required)",
      "  --repo <slug>     owner/repo (default: detected from git remote)",
      "  --timeout <min>   max wait in minutes (default: 10)",
      "  --bots <list>     comma-separated bots to gate on (default: coderabbitai[bot])",
      "  --any             exit 0 on timeout if CodeRabbit is missing (default: exit 2)",
      "  --require-all     no-op alias for the default (exit 2 when CodeRabbit is missing)",
      "",
      "Cross-repo: pass --repo explicitly, e.g. --repo aiosbrain/aios-team-brain",
    ].join("\n")
  );
}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(`gh ${args.slice(0, 3).join(" ")} … failed: ${e.stderr?.trim() ?? e.message}`);
  }
}

function detectRepo() {
  try {
    let url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return url
      .replace(/^git@github\.com:/, "")
      .replace(/^https:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
  } catch {
    return null;
  }
}

export function getLatestPush(repo, pr) {
  try {
    const raw = gh([
      "api",
      `repos/${repo}/pulls/${pr}/commits`,
      "--jq",
      ".[-1] | {sha: .sha, committedAt: .commit.committer.date}",
    ]);
    const value = JSON.parse(raw);
    const committedAt = new Date(value.committedAt);
    return value.sha && Number.isFinite(committedAt.getTime())
      ? { sha: value.sha, committedAt }
      : null;
  } catch {
    return null;
  }
}

function fetchIssueComments(repo, pr) {
  const raw = gh([
    "api",
    `repos/${repo}/issues/${pr}/comments`,
    "--jq",
    "[.[] | {user: .user.login, body: .body, created_at: .created_at, commit_id: .commit_id}]",
  ]);
  return JSON.parse(raw);
}

function fetchPullReviewComments(repo, pr) {
  // Inline diff comments (pulls endpoint, not issues)
  const raw = gh([
    "api",
    `repos/${repo}/pulls/${pr}/comments`,
    "--jq",
    "[.[] | {user: .user.login, body: .body, created_at: .created_at, commit_id: .commit_id}]",
  ]);
  return JSON.parse(raw);
}

function fetchPullReviews(repo, pr) {
  const raw = gh([
    "api",
    `repos/${repo}/pulls/${pr}/reviews`,
    "--jq",
    "[.[] | {user: .user.login, body: .body, state: .state, submitted_at: .submitted_at, commit_id: .commit_id}]",
  ]);
  return JSON.parse(raw);
}

function isStub(body, stubPatterns) {
  return stubPatterns.some((p) => p.test(body ?? ""));
}

export function isSubstantive(body) {
  // A substantive review has more than just HTML comments and stub messages
  const stripped = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (stripped.length <= 100) return false;
  return (
    /review|walkthrough|summary|finding|issue|bug|recommend|potential|security|severity|regression|no issues|no bugs|approved/i.test(
      stripped
    ) || /(?:^|\n)\s*(?:#{1,6}|[-*] |\d+[.)] |\|)/.test(stripped)
  );
}

export function hasVisibleReviewText(body) {
  // Inline review comments are findings attached to a specific diff location and are
  // often intentionally terse. Require visible human-readable text, but do not apply
  // the long-form summary threshold used for top-level comments and review bodies.
  const stripped = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (stripped.length < 8 || !/[\p{L}]/u.test(stripped)) return false;
  return /issue|bug|error|unsafe|risk|fix|change|rename|potential|consider|should|must|regression|finding|nit|why|incorrect|security|handle|null/i.test(
    stripped
  );
}

/**
 * Determine if a bot has posted a substantive signal after latestPush.
 * Checks only issue comments, inline PR comments, and submitted PR reviews. Check runs
 * are intentionally not evidence: they can complete successfully without review findings.
 */
export function checkBotReady(botUser, config, issueComments, pullComments, reviews, latestPush) {
  const boundary = latestPush instanceof Date ? latestPush : latestPush?.committedAt;
  const after = (dateStr) => {
    if (!boundary || !dateStr) return false;
    const at = new Date(dateStr);
    return Number.isFinite(at.getTime()) && at >= boundary;
  };
  const currentSha = (record) => !latestPush?.sha || record.commit_id === latestPush.sha;
  // Issue comments (the walkthrough summary) carry no commit_id, so in SHA mode they count
  // only when the RAW body references the current head (CodeRabbit embeds reviewed-commit
  // SHAs in its walkthrough markers/links). A 12+ hex-char prefix is unambiguous; anything
  // that does not reference the head is skipped — fail closed, never accept stale.
  const referencesHead = (body) => {
    if (!latestPush?.sha) return true; // timestamp-only fallback mode
    return String(body ?? "")
      .toLowerCase()
      .includes(String(latestPush.sha).toLowerCase().slice(0, 12));
  };

  // CodeRabbit issue comments (for example, the walkthrough summary)
  for (const c of issueComments) {
    if (c.user !== botUser) continue;
    if (!referencesHead(c.body)) continue;
    if (!after(c.created_at)) continue;
    if (isStub(c.body, config.stubPatterns)) continue;
    if (isSubstantive(c.body)) return { ready: true, signal: "issue-comment", preview: c.body };
  }

  // CodeRabbit inline PR review comments
  for (const c of pullComments) {
    if (c.user !== botUser) continue;
    if (!after(c.created_at)) continue;
    if (!currentSha(c)) continue;
    if (isStub(c.body, config.stubPatterns)) continue;
    if (hasVisibleReviewText(c.body)) {
      return { ready: true, signal: "inline-comment", preview: c.body };
    }
  }

  // PR reviews (submitted review objects)
  for (const r of reviews) {
    if (r.user !== botUser) continue;
    if (!after(r.submitted_at)) continue;
    if (!currentSha(r)) continue;
    if (isStub(r.body, config.stubPatterns)) continue;
    if (isSubstantive(r.body)) return { ready: true, signal: "review", preview: r.body };
  }

  return { ready: false };
}

function summarizeBot(botUser, result) {
  if (!result.ready) return `  ${botUser}: waiting…`;
  const preview = (result.preview ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, SUMMARY_LINES)
    .join(" | ")
    .slice(0, 200);
  return `  ${botUser} [${result.signal}]: ${preview || "(no preview)"}`;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pure exit-code decision for the timeout path (exported for tests).
 *   - no bot missing            → { code: 0, proceed: true }
 *   - bot missing, --any        → { code: 0, proceed: true }  (proceed anyway)
 *   - bot missing, default      → { code: 2, proceed: false } (require all)
 */
export function decideTimeoutExit({ proceedOnTimeout, missing }) {
  const anyMissing = (missing?.length ?? 0) > 0;
  if (!anyMissing) return { code: 0, proceed: true };
  return proceedOnTimeout ? { code: 0, proceed: true } : { code: 2, proceed: false };
}

// --- main ---

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      timeout: { type: "string", default: "10" },
      // May be repeated or comma-separated; validated via selectBots against BOT_CONFIG.
      bots: { type: "string", multiple: true },
      // Default is require-all (exit 2 on a missing bot); --require-all is a no-op alias.
      "require-all": { type: "boolean", default: false },
      any: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help || !values.pr) {
    usage();
    process.exit(values.help ? 0 : 1);
  }

  const prNumber = values.pr;
  const repo = values.repo ?? detectRepo();
  if (!repo) {
    console.error("error: could not detect repo — pass --repo owner/repo");
    process.exit(1);
  }

  const timeoutMin = Number(values.timeout);
  if (!Number.isFinite(timeoutMin) || timeoutMin < 0) {
    console.error("error: --timeout must be a non-negative number of minutes");
    process.exit(1);
  }
  const timeoutMs = timeoutMin * 60 * 1000;
  // Default: require all bots (exit 2 on a missing bot at timeout). --any restores the
  // old proceed-anyway behavior (exit 0). --require-all is accepted but is now the default.
  const proceedOnTimeout = values.any ?? false;
  let botUsers;
  try {
    botUsers = selectBots(BOT_CONFIG, values.bots);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }

  console.log(`Waiting for CodeRabbit review evidence on PR #${prNumber} (${repo})`);
  console.log(`Bot: ${botUsers.join(", ")}`);
  console.log(`Timeout: ${timeoutMin} min | Poll: ${POLL_INTERVAL_MS / 1000}s\n`);

  // No timestamp-only fallback: without the head SHA the gate cannot bind evidence to the
  // exact revision, so it fails closed rather than silently degrading to timestamps.
  const latestPush = getLatestPush(repo, prNumber);
  if (latestPush) {
    console.log(
      `Latest push: ${latestPush.committedAt.toISOString()} @ ${latestPush.sha.slice(0, 12)} (filtering stale evidence)\n`
    );
  } else {
    console.error(
      "error: latest PR commit timestamp is unavailable — cannot verify current-head CodeRabbit evidence"
    );
    process.exit(1);
  }

  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
    process.stdout.write(`[${elapsed}s] Polling (attempt ${attempt})… `);

    let issueComments, pullComments, reviews;
    try {
      [issueComments, pullComments, reviews] = await Promise.all([
        Promise.resolve(fetchIssueComments(repo, prNumber)),
        Promise.resolve(fetchPullReviewComments(repo, prNumber)),
        Promise.resolve(fetchPullReviews(repo, prNumber)),
      ]);
    } catch (e) {
      console.log(`fetch error: ${e.message}`);
      if (Date.now() + POLL_INTERVAL_MS < deadline) await sleep(POLL_INTERVAL_MS);
      continue;
    }

    const results = {};
    for (const [botUser, config] of Object.entries(BOT_CONFIG)) {
      results[botUser] = checkBotReady(
        botUser,
        config,
        issueComments,
        pullComments,
        reviews,
        latestPush
      );
    }

    const missing = botUsers.filter((b) => !results[b].ready);

    if (missing.length === 0) {
      console.log("CodeRabbit ready!\n");
      console.log("=== CodeRabbit review summary ===");
      for (const bot of botUsers) console.log(summarizeBot(bot, results[bot]));
      console.log("\nProceeding to findings consolidation.");
      process.exit(0);
    }

    console.log(`waiting for: ${missing.join(", ")}`);
    if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // Timeout — do a final check before giving up
  let issueComments, pullComments, reviews;
  try {
    [issueComments, pullComments, reviews] = await Promise.all([
      Promise.resolve(fetchIssueComments(repo, prNumber)),
      Promise.resolve(fetchPullReviewComments(repo, prNumber)),
      Promise.resolve(fetchPullReviews(repo, prNumber)),
    ]);
  } catch {
    issueComments = pullComments = reviews = [];
  }

  const finalResults = {};
  for (const [botUser, config] of Object.entries(BOT_CONFIG)) {
    finalResults[botUser] = checkBotReady(
      botUser,
      config,
      issueComments,
      pullComments,
      reviews,
      latestPush
    );
  }
  const finalMissing = botUsers.filter((b) => !finalResults[b].ready);
  const decision = decideTimeoutExit({ proceedOnTimeout, missing: finalMissing });

  if (finalMissing.length === 0) {
    console.log("\n[final-check] CodeRabbit posted just before timeout.\n");
    console.log("=== CodeRabbit review summary ===");
    for (const bot of botUsers) console.log(summarizeBot(bot, finalResults[bot]));
    console.log("\nProceeding to findings consolidation.");
    process.exit(decision.code);
  }

  const elapsed = Math.round(timeoutMs / 1000);
  console.log(`\n[timeout after ${elapsed}s] Still waiting for: ${finalMissing.join(", ")}`);
  console.log("=== CodeRabbit review summary (partial) ===");
  for (const bot of botUsers) console.log(summarizeBot(bot, finalResults[bot]));
  if (decision.proceed) {
    // --any: proceed despite missing CodeRabbit evidence.
    console.log("\nProceeding to findings consolidation without CodeRabbit evidence.");
  } else {
    // Default: CodeRabbit is missing — do NOT proceed. Exit 2 so the caller waits/retries.
    console.log(
      `\nNot proceeding: ${finalMissing.join(", ")} did not post in time (pass --any to override).`
    );
  }
  process.exit(decision.code);
}

// Only run main when invoked directly (so tests can import decideTimeoutExit).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
