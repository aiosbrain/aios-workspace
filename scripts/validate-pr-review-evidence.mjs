#!/usr/bin/env node
/**
 * validate-pr-review-evidence.mjs — the per-PR review-evidence gate (AIO-777).
 *
 * Resolves everything `evaluateReviewEvidence` needs from the GitHub API, runs the
 * decision, and publishes the verdict as a COMMIT STATUS on the PR head SHA.
 *
 * Why a commit status and not just the job's own check run: the gate has to re-evaluate
 * when an evidence comment is posted, and `issue_comment` workflow runs are attributed to
 * the default branch's SHA, not the PR head — their check runs never land on the PR. A
 * status posted explicitly against `head.sha` does, from any trigger. The protected
 * context is therefore `review-evidence` (see EXEMPTION_LABEL/STATUS_CONTEXT).
 *
 * FAIL CLOSED, in three layers:
 *   1. Any error while gathering facts becomes a `failure` status, not a skip.
 *   2. If the process dies before it can post anything, no status exists for that SHA, so
 *      the required context stays *pending* and the PR stays unmergeable.
 *   3. A new commit is a new SHA with no status at all — so evidence cannot outlive the
 *      commit it described. That staleness is the entire mechanism.
 *
 * Usage:
 *   node scripts/validate-pr-review-evidence.mjs --repo owner/name --pr 123
 *     [--head-sha <sha>]              trust an explicit head (workflow passes the event's)
 *     [--clear-exemption-on-push]     remove the exemption label (used on `synchronize`)
 *     [--target-url <url>]            deep link recorded on the status
 *     [--no-status]                   evaluate and report only; post nothing (local dry run)
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { evaluateReviewEvidence, EXEMPTION_LABEL, STATUS_CONTEXT } from "./review-evidence.mjs";

const API = process.env.GITHUB_API_URL || "https://api.github.com";
// A cap, not a window: overflowing it throws rather than judging a truncated comment list.
// Silently evaluating page 1 of 40 would be the fail-open this whole gate exists to avoid.
const MAX_PAGES = 20;
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Neutralise anything that reaches a log line or the job summary. GitHub Actions treats a
 * line beginning `::` as a workflow command, and this gate echoes strings it does not
 * control — HTTP response bodies, comment authors, validator messages. Without this, a
 * hostile response body could forge annotations (or an `::add-mask::`) in our own run log.
 */
export function forLog(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/::/g, ": :")
    .slice(0, 500);
}

export function parseArgs(argv) {
  const flags = new Set(["clear-exemption-on-push", "no-status"]);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`);
    const key = name.slice(2);
    if (flags.has(key)) {
      values[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    values[key] = value;
    index += 1;
  }
  for (const required of ["repo", "pr"]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  // Strict, not merely "has a slash": every path this builds is interpolated into a GitHub
  // API URL, so an owner or name that could contain `.`/`..`/`%`/`?` would let a caller
  // redirect the request at a different endpoint. Anchored to GitHub's real owner/repo
  // charset, and each segment must start alphanumerically so `.` and `..` cannot appear.
  if (!/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(values.repo)) {
    throw new Error("--repo must be owner/name");
  }
  if (!/^\d+$/.test(values.pr)) throw new Error("--pr must be a number");
  return values;
}

/**
 * Build a repository API path with every segment percent-encoded. Paths are never
 * interpolated raw: `repoPath` is the only way this file names a GitHub resource, so no
 * caller-supplied value can escape its segment and re-point the request.
 */
function repoPath(repo, ...segments) {
  return `/repos/${[...repo.split("/"), ...segments].map((part) => encodeURIComponent(String(part))).join("/")}`;
}

async function request(pathname, { method = "GET", body } = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GH_TOKEN is not set — the gate cannot read this PR");
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aios-pr-review-evidence-gate",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = body ? `: ${body.slice(0, 200)}` : "";
    const error = new Error(
      `GitHub ${method} ${pathname} failed with HTTP ${response.status}${detail}`
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function paginate(pathname) {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = pathname.includes("?") ? "&" : "?";
    const batch = await request(`${pathname}${separator}per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`GitHub GET ${pathname} did not return a list`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new Error(
    `GET ${pathname} exceeded ${MAX_PAGES} pages — refusing to judge a truncated list`
  );
}

/**
 * Does `login` have push access? A 404 is a determinate "no" (not a collaborator); every
 * other failure is indeterminate and must propagate, because an unknown answer is a red
 * gate, not an implicit deny that reads like a well-understood rejection.
 */
