#!/usr/bin/env node
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { buildPatrolPlan, validatePatrolConfig } from "./policy.mjs";

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

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "aios-debt-patrol/1",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error(`github_http_${response.status}`);
  return response.json();
}

export async function observeTarget(target, token) {
  try {
    const repo = await githubJson(`https://api.github.com/repos/${target.repository}`, token);
    const branch = encodeURIComponent(target.default_branch);
    const [ref, pulls] = await Promise.all([
      githubJson(
        `https://api.github.com/repos/${target.repository}/git/ref/heads/${branch}`,
        token
      ),
      githubJson(
        `https://api.github.com/repos/${target.repository}/pulls?state=open&per_page=${Math.min(
          target.open_pr_cap + 1,
          100
        )}`,
        token
      ),
    ]);
    return {
      default_branch: repo.default_branch,
      head_sha: ref?.object?.sha,
      open_pr_count: pulls.length,
    };
  } catch (error) {
    const code = /^github_http_\d+$/.test(error.message)
      ? error.message
      : "github_observation_failed";
    return { error_code: code };
  }
}

async function main() {
  const args = argsFor(process.argv.slice(2));
  if (!args.config || !args.output || !args.event) {
    throw new Error("usage: plan.mjs --config FILE --output FILE --event EVENT [options]");
  }
  const config = validatePatrolConfig(JSON.parse(await readFile(args.config, "utf8")));
  let observations;
  if (args.observations) {
    observations = JSON.parse(await readFile(args.observations, "utf8"));
  } else {
    const token = process.env[args["github-token-env"] ?? "GITHUB_TOKEN"];
    if (!token) throw new Error("GitHub token is required for live head resolution");
    observations = Object.fromEntries(
      await Promise.all(
        config.targets.map(async (target) => [
          target.repository,
          await observeTarget(target, token),
        ])
      )
    );
  }
  const plan = buildPatrolPlan(
    config,
    {
      event_name: args.event,
      event_schedule: args.schedule || null,
      requested_repository: args.repository || null,
      workflow_ref: args["workflow-ref"] || null,
      producer_enabled: args.enabled === "1",
      producer_unpaused: args.paused === "0",
    },
    observations
  );
  await writeFile(args.output, `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
  if (args["github-output"]) {
    await appendFile(
      args["github-output"],
      `matrix=${JSON.stringify(plan.matrix)}\nhas_runs=${plan.matrix.include.length > 0}\n`
    );
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
