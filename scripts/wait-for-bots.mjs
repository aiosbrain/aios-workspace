#!/usr/bin/env node
/**
 * wait-for-bots.mjs — block until async bot reviews have posted on a GitHub PR.
 *
 * Polls every 30s until cursor[bot] (Bugbot) and coderabbitai[bot] (CodeRabbit)
 * have both posted PR comments, then prints a summary and exits 0.
 * Times out after --timeout minutes (default 10) and exits 0 anyway so the
 * builder is never permanently blocked by a silent bot.
 *
 * Usage:
 *   node scripts/wait-for-bots.mjs --pr <number> [--repo owner/repo] [--timeout 10]
 *   node scripts/wait-for-bots.mjs --pr 44 --repo AIOS-alpha/aios-team-brain
 *
 * Exit codes:
 *   0 — bots posted (or timeout reached — caller should still proceed)
 *   1 — usage error
 */

import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const BOT_USERS = ["cursor[bot]", "coderabbitai[bot]"];
const POLL_INTERVAL_MS = 30_000;
const SUMMARY_LINES = 3;

function usage() {
  console.error(
    [
      "",
      "wait-for-bots.mjs — poll until Bugbot + CodeRabbit post PR comments",
      "",
      "usage:",
      "  node scripts/wait-for-bots.mjs --pr <number> [--repo owner/repo] [--timeout 10]",
      "",
      "options:",
      "  --pr <n>          PR number (required)",
      "  --repo <slug>     owner/repo (default: detected from git remote)",
      "  --timeout <min>   max wait in minutes (default: 10)",
      "  --bots <list>     comma-separated bot usernames (default: cursor[bot],coderabbitai[bot])",
      "  --require-all     exit 2 if timeout reached before all bots posted (default: exit 0)",
    ].join("\n")
  );
}

function gh(args) {
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(`gh ${args.join(" ")} failed: ${e.stderr ?? e.message}`);
  }
}

function detectRepo() {
  try {
    let url = execFileSync("git", ["remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    url = url.replace(/^git@github\.com:/, "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
    return url;
  } catch {
    return null;
  }
}

function fetchComments(repo, pr) {
  const raw = gh([
    "api",
    `repos/${repo}/issues/${pr}/comments`,
    "--jq",
    '[.[] | {user: .user.login, body: .body, created_at: .created_at}]',
  ]);
  return JSON.parse(raw);
}

function fetchReviews(repo, pr) {
  const raw = gh([
    "api",
    `repos/${repo}/pulls/${pr}/reviews`,
    "--jq",
    '[.[] | {user: .user.login, body: .body, state: .state, submitted_at: .submitted_at}]',
  ]);
  return JSON.parse(raw);
}

function checkBotsPosted(comments, reviews, requiredBots) {
  const posted = new Set();
  for (const c of [...comments, ...reviews]) {
    if (requiredBots.includes(c.user)) posted.add(c.user);
  }
  return { posted, missing: requiredBots.filter((b) => !posted.has(b)) };
}

function summarizeBot(botUser, comments, reviews) {
  const items = [...comments, ...reviews]
    .filter((c) => c.user === botUser)
    .sort((a, b) => (a.created_at ?? a.submitted_at ?? "").localeCompare(b.created_at ?? b.submitted_at ?? ""));
  if (!items.length) return `  ${botUser}: (no comments)`;
  const latest = items[items.length - 1];
  const preview = (latest.body ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, SUMMARY_LINES)
    .join(" | ");
  const count = items.length;
  return `  ${botUser} (${count} comment${count === 1 ? "" : "s"}): ${preview.slice(0, 200)}${preview.length > 200 ? "…" : ""}`;
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
    bots: { type: "string" },
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
  console.error("error: could not detect repo from git remote — pass --repo owner/repo");
  process.exit(1);
}

const timeoutMin = parseInt(values.timeout, 10) || 10;
const timeoutMs = timeoutMin * 60 * 1000;
const requiredBots = values.bots ? values.bots.split(",").map((b) => b.trim()) : BOT_USERS;
const requireAll = values["require-all"] ?? false;

console.log(`Waiting for bot reviews on PR #${prNumber} (${repo})`);
console.log(`Bots: ${requiredBots.join(", ")}`);
console.log(`Timeout: ${timeoutMin} min | Poll: ${POLL_INTERVAL_MS / 1000}s\n`);

const deadline = Date.now() + timeoutMs;
let attempt = 0;

while (Date.now() < deadline) {
  attempt++;
  const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
  process.stdout.write(`[${elapsed}s] Polling (attempt ${attempt})… `);

  let comments, reviews;
  try {
    [comments, reviews] = await Promise.all([
      fetchComments(repo, prNumber),
      fetchReviews(repo, prNumber),
    ]);
  } catch (e) {
    console.log(`gh error: ${e.message}`);
    await sleep(POLL_INTERVAL_MS);
    continue;
  }

  const { missing } = checkBotsPosted(comments, reviews, requiredBots);

  if (missing.length === 0) {
    console.log("all bots posted!\n");
    console.log("=== Bot review summaries ===");
    for (const bot of requiredBots) {
      console.log(summarizeBot(bot, comments, reviews));
    }
    console.log("\nProceeding to Code Reviewer.");
    process.exit(0);
  }

  console.log(`waiting for: ${missing.join(", ")}`);
  if (Date.now() + POLL_INTERVAL_MS >= deadline) break;
  await sleep(POLL_INTERVAL_MS);
}

// Timeout — summarize what did land
const elapsed = Math.round(timeoutMs / 1000);
console.log(`\n[timeout after ${elapsed}s] Not all bots posted. Summarizing what landed:\n`);

let comments, reviews;
try {
  [comments, reviews] = await Promise.all([
    fetchComments(repo, prNumber),
    fetchReviews(repo, prNumber),
  ]);
  console.log("=== Bot review summaries (partial) ===");
  for (const bot of requiredBots) {
    console.log(summarizeBot(bot, comments, reviews));
  }
} catch {
  console.log("(could not fetch final state)");
}

console.log("\nProceeding to Code Reviewer (some bot results may be missing).");
process.exit(requireAll ? 2 : 0);
