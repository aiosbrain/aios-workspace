#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { isExactSha, stableDigest } from "./policy.mjs";

function argsFor(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--") || i + 1 >= argv.length) throw new Error(`bad argument: ${value}`);
    parsed[value.slice(2)] = argv[i + 1];
    i += 1;
  }
  return parsed;
}

async function liveHead(repository, branch, token) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "aios-debt-patrol/1",
        "x-github-api-version": "2022-11-28",
      },
    }
  );
  if (!response.ok) throw new Error(`github_http_${response.status}`);
  return (await response.json())?.object?.sha;
}

export function revalidatePatrol(input) {
  const checkedAt = new Date(input.checked_at ?? Date.now());
  const startedAt = new Date(input.started_at);
  const elapsedSeconds = Math.max(0, Math.ceil((checkedAt.getTime() - startedAt.getTime()) / 1000));
  const budgetSeconds = input.budget_minutes * 60;
  const reason_codes = [];
  if (!isExactSha(input.expected_sha)) reason_codes.push("invalid_expected_sha");
  if (!isExactSha(input.observed_sha)) reason_codes.push("head_revalidation_failed");
  else if (input.observed_sha !== input.expected_sha) reason_codes.push("moving_head_detected");
  if (!Number.isInteger(input.budget_minutes) || input.budget_minutes < 1) {
    reason_codes.push("invalid_budget");
  } else if (elapsedSeconds >= budgetSeconds) {
    reason_codes.push("scan_budget_exhausted");
  }
  const result = {
    schema_version: "1",
    repository: input.repository,
    default_branch: input.default_branch,
    expected_sha: input.expected_sha,
    observed_sha: isExactSha(input.observed_sha) ? input.observed_sha : null,
    exact_head: reason_codes.every(
      (code) =>
        !["invalid_expected_sha", "head_revalidation_failed", "moving_head_detected"].includes(code)
    ),
    started_at: startedAt.toISOString(),
    checked_at: checkedAt.toISOString(),
    elapsed_seconds: elapsedSeconds,
    budget_seconds: Number.isInteger(budgetSeconds) ? budgetSeconds : null,
    decision: reason_codes.length === 0 ? "run" : "stop",
    reason_codes,
  };
  return { ...result, revalidation_fingerprint: stableDigest(result) };
}

async function main() {
  const args = argsFor(process.argv.slice(2));
  for (const required of [
    "repository",
    "branch",
    "expected-sha",
    "started-at",
    "budget-minutes",
    "output",
  ]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  let observedSha = args["observed-sha"];
  if (args["observations-file"]) {
    const observations = JSON.parse(await readFile(args["observations-file"], "utf8"));
    observedSha = observations[args.repository]?.head_sha;
  }
  if (!observedSha) {
    const token = process.env[args["github-token-env"] ?? "GITHUB_TOKEN"];
    if (!token) throw new Error("GitHub token is required for live head revalidation");
    try {
      observedSha = await liveHead(args.repository, args.branch, token);
    } catch {
      observedSha = null;
    }
  }
  const result = revalidatePatrol({
    repository: args.repository,
    default_branch: args.branch,
    expected_sha: args["expected-sha"],
    observed_sha: observedSha,
    started_at: args["started-at"],
    budget_minutes: Number(args["budget-minutes"]),
  });
  await writeFile(args.output, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  if (result.decision !== "run") process.exitCode = 2;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
