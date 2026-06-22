#!/usr/bin/env node
/**
 * wait-for-bots.mjs — block until async bot reviews have posted substantive feedback on a PR.
 *
 * Polls every 30s, checking both PR comments/reviews AND GitHub check runs, until
 * cursor[bot] (Bugbot) and coderabbitai[bot] (CodeRabbit) have both posted meaningful
 * signals after the PR's latest push. Rate-limit stubs and stale pre-push comments do
 * not satisfy the gate.
 *
 * Usage:
 *   node scripts/wait-for-bots.mjs --pr <number> [--repo owner/repo] [--timeout 10]
 *   node scripts/wait-for-bots.mjs --pr 44 --repo AIOS-alpha/aios-team-brain
 *
 * Can be invoked cross-repo — pass --repo explicitly to target any AIOS-alpha repo.
 *
 * Exit codes:
 *   0 — all bots posted substantive signals (or timeout reached with --require-all unset)
 *   1 — usage error
 *   2 — timeout reached and --require-all was set (bots did not post in time)
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const BOT_CONFIG = {
  "cursor[bot]": {
    // Satisfied by a non-stub issue comment OR a completed Bugbot check run
    checkNamePattern: /Bugbot/i,
    stubPatterns: [/usage limit reached/i, /couldn't run/i, /could not run/i],
  },
  "coderabbitai[bot]": {
    // Satisfied by a non-stub issue comment (walkthrough) or inline review
    checkNamePattern: /CodeRabbit/i,
    stubPatterns: [/rate limited/i, /review limit reached/i, /prepaid credits/i],
  },
};

const POLL_INTERVAL_MS = 30_000;
const SUMMARY_LINES = 4;

function usage() {
  console.error(
    [
      "",
      "wait-for-bots.mjs — poll until Bugbot + CodeRabbit post substantive PR feedback",
      "",
      "usage:",
      "  node scripts/wait-for-bots.mjs --pr <number> [--repo owner/repo] [--timeout 10]",
      "",
      "options:",
      "  --pr <n>          PR number (required)",
      "  --repo <slug>     owner/repo (default: detected from git remote)",
      "  --timeout <min>   max wait in minutes (default: 10)",
      "  --require-all     exit 2 if timeout reached before all bots posted (default: exit 0)",
      "",
      "Cross-repo: pass --repo explicitly, e.g. --repo AIOS-alpha/aios-team-brain",
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

function getLatestPushTime(repo, pr) {
  // Use the PR's updated_at as a proxy for the latest push — conservative lower bound.
  // More accurate: latest commit author date from the PR's commit list.
  try {
    const raw = gh(["api", `repos/${repo}/pulls/${pr}/commits`, "--jq", ".[-1].commit.author.date"]);
    return raw ? new Date(raw) : null;
  } catch {
    return null;
  }
}

function fetchIssueComments(repo, pr) {
  const raw = gh([
    "api", `repos/${repo}/issues/${pr}/comments`,
    "--jq", "[.[] | {user: .user.login, body: .body, created_at: .created_at}]",
  ]);
  return JSON.parse(raw);
}

function fetchPullReviewComments(repo, pr) {
  // Inline diff comments (pulls endpoint, not issues)
  const raw = gh([
    "api", `repos/${repo}/pulls/${pr}/comments`,
    "--jq", "[.[] | {user: .user.login, body: .body, created_at: .created_at}]",
  ]);
  return JSON.parse(raw);
}

function fetchPullReviews(repo, pr) {
  const raw = gh([
    "api", `repos/${repo}/pulls/${pr}/reviews`,
    "--jq", "[.[] | {user: .user.login, body: .body, state: .state, submitted_at: .submitted_at}]",
  ]);
  return JSON.parse(raw);
}

function fetchCheckRuns(repo, pr) {
  try {
    const sha = gh(["pr", "view", String(pr), "--repo", repo, "--json", "headRefOid", "--jq", ".headRefOid"]);
    if (!sha) return [];
    const raw = gh([
      "api", `repos/${repo}/commits/${sha}/check-runs`,
      "--jq", "[.check_runs[] | {name, status, conclusion, completed_at}]",
    ]);
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function isStub(body, stubPatterns) {
  return stubPatterns.some((p) => p.test(body ?? ""));
}

function isSubstantive(body) {
  // A substantive review has more than just HTML comments and stub messages
  const stripped = (body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped.length > 100;
}

/**
 * Determine if a bot has posted a substantive signal after latestPush.
 * Checks: issue comments, inline PR comments, PR reviews, and check runs.
 */
