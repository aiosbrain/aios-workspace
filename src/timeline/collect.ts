// Timeline collector (AIO-205) — multi-repo merged PRs (`gh pr list`) + raw commits (`git log`).
//
// Every item inherits its repo's configured tier (config.ts, default-deny). A repo whose
// remote `gh` can't see — or a machine with no `gh` at all — degrades gracefully to
// commit-only data with the error recorded on the result, never a crash.

import { execFileSync } from "node:child_process";
import type {
  TimelineCommit,
  TimelineData,
  TimelinePr,
  TimelineRepoConfig,
  TimelineRepoResult,
} from "./types.js";

/** Injectable command runner (tests stub this). Must throw on non-zero exit or timeout. */
export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
) => string;

export const execRunner: Runner = (cmd, args, opts) =>
  execFileSync(cmd, args, {
    cwd: opts?.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
    // Undefined → no timeout. Callers wrap browser/network commands with explicit budgets so
    // one hung page (e.g. an auth-gated Vercel preview) can never stall a whole run.
    timeout: opts?.timeoutMs,
  });

/** Derive a GitHub login from a `users.noreply.github.com` author email, else null. */
export function loginFromEmail(email: string): string | null {
  const m = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/.exec(email.trim());
  return m ? (m[1] ?? null) : null;
}

const FIELD_SEP = "\x1f"; // ASCII unit separator - never appears in commit subjects/emails

function collectCommits(
  repo: TimelineRepoConfig,
  since: string,
  until: string,
  runner: Runner
): TimelineCommit[] {
  const out = runner(
    "git",
    [
      "log",
      `--since=${since}`,
      `--until=${until}`,
      "--no-merges",
      `--pretty=format:%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%aI${FIELD_SEP}%s`,
    ],
    { cwd: repo.path }
  );
  const commits: TimelineCommit[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [sha, authorName, authorEmail, authoredAt, subject] = line.split(FIELD_SEP);
    if (!sha || !authoredAt) continue;
    commits.push({
      repo: repo.alias,
      tier: repo.tier,
      sha,
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorLogin: loginFromEmail(authorEmail ?? ""),
      authoredAt,
      subject: subject ?? "",
    });
  }
  return commits;
}

interface GhPrRow {
  number?: unknown;
  title?: unknown;
  author?: { login?: unknown } | null;
  mergedAt?: unknown;
  url?: unknown;
  additions?: unknown;
  deletions?: unknown;
  changedFiles?: unknown;
}

function collectPrs(
  repo: TimelineRepoConfig,
  since: string,
  until: string,
  runner: Runner
): TimelinePr[] {
  const sinceDay = since.slice(0, 10);
  const out = runner(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--limit",
      "200",
      "--search",
      `merged:>=${sinceDay}`,
      "--json",
      "number,title,author,mergedAt,url,additions,deletions,changedFiles",
    ],
    { cwd: repo.path }
  );
  const rows = JSON.parse(out) as GhPrRow[];
  const sinceMs = Date.parse(since);
  const untilMs = Date.parse(until);
  const prs: TimelinePr[] = [];
  for (const row of rows) {
    const mergedAt = typeof row.mergedAt === "string" ? row.mergedAt : null;
    if (!mergedAt || typeof row.number !== "number") continue;
    const t = Date.parse(mergedAt);
    if (!Number.isFinite(t) || t < sinceMs || t > untilMs) continue;
    const pr: TimelinePr = {
      repo: repo.alias,
      tier: repo.tier,
      number: row.number,
      title: typeof row.title === "string" ? row.title : "(untitled)",
      author: typeof row.author?.login === "string" ? row.author.login : null,
      mergedAt,
      url: typeof row.url === "string" ? row.url : "",
    };
    if (typeof row.additions === "number") pr.additions = row.additions;
    if (typeof row.deletions === "number") pr.deletions = row.deletions;
    if (typeof row.changedFiles === "number") pr.changedFiles = row.changedFiles;
    prs.push(pr);
  }
  return prs.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
}

/**
 * Collect one repo. Commits are the baseline (a git failure IS an error — the path isn't a
 * repo); merged-PR metadata is best-effort (`gh` missing, unauthenticated, or a remote it
 * can't see degrade to commit-only with `ghError` set).
 */
export function collectRepo(
  repo: TimelineRepoConfig,
  since: string,
  until: string,
  runner: Runner = execRunner
): TimelineRepoResult {
  const commits = collectCommits(repo, since, until, runner);
  let prs: TimelinePr[] = [];
  let ghError: string | null = null;
  try {
    prs = collectPrs(repo, since, until, runner);
  } catch (e) {
    ghError = (e as Error).message?.split("\n")[0] ?? "gh failed";
  }
  // Drop commits that belong to a collected merged PR's squash (same subject `(#N)` suffix) —
  // keeps the render from double-counting a PR and its squash commit.
  const prNumbers = new Set(prs.map((p) => p.number));
  const filteredCommits = commits.filter((commitRow) => {
    const m = /\(#(\d+)\)\s*$/.exec(commitRow.subject);
    return !(m && m[1] && prNumbers.has(Number(m[1])));
  });
  return { repo, prs, commits: filteredCommits, ghError };
}

export function collectTimeline(
  repos: TimelineRepoConfig[],
  since: string,
  until: string,
  runner: Runner = execRunner,
  now: Date = new Date()
): TimelineData {
  return {
    generatedAt: now.toISOString(),
    since,
    until,
    repos: repos.map((r) => collectRepo(r, since, until, runner)),
  };
}
