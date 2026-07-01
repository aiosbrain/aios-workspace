#!/usr/bin/env node
/**
 * PR backlog report.
 *
 * Read-only triage for stale PR queues. Uses the GitHub CLI because agents already
 * use `gh` for repo operations, and GitHub-hosted runners include it by default.
 */
import { execFileSync } from "node:child_process";

const FAIL_STATES = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"]);
const PENDING_STATES = new Set(["PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED", ""]);
const IGNORE_CHECKS = new Set([
  "PR references a brain task",
  "Move referenced Linear issue(s) to In Review",
]);

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const repo = arg("--repo", process.env.GITHUB_REPOSITORY ?? null);
const limit = Number.parseInt(arg("--limit", "100"), 10);
const staleDays = Number.parseInt(arg("--stale-days", "7"), 10);
const json = process.argv.includes("--json");

if (!repo) {
  console.error(
    "usage: pr-backlog-report --repo <owner/repo> [--json] [--limit N] [--stale-days N]"
  );
  process.exit(1);
}

function gh(args, options = {}) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env, GH_PAGER: "" },
    ...options,
  });
}

function parsePrList() {
  const out = gh([
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,headRefName,author,createdAt,updatedAt,isDraft,mergeStateStatus,statusCheckRollup,url",
  ]);
  return JSON.parse(out);
}

function checkName(check) {
  return check.__typename === "StatusContext" ? check.context : check.name;
}

function checkState(check) {
  if (check.__typename === "StatusContext") return check.state ?? "";
  return check.conclusion || check.status || "";
}

function actionableChecks(pr) {
  return (pr.statusCheckRollup ?? []).filter((check) => !IGNORE_CHECKS.has(checkName(check)));
}

function ageDays(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return 0;
  return Math.floor((Date.now() - then) / 86_400_000);
}

function failureKindFromLog(log) {
  const s = log.toLowerCase();
  if (
    s.includes("package.json and package-lock.json") ||
    s.includes("invalid: lock file") ||
    /missing: .* from lock file/i.test(log)
  ) {
    return "lockfile-mismatch";
  }
  if (s.includes("eresolve") || s.includes("peer dependency") || s.includes("conflicting peer")) {
    return "peer-conflict";
  }
  if (s.includes("econnreset") || s.includes("network aborted")) {
    return "network-flake";
  }
  if (
    s.includes("format:check") ||
    s.includes("code style issues found") ||
    s.includes("prettier")
  ) {
    return "format";
  }
  return "unknown-failure";
}

function actionRunIds(detailsUrl) {
  const match = detailsUrl?.match(/actions\/runs\/(\d+)\/job\/(\d+)/);
  return match ? { runId: match[1], jobId: match[2] } : null;
}

function inspectFailure(check) {
  if (check.__typename !== "CheckRun") return null;
  const ids = actionRunIds(check.detailsUrl);
  if (!ids) return null;
  try {
    const log = gh(["run", "view", ids.runId, "--repo", repo, "--job", ids.jobId, "--log"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return failureKindFromLog(log);
  } catch {
    return "log-unavailable";
  }
}

function summarize(pr) {
  const checks = actionableChecks(pr);
  const states = checks.map(checkState);
  const failed = checks.filter((check) => FAIL_STATES.has(checkState(check)));
  const pending = states.some((state) => PENDING_STATES.has(state));
  const stale = ageDays(pr.updatedAt) >= staleDays;
  const failureKinds = [...new Set(failed.map(inspectFailure).filter(Boolean))];
  const bot = pr.author?.is_bot || pr.author?.login?.includes("dependabot");

  let bucket = "green";
  if (failed.length) bucket = "failing";
  else if (pending) bucket = "pending";
  else if (!bot || pr.isDraft) bucket = "needs-human-review";

  const closeCandidate =
    bot &&
    failureKinds.some((kind) => kind === "lockfile-mismatch" || kind === "peer-conflict") &&
    stale;

  return {
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? "unknown",
    url: pr.url,
    headRefName: pr.headRefName,
    updatedAt: pr.updatedAt,
    ageDays: ageDays(pr.updatedAt),
    stale,
    bucket,
    mergeState: pr.mergeStateStatus,
    failureKinds,
    closeCandidate,
    checkSummary: checks.map((check) => `${checkName(check)}:${checkState(check)}`),
  };
}

function mdCell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}

function renderMarkdown(rows) {
  const counts = rows.reduce((acc, row) => {
    acc[row.bucket] = (acc[row.bucket] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    "# PR Backlog Report",
    "",
    `Open PRs: ${rows.length}`,
    "",
    `Buckets: ${
      Object.entries(counts)
        .sort()
        .map(([k, v]) => `${k}=${v}`)
        .join(", ") || "none"
    }`,
    "",
    "| PR | Bucket | Age | Merge | Signals | Title |",
    "|---|---:|---:|---|---|---|",
  ];
  for (const row of rows) {
    const signals = [
      row.stale ? "stale" : "",
      row.closeCandidate ? "close-candidate" : "",
      ...row.failureKinds,
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `| [#${row.number}](${row.url}) | ${mdCell(row.bucket)} | ${row.ageDays}d | ${mdCell(
        row.mergeState
      )} | ${mdCell(signals || "-")} | ${mdCell(row.title)} |`
    );
  }
  lines.push("");
  lines.push("## Close Candidates");
  const close = rows.filter((row) => row.closeCandidate);
  if (!close.length) lines.push("");
  if (!close.length) lines.push("_None._");
  for (const row of close) lines.push(`- [#${row.number}](${row.url}) ${row.title}`);
  return lines.join("\n") + "\n";
}

const rows = parsePrList()
  .map(summarize)
  .sort((a, b) => {
    const order = { failing: 0, pending: 1, "needs-human-review": 2, green: 3 };
    return (order[a.bucket] ?? 9) - (order[b.bucket] ?? 9) || b.ageDays - a.ageDays;
  });

if (json) console.log(JSON.stringify(rows, null, 2));
else process.stdout.write(renderMarkdown(rows));
