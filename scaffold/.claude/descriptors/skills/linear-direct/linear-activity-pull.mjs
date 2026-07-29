#!/usr/bin/env node
/**
 * linear-activity-pull.mjs — assigned Linear issues → operator-loop activity.
 *
 * Reuses linear-query.mjs for API/auth, then performs only normalization and idempotent append.
 * Records are owner-private by default and intentionally carry no communication direction.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_TIER = "admin";
const TIERS = new Set(["admin", "team", "external"]);

function oneLine(value, max = 300) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function normalizeLinearIssues(data, tier = DEFAULT_TIER) {
  const issues = data?.viewer?.assignedIssues?.nodes;
  if (!Array.isArray(issues)) return [];

  return issues.flatMap((issue) => {
    const id = oneLine(issue?.id, 100);
    const identifier = oneLine(issue?.identifier, 40);
    const title = oneLine(issue?.title);
    const state = oneLine(issue?.state?.name, 80);
    const occurredAt =
      typeof issue?.updatedAt === "string" && Number.isFinite(Date.parse(issue.updatedAt))
        ? new Date(issue.updatedAt).toISOString()
        : null;
    if (!id || !identifier || !title || !state || !occurredAt) return [];

    return [
      {
        source: "linear",
        tier,
        occurredAt,
        ref: `linear:${id}:${occurredAt}`,
        summary: `Linear ${identifier} · ${state}: ${title}`,
        waitingOn: "me",
      },
    ];
  });
}

export function appendLinearActivity(activityPath, records, { dryRun = false } = {}) {
  const refs = new Set();
  if (existsSync(activityPath)) {
    for (const line of readFileSync(activityPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record?.ref === "string") refs.add(record.ref);
      } catch {
        // Other connectors own their malformed records; tolerate them and append safely.
      }
    }
  }

  const fresh = [];
  let skipped = 0;
  for (const record of records) {
    if (!record || typeof record.ref !== "string" || refs.has(record.ref)) {
      skipped++;
      continue;
    }
    refs.add(record.ref);
    fresh.push(record);
  }
  if (!dryRun && fresh.length) {
    mkdirSync(path.dirname(activityPath), { recursive: true });
    appendFileSync(activityPath, `${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
  return { written: fresh.length, skipped };
}

export function runLinearQuery(repo) {
  const queryScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "linear-query.mjs");
  const stdout = execFileSync(process.execPath, [queryScript, "--repo", repo], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(stdout);
}

export async function pullLinearActivity({
  repo,
  activityPath,
  tier = DEFAULT_TIER,
  dryRun = false,
  query = runLinearQuery,
}) {
  const root = path.resolve(repo);
  const inbox = existsSync(path.join(root, "1-inbox")) ? "1-inbox" : "01-intake";
  const target = activityPath
    ? path.resolve(activityPath)
    : path.join(root, inbox, "comms", "activity.jsonl");
  const data = await query(root);
  const records = normalizeLinearIssues(data, tier);
  const append = appendLinearActivity(target, records, { dryRun });
  return { records, ...append, activityPath: target };
}

function parseArgs(argv) {
  const value = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    repo: path.resolve(value("--repo", process.cwd())),
    tier: value("--tier", DEFAULT_TIER),
    activityPath: value("--activity-path"),
    dryRun: argv.includes("--dry-run"),
  };
}

export async function main(argv = process.argv.slice(2), { pull = pullLinearActivity } = {}) {
  const opts = parseArgs(argv);
  if (!TIERS.has(opts.tier)) throw new Error("--tier must be admin|team|external");
  const result = await pull(opts);
  console.log(
    `linear-activity-pull: ${opts.dryRun ? "would write" : "wrote"} ${result.written}, skipped ${result.skipped} -> ${path.relative(opts.repo, result.activityPath)}`
  );
  return result;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    console.error(`linear-activity-pull: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
