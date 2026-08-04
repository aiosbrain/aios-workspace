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
 * context is therefore `review-evidence` (see STATUS_CONTEXT).
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
 *     [--target-url <url>]            deep link recorded on the status
 *     [--no-status]                   evaluate and report only; post nothing (local dry run)
 */
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { EXEMPTION_MARKER, evaluateReviewEvidence, STATUS_CONTEXT } from "./review-evidence.mjs";

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
  const flags = new Set(["no-status"]);
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
 * Step one, on its own, and deliberately the smallest possible request: identify the commit
 * this run is judging. Everything after this point can fail, and every one of those failures
 * has to be publishable AS a failure against this SHA — otherwise an error after the head was
 * known posts nothing and a SHA that went green on an earlier run silently stays green while
 * its evidence is gone. Resolving the head first is what makes "indeterminate is red" true
 * rather than aspirational.
 */
export async function resolvePullRequestHead(repo, number, headShaOverride) {
  const pull = await request(repoPath(repo, "pulls", number));
  const headSha = headShaOverride || pull.head?.sha;
  if (!headSha) throw new Error("PR head SHA is unavailable");
  return { headSha };
}

// Exemptions are comments now, not labels, so there is exactly one thing to gather: everything
// somebody said on this PR, and whether they had write access when they said it. The label
// predicate, the timeline fetch and the `labeled`-event ordering are gone with the redesign —
// see validateExemptionBody in scripts/review-evidence/selection.mjs for why.
export async function gatherPullRequestFacts(repo, number, head) {
  const { headSha } = head;

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
  return { headSha, comments };
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
      "",
      `A PR that genuinely needs no adversarial review is exempted the same way — same binding,`,
      `different token — with a comment of:`,
      "",
      "```",
      "## Exemption",
      "- <why this PR does not need an adversarial review>",
      "## Verification",
      `- Exempt at ${headSha ?? "<head sha>"}`,
      "",
      EXEMPTION_MARKER,
      "```",
      "",
      "Docs: docs/pr-review-evidence.md."
    );
  }
  return lines.join("\n");
}

/**
 * Publish the verdict, retrying a few times with backoff.
 *
 * This is the one thing the gate cannot make safe. The status IS the protected context, so a run
 * that decides "red" and then cannot write it leaves whatever was published last standing — and
 * if an earlier attestation went green on this same SHA, branch protection still sees green. We
 * cannot publish red when publishing is what failed. So: retry, and if it still fails, be
 * impossible to miss about it rather than exiting quietly non-zero. The residual is documented in
 * docs/pr-review-evidence.md under "Known limits" instead of being left implied.
 */
export async function postStatus(repo, headSha, verdict, targetUrl, options = {}) {
  const { attempts = 4, backoffMs = 1000, sleep = defaultSleep } = options;
  if (!/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("refusing to post a status against a value that is not a commit SHA");
  }
  const payload = {
    method: "POST",
    body: {
      state: verdict.ok ? "success" : "failure",
      context: STATUS_CONTEXT,
      description: verdict.summary.slice(0, 140),
      ...(targetUrl ? { target_url: targetUrl } : {}),
    },
  };
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await request(repoPath(repo, "statuses", headSha), payload);
      return attempt;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Exported so a test can drive the whole path — including the status write — against a
 * stubbed API. Returns what it decided and what it published; the CLI wrapper below is the
 * only thing that touches process state.
 */
export async function run(argv, { statusOptions } = {}) {
  const args = parseArgs(argv);
  const repo = args.repo;
  const number = args.pr;

  // ---- step 1: identify the commit under judgement, and nothing else ----
  let head;
  let headSha;
  let verdict;
  try {
    head = await resolvePullRequestHead(repo, number, args["head-sha"]);
    headSha = head.headSha;
  } catch (error) {
    // No head means there is nothing to attach a status to. The required context stays
    // PENDING, which is still unmergeable — the one fail-closed state we cannot improve on.
    verdict = gateError(error);
  }

  // ---- step 2: everything that can fail, now that a failure is publishable ----
  if (head) {
    try {
      verdict = evaluateReviewEvidence(await gatherPullRequestFacts(repo, number, head));
    } catch (error) {
      // Indeterminate is FAIL, and — because the head is already known — a PUBLISHED fail.
      // This is what turns an already-green SHA red when its evidence stops being valid.
      verdict = gateError(error);
    }
  }

  const report = renderReport(verdict, { repo, number, headSha });
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
  }

  if (args["no-status"]) return { verdict, headSha, published: false };
  if (!headSha) {
    console.error(
      "::error::Head SHA is unknown, so no status could be posted. The required " +
        `'${STATUS_CONTEXT}' context stays pending and the PR stays blocked.`
    );
    return { verdict, headSha, published: false, failed: true };
  }
  try {
    await postStatus(repo, headSha, verdict, args["target-url"], statusOptions);
  } catch (error) {
    announceUnpublishedVerdict(headSha, verdict, error);
    return { verdict, headSha, published: false, failed: true };
  }
  return { verdict, headSha, published: true };
}

/**
 * The loudest thing a workflow run can say. A silent non-zero exit here would be indistinguishable
 * from any other red job, and the point is that the RUN is red while the protected CONTEXT may not
 * be — the one state where the gate's verdict and the branch rule disagree.
 */
function announceUnpublishedVerdict(headSha, verdict, error) {
  const stale = verdict.ok ? "" : " AND THE PREVIOUS STATUS, IF ANY, STILL STANDS";
  const lines = [
    `::error title=review-evidence status NOT published::After several attempts GitHub would not accept the ${STATUS_CONTEXT} status for ${headSha}. This run decided "${forLog(verdict.summary)}"${stale}. Do not merge on the strength of a green ${STATUS_CONTEXT} until a later run publishes one. Last error: ${forLog(error.message)}`,
    `::error::Re-run this workflow. If it keeps failing, the branch rule is protecting a context nobody can currently write.`,
  ];
  for (const line of lines) console.error(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "",
        `### ⚠️ ${STATUS_CONTEXT} status NOT published`,
        "",
        `The gate decided **${forLog(verdict.summary)}** for \`${headSha}\` and could not write it.`,
        "Whatever status was published last is what branch protection can see. Re-run this workflow.",
        "",
      ].join("\n")
    );
  }
}

function gateError(error) {
  return {
    ok: false,
    kind: "error",
    summary: `Gate error: ${forLog(error.message)}`,
    rejected: [],
  };
}

async function main() {
  const outcome = await run(process.argv.slice(2));
  process.exitCode = outcome.failed || !outcome.verdict.ok ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