function checkBotReady(botUser, config, issueComments, pullComments, reviews, checkRuns, latestPush) {
  const after = (dateStr) => {
    if (!latestPush || !dateStr) return true; // no push time → don't filter
    return new Date(dateStr) > latestPush;
  };

  // Issue comments (e.g. CodeRabbit walkthrough, Bugbot summary)
  for (const c of issueComments) {
    if (c.user !== botUser) continue;
    if (!after(c.created_at)) continue;
    if (isStub(c.body, config.stubPatterns)) continue;
    if (isSubstantive(c.body)) return { ready: true, signal: "issue-comment", preview: c.body };
  }

  // Inline PR review comments (Bugbot + CodeRabbit both post here)
  for (const c of pullComments) {
    if (c.user !== botUser) continue;
    if (!after(c.created_at)) continue;
    if (isStub(c.body, config.stubPatterns)) continue;
    return { ready: true, signal: "inline-comment", preview: c.body };
  }

  // PR reviews (submitted review objects)
  for (const r of reviews) {
    if (r.user !== botUser) continue;
    if (!after(r.submitted_at)) continue;
    if (isStub(r.body, config.stubPatterns)) continue;
    return { ready: true, signal: "review", preview: r.body };
  }

  // GitHub check runs (Bugbot often completes as a check run with no comment)
  if (config.checkNamePattern) {
    for (const run of checkRuns) {
      if (!config.checkNamePattern.test(run.name)) continue;
      if (run.status !== "completed") continue;
      if (!after(run.completed_at)) continue;
      // neutral = intentional skip (config/docs-only PR) — counts as done
      if (run.conclusion === "success" || run.conclusion === "neutral") {
        return { ready: true, signal: `check-run:${run.conclusion}`, preview: run.name };
      }
    }
  }

  return { ready: false };
}

function summarizeBot(botUser, result, issueComments) {
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

// --- main ---

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    pr: { type: "string" },
    repo: { type: "string" },
    timeout: { type: "string", default: "10" },
    "require-all": { type: "boolean", default: false },
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

const timeoutMin = parseInt(values.timeout, 10) || 10;
const timeoutMs = timeoutMin * 60 * 1000;
const requireAll = values["require-all"] ?? false;
const botUsers = Object.keys(BOT_CONFIG);

console.log(`Waiting for bot reviews on PR #${prNumber} (${repo})`);
console.log(`Bots: ${botUsers.join(", ")}`);
console.log(`Timeout: ${timeoutMin} min | Poll: ${POLL_INTERVAL_MS / 1000}s\n`);

const latestPush = getLatestPushTime(repo, prNumber);
if (latestPush) {
  console.log(`Latest push: ${latestPush.toISOString()} (filtering stale pre-push comments)\n`);
} else {
  console.log("Latest push: unknown (not filtering by timestamp)\n");
}

const deadline = Date.now() + timeoutMs;
let attempt = 0;

while (Date.now() < deadline) {
  attempt++;
  const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
  process.stdout.write(`[${elapsed}s] Polling (attempt ${attempt})… `);

  let issueComments, pullComments, reviews, checkRuns;
  try {
    [issueComments, pullComments, reviews, checkRuns] = await Promise.all([
      Promise.resolve(fetchIssueComments(repo, prNumber)),
      Promise.resolve(fetchPullReviewComments(repo, prNumber)),
      Promise.resolve(fetchPullReviews(repo, prNumber)),
      Promise.resolve(fetchCheckRuns(repo, prNumber)),
    ]);
  } catch (e) {
    console.log(`fetch error: ${e.message}`);
    if (Date.now() + POLL_INTERVAL_MS < deadline) await sleep(POLL_INTERVAL_MS);
    continue;
  }

  const results = {};
  for (const [botUser, config] of Object.entries(BOT_CONFIG)) {
    results[botUser] = checkBotReady(botUser, config, issueComments, pullComments, reviews, checkRuns, latestPush);
  }

  const missing = botUsers.filter((b) => !results[b].ready);

  if (missing.length === 0) {
    console.log("all bots ready!\n");
    console.log("=== Bot review summaries ===");
    for (const bot of botUsers) console.log(summarizeBot(bot, results[bot], issueComments));
    console.log("\nProceeding to Code Reviewer.");
    process.exit(0);
  }

  console.log(`waiting for: ${missing.join(", ")}`);
  if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
  await sleep(POLL_INTERVAL_MS);
}

// Timeout — do a final check before giving up
let issueComments, pullComments, reviews, checkRuns;
try {
  [issueComments, pullComments, reviews, checkRuns] = await Promise.all([
    Promise.resolve(fetchIssueComments(repo, prNumber)),
    Promise.resolve(fetchPullReviewComments(repo, prNumber)),
    Promise.resolve(fetchPullReviews(repo, prNumber)),
    Promise.resolve(fetchCheckRuns(repo, prNumber)),
  ]);
} catch {
  issueComments = pullComments = reviews = checkRuns = [];
}

const finalResults = {};
for (const [botUser, config] of Object.entries(BOT_CONFIG)) {
  finalResults[botUser] = checkBotReady(botUser, config, issueComments, pullComments, reviews, checkRuns, latestPush);
}
const finalMissing = botUsers.filter((b) => !finalResults[b].ready);

if (finalMissing.length === 0) {
  console.log("\n[final-check] All bots posted just before timeout.\n");
  console.log("=== Bot review summaries ===");
  for (const bot of botUsers) console.log(summarizeBot(bot, finalResults[bot], issueComments));
  console.log("\nProceeding to Code Reviewer.");
  process.exit(0);
}

const elapsed = Math.round(timeoutMs / 1000);
console.log(`\n[timeout after ${elapsed}s] Still waiting for: ${finalMissing.join(", ")}`);
console.log("=== Bot review summaries (partial) ===");
for (const bot of botUsers) console.log(summarizeBot(bot, finalResults[bot], issueComments));
console.log("\nProceeding to Code Reviewer (some bot results may be missing).");
process.exit(requireAll ? 2 : 0);
