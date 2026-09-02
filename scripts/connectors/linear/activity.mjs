// `aios linear activity [pull]` — assigned Linear issues → operator-loop activity
// (AIO-1072, ported from the retired linear-direct descriptor adapter).
//
// Reuses the adapter's own query verb (query.mjs → core.mjs gql, credential resolved by
// the index.mjs preflight) and performs only normalization and idempotent append.
// Records are owner-private (`admin`) by default and intentionally carry no
// communication direction. CLI flags and the output line keep the shape the descriptor
// adapter had, so operator-loop parsing is unchanged:
//
//   aios linear activity pull [--repo PATH] [--tier admin|team|external]
//                             [--activity-path PATH] [--dry-run]
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fail } from "./core.mjs";
import { queryAssignedOpenIssues } from "./query.mjs";

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

function linearStateKey(record) {
  if (typeof record?.ref !== "string" || typeof record?.revision !== "string") return null;
  const active = record.active === true ? "1" : record.active === false ? "0" : "";
  const tier = typeof record.tier === "string" ? record.tier : "";
  return `${record.revision}\0${active}\0${tier}`;
}

export function appendLinearActivity(activityPath, records, { dryRun = false } = {}) {
  const latestState = new Map();
  if (existsSync(activityPath)) {
    for (const line of readFileSync(activityPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        const stateKey = linearStateKey(record);
        if (stateKey) latestState.set(record.ref, stateKey);
      } catch {
        // Other connectors own their malformed records; tolerate them and append safely.
      }
    }
  }

  const fresh = [];
  let skipped = 0;
  for (const record of records) {
    const stateKey = linearStateKey(record);
    if (!stateKey || latestState.get(record.ref) === stateKey) {
      skipped++;
      continue;
    }
    latestState.set(record.ref, stateKey);
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

export async function pullLinearActivity({
  repo,
  activityPath,
  tier = DEFAULT_TIER,
  dryRun = false,
  query = queryAssignedOpenIssues,
  now = new Date(),
}) {
  const root = path.resolve(repo);
  const inbox = existsSync(path.join(root, "1-inbox")) ? "1-inbox" : "01-intake";
  const target = activityPath
    ? path.resolve(activityPath)
    : path.join(root, inbox, "comms", "activity.jsonl");
  const data = await query();
  const observedAt = now.toISOString();
  const current = normalizeLinearIssues(data, { tier, observedAt });
  const records = [...current, ...tombstonesForMissing(target, current, observedAt, tier)];
  const append = appendLinearActivity(target, records, { dryRun });
  return { records, ...append, activityPath: target };
}

function parseArgs(argv, baseDir) {
  const value = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    repo: path.resolve(value("--repo", baseDir)),
    tier: value("--tier", DEFAULT_TIER),
    activityPath: value("--activity-path"),
    dryRun: argv.includes("--dry-run"),
  };
}

/** `aios linear activity [pull] …` — argv is everything after `activity`. */
export async function cmdActivity(argv, baseDir = process.cwd()) {
  const rest = argv[0] === "pull" ? argv.slice(1) : argv;
  if (rest[0] && !rest[0].startsWith("--")) {
    fail(`unknown activity action "${rest[0]}" — usage: aios linear activity pull [--repo PATH]`);
  }
  const opts = parseArgs(rest, baseDir);
  if (!TIERS.has(opts.tier)) fail("--tier must be admin|team|external");
  let result;
  try {
    result = await pullLinearActivity(opts);
  } catch (error) {
    fail(`linear-activity-pull: ${error instanceof Error ? error.message : "failed"}`);
  }
  console.log(
    `linear-activity-pull: ${opts.dryRun ? "would write" : "wrote"} ${result.written}, skipped ${result.skipped} -> ${path.relative(opts.repo, result.activityPath)}`
  );
  return 0;
}
