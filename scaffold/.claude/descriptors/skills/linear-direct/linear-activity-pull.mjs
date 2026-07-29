#!/usr/bin/env node
/**
 * linear-activity-pull.mjs — assigned Linear issues → operator-loop activity.
 *
 * Reuses linear-query.mjs for API/auth, then performs only normalization and idempotent append.
 * Records are owner-private by default and intentionally carry no communication direction.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { queryAssignedOpenIssuesForRepo } from "./linear-query.mjs";

const DEFAULT_TIER = "admin";
const TIERS = new Set(["admin", "team", "external"]);

function oneLine(value, max = 300) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function normalizeLinearIssues(
  data,
  { tier = DEFAULT_TIER, observedAt = new Date().toISOString() } = {}
) {
  const issues = data?.viewer?.assignedIssues?.nodes;
  if (!Array.isArray(issues)) return [];
  const observation = new Date(observedAt);
  if (Number.isNaN(observation.valueOf())) throw new Error("invalid observation time");
  const occurredAt = observation.toISOString();
  const observationDay = occurredAt.slice(0, 10);

  return issues.flatMap((issue) => {
    const id = oneLine(issue?.id, 100);
    const identifier = oneLine(issue?.identifier, 40);
    const title = oneLine(issue?.title);
    const state = oneLine(issue?.state?.name, 80);
    const updatedAt =
      typeof issue?.updatedAt === "string" && Number.isFinite(Date.parse(issue.updatedAt))
        ? new Date(issue.updatedAt).toISOString()
        : null;
    if (!id || !identifier || !title || !state || !updatedAt) return [];

    return [
      {
        source: "linear",
        tier,
        occurredAt,
        ref: `linear:${id}`,
        revision: `${updatedAt}@${observationDay}`,
        active: true,
        summary: `Linear ${identifier} · ${state}: ${title}`,
        waitingOn: "me",
      },
    ];
  });
}

export function appendLinearActivity(activityPath, records, { dryRun = false } = {}) {
  const latestRevision = new Map();
  if (existsSync(activityPath)) {
    for (const line of readFileSync(activityPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (typeof record?.ref === "string" && typeof record?.revision === "string") {
          latestRevision.set(record.ref, record.revision);
        }
      } catch {
        // Other connectors own their malformed records; tolerate them and append safely.
      }
    }
  }

  const fresh = [];
  let skipped = 0;
  for (const record of records) {
    const ref = record && typeof record.ref === "string" ? record.ref : null;
    const revision = record && typeof record.revision === "string" ? record.revision : null;
    if (!ref || !revision || latestRevision.get(ref) === revision) {
      skipped++;
      continue;
    }
    latestRevision.set(ref, revision);
    fresh.push(record);
  }
  if (!dryRun && fresh.length) {
    mkdirSync(path.dirname(activityPath), { recursive: true });
    appendFileSync(activityPath, `${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }
  return { written: fresh.length, skipped };
}

export function loadLatestLinearRecords(activityPath) {
  const latest = new Map();
  if (!existsSync(activityPath)) return latest;
  for (const line of readFileSync(activityPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.source === "linear" && typeof record.ref === "string") {
        latest.set(record.ref, record);
      }
    } catch {
      // The comms source owns malformed-line reporting.
    }
  }
  return latest;
}

function tombstonesForMissing(activityPath, current, observedAt, tier) {
  const currentRefs = new Set(current.map((record) => record.ref));
  const observationDay = observedAt.slice(0, 10);
  return [...loadLatestLinearRecords(activityPath).values()].flatMap((record) => {
    if (record.active !== true || currentRefs.has(record.ref)) return [];
    return [
      {
        source: "linear",
        tier: typeof record.tier === "string" ? record.tier : tier,
        occurredAt: observedAt,
        ref: record.ref,
        revision: `absent@${observationDay}`,
        active: false,
        summary: record.summary,
      },
    ];
  });
}

export function runLinearQuery(repo) {
  return queryAssignedOpenIssuesForRepo(repo);
}

export async function pullLinearActivity({
  repo,
  activityPath,
  tier = DEFAULT_TIER,
  dryRun = false,
  query = runLinearQuery,
  now = new Date(),
}) {
  const root = path.resolve(repo);
  const inbox = existsSync(path.join(root, "1-inbox")) ? "1-inbox" : "01-intake";
  const target = activityPath
    ? path.resolve(activityPath)
    : path.join(root, inbox, "comms", "activity.jsonl");
  const data = await query(root);
  const observedAt = now.toISOString();
  const current = normalizeLinearIssues(data, { tier, observedAt });
  const records = [...current, ...tombstonesForMissing(target, current, observedAt, tier)];
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