async function hasWriteAccess(repo, login, cache) {
  if (cache.has(login)) return cache.get(login);
  let authorized = false;
  try {
    const result = await request(repoPath(repo, "collaborators", login, "permission"));
    authorized = WRITE_PERMISSIONS.has(result?.permission);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  cache.set(login, authorized);
  return authorized;
}

/**
 * The exemption is a LABEL, and GitHub already restricts labelling to users with write
 * access — so the label's presence *is* the authorisation. What it does not carry by
 * itself is attribution, so the `labeled` timeline event is required: an exemption nobody
 * can be named for is theatre, and the gate fails rather than granting it.
 */
async function resolveExemption(repo, number, labels) {
  if (!labels.includes(EXEMPTION_LABEL)) return null;
  const timeline = await paginate(repoPath(repo, "issues", number, "timeline"));
  const labelled = timeline.filter(
    (event) => event.event === "labeled" && event.label?.name === EXEMPTION_LABEL
  );
  const actor = labelled.at(-1)?.actor?.login;
  if (!actor) throw new Error(`${EXEMPTION_LABEL} is set but no 'labeled' event attributes it`);
  return { label: EXEMPTION_LABEL, actor };
}

export async function gatherPullRequestFacts(repo, number, options = {}) {
  const pull = await request(repoPath(repo, "pulls", number));
  const headSha = options.headSha || pull.head?.sha;
  if (!headSha) throw new Error("PR head SHA is unavailable");
  const labels = (pull.labels || []).map((label) => label.name);

  if (options.clearExemptionOnPush && labels.includes(EXEMPTION_LABEL)) {
    // A push must invalidate an exemption exactly as it invalidates evidence, or the
    // exemption becomes the hole: label a docs typo, then push real code into it.
    // Removing the label is itself a timeline event, so the reset is auditable too.
    await request(repoPath(repo, "issues", number, "labels", EXEMPTION_LABEL), {
      method: "DELETE",
    });
    labels.splice(labels.indexOf(EXEMPTION_LABEL), 1);
  }

  const exemption = await resolveExemption(repo, number, labels);
  if (exemption) return { headSha, comments: [], exemption };

  const [issueComments, reviews] = await Promise.all([
    paginate(repoPath(repo, "issues", number, "comments")),
    paginate(repoPath(repo, "pulls", number, "reviews")),
  ]);
  const raw = [
    ...issueComments.map((comment) => ({
      url: comment.html_url,
      author: comment.user?.login,
      body: comment.body,
    })),
    ...reviews.map((review) => ({
      url: review.html_url,
      author: review.user?.login,
      body: review.body,
    })),
  ];
  const cache = new Map();
  const comments = [];
  for (const comment of raw) {
    if (!comment.author) continue;
    comments.push({
      ...comment,
      authorized: await hasWriteAccess(repo, comment.author, cache),
    });
  }
  return { headSha, comments, exemption: null };
}

export function renderReport(verdict, { repo, number, headSha }) {
  const lines = [
    `### Review evidence — ${verdict.ok ? "PASS" : "FAIL"}`,
    "",
    `- PR: ${repo}#${number}`,
    `- Head SHA: \`${headSha ?? "unknown"}\``,
    `- Verdict: ${forLog(verdict.summary)}`,
  ];
  if (verdict.rejected?.length) {
    lines.push("", "Rejected candidate attestations:");
    for (const item of verdict.rejected) {
      lines.push(`- ${forLog(item.url)} (@${forLog(item.author)}): ${forLog(item.reason)}`);
    }
  }
  if (!verdict.ok) {
    lines.push(
      "",
      "To turn this green, post a comment on the PR in exactly this shape (a reviewer with",
      "write access must post it, and it must name the CURRENT head SHA):",
      "",
      "```",
      "## Findings",
      "- <what you looked for and what you found; 'no reportable findings' is a legitimate line>",
      "## Mergeability",
      "- Ready to merge",
      "## Open Questions",
      "- <or 'none'>",
      "## Verification",
      `- Reviewed at ${headSha ?? "<head sha>"}`,
      "",
      "MERGE_READY",
      "```",
      "",
      `Docs: docs/pr-review-evidence.md. Exempt a trivial PR with the \`${EXEMPTION_LABEL}\` label.`
    );
  }
  return lines.join("\n");
}

async function postStatus(repo, headSha, verdict, targetUrl) {
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("refusing to post a status against a value that is not a commit SHA");
  }
  await request(repoPath(repo, "statuses", headSha), {
    method: "POST",
    body: {
      state: verdict.ok ? "success" : "failure",
      context: STATUS_CONTEXT,
      description: verdict.summary.slice(0, 140),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    },
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = args.repo;
  const number = args.pr;
  let headSha = args["head-sha"];
  let verdict;
  try {
    const facts = await gatherPullRequestFacts(repo, number, {
      headSha,
      clearExemptionOnPush: args["clear-exemption-on-push"],
    });
    headSha = facts.headSha;
    verdict = evaluateReviewEvidence(facts);
  } catch (error) {
    // Indeterminate is FAIL. A gate that goes green when it cannot answer is the bug class.
    verdict = {
      ok: false,
      kind: "error",
      summary: `Gate error: ${forLog(error.message)}`,
      rejected: [],
    };
  }

  const report = renderReport(verdict, { repo, number, headSha });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }

  if (!args["no-status"]) {
    if (!headSha) {
      console.error(
        "::error::Head SHA is unknown, so no status could be posted. The required " +
          `'${STATUS_CONTEXT}' context stays pending and the PR stays blocked.`
      );
      process.exitCode = 1;
      return;
    }
    try {
      await postStatus(repo, headSha, verdict, args["target-url"]);
    } catch (error) {
      console.error(
        `::error::Could not publish the ${STATUS_CONTEXT} status: ${forLog(error.message)}`
      );
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
