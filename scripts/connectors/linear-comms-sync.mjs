#!/usr/bin/env node
/**
 * linear-comms-sync.mjs — Linear → comms activity connector.
 *
 * Writes normalized `CommsActivityRecord` JSONL lines (the shape
 * `src/operator-loop/sources/comms.ts` reads) from live Linear issues, so the operator
 * loop's `comms` source can emit `source: "linear"` signals for C1.
 *
 * Transport: Linear's GraphQL API directly, with the same auth as the workspace's
 * `aios-linear` skill CLI (`LINEAR_API_KEY`, normally provided by `dotenvx run`). That
 * skill's `linear.mjs list <TEAM>` prints a human-readable TSV line only — it has no
 * `--json` mode — and we need structured `updatedAt` / `dueDate` / `priority` fields, so
 * this connector issues the query itself rather than screen-scraping that output.
 *
 * Record shape (channel-LESS by design — a Linear issue has no comms channel, so tier
 * resolution falls back to the record's own `tier` field under the source's default-deny
 * rule; `--tier` therefore always writes an explicit tier):
 *   { source: "linear", tier, occurredAt, ref, summary, dueAt?, waitingOn? }
 *
 * `waitingOn` is set to `"you"` for issues in a non-terminal state (state.type not
 * completed/cancelled) — an open Linear ticket IS something waiting on the operator, and
 * the shared daily-orientation logic (`buildDailyOrientation` in `daily-classifier.ts`)
 * only routes a non-email/slack comms signal into "Blocked" when `waitingOn` (or
 * blocked-sounding summary text) is present; without it, a plain `linear` signal is
 * collected correctly but never lands in a rendered CLI/GUI section. Completed/cancelled
 * issues omit it — they're not waiting on anyone.
 *
 * Idempotent: existing `ref`s in the target file are read first and re-seen issues are
 * skipped, so re-running never duplicates a line.
 *
 * Usage:
 *   dotenvx run --quiet -- node scripts/connectors/linear-comms-sync.mjs \
 *     --out 1-inbox/comms/activity.jsonl [--team AIO] [--tier team] [--priority high]
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINEAR_API = "https://api.linear.app/graphql";

export const DEFAULT_TEAM = "AIO";
export const DEFAULT_TIER = "team";
export const TIERS = new Set(["admin", "team", "external"]);

/** Linear's numeric priority scale (0 = none). Mirrors the aios-linear skill CLI. */
export const PRIORITY_LEVELS = { urgent: 1, high: 2, medium: 3, low: 4 };

/** Linear workflow state types that mean the issue is still open — i.e. still waiting on
 *  someone. `completed` and `cancelled` are the only terminal types Linear defines. */
export const OPEN_STATE_TYPES = new Set(["triage", "backlog", "unstarted", "started"]);

// ── pure mapping ─────────────────────────────────────────────────────────────

/** Coerce a Linear timestamp/date to an ISO-8601 instant, or null when unusable. */
export function toIso(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** One-line human summary: `AIO-123: Fix the thing (In Progress)`. */
export function issueSummary(issue) {
  const title = String(issue?.title ?? "").trim() || "(untitled)";
  const state = String(issue?.state?.name ?? "").trim();
  const head = `${issue?.identifier ?? issue?.id ?? "?"}: ${title}`;
  return state ? `${head} (${state})` : head;
}

/**
 * Map one Linear issue JSON object to a CommsActivityRecord.
 * Throws on an issue with no stable ref or no usable `updatedAt` — a connector that
 * silently dropped those would leave an invisible hole in the activity log.
 */
export function mapIssueToRecord(issue, { tier = DEFAULT_TIER } = {}) {
  if (!issue || typeof issue !== "object") {
    throw new Error("linear-comms-sync: issue must be an object");
  }
  if (!TIERS.has(tier)) {
    throw new Error(`linear-comms-sync: tier must be one of admin|team|external (got "${tier}")`);
  }
  const ref = String(issue.identifier ?? issue.id ?? "").trim();
  if (!ref) throw new Error("linear-comms-sync: issue has no identifier or id (no stable ref)");

  const occurredAt = toIso(issue.updatedAt) ?? toIso(issue.createdAt);
  if (!occurredAt) {
    throw new Error(`linear-comms-sync: issue ${ref} has no parsable updatedAt/createdAt`);
  }

  const record = {
    source: "linear",
    tier,
    occurredAt,
    ref,
    summary: issueSummary(issue),
  };
  // Channel is deliberately omitted (issues are channel-less) — see the header note.
  const dueAt = toIso(issue.dueDate);
  if (dueAt) record.dueAt = dueAt;
  if (OPEN_STATE_TYPES.has(issue?.state?.type)) record.waitingOn = "you";
  return record;
}

// ── idempotent append ────────────────────────────────────────────────────────

/** Every `ref` already present in a JSONL activity file's text. Unparsable lines are
 *  ignored here (the source reports them); they can never mask a ref. */
export function existingRefs(text) {
  const refs = new Set();
  for (const line of String(text ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const ref = rec && typeof rec.ref === "string" ? rec.ref.trim() : "";
    if (ref) refs.add(ref);
  }
  return refs;
}

/**
 * Split records into the ones to write and the ones already present. Dedupes within the
 * incoming batch too, so a doubled issue in one pull can't write two lines.
 * Returns `{ toWrite, skipped }`.
 */
export function planAppend(records, seen = new Set()) {
  const known = new Set(seen);
  const toWrite = [];
  let skipped = 0;
  for (const rec of records) {
    const ref = rec && typeof rec.ref === "string" ? rec.ref.trim() : "";
    if (!ref || known.has(ref)) {
      skipped += 1;
      continue;
    }
    known.add(ref);
    toWrite.push(rec);
  }
  return { toWrite, skipped };
}

/** Append the new records to `outPath`, skipping any whose `ref` is already there.
 *  Creates the parent directory and the file when missing. Returns `{ written, skipped }`. */
export function appendRecords(outPath, records) {
  const existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  const { toWrite, skipped } = planAppend(records, existingRefs(existing));
  if (toWrite.length) {
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    // Heal a previous write that lacked a trailing newline rather than gluing two
    // records onto one unparsable line.
    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
    appendFileSync(outPath, prefix + toWrite.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return { written: toWrite.length, skipped };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = { team: DEFAULT_TEAM, tier: DEFAULT_TIER, priority: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if ((a === "--team" || a === "--tier" || a === "--priority" || a === "--out") && next) {
      opts[a.slice(2)] = next;
      i++;
      continue;
    }
    throw new Error(`linear-comms-sync: unknown or incomplete argument "${a}"`);
  }
  if (!opts.out) throw new Error("linear-comms-sync: --out <path> is required");
  if (!TIERS.has(opts.tier)) {
    throw new Error(
      `linear-comms-sync: --tier must be one of admin|team|external (got "${opts.tier}")`
    );
  }
  if (opts.priority !== null && !(opts.priority in PRIORITY_LEVELS)) {
    throw new Error(
      `linear-comms-sync: --priority must be one of ${Object.keys(PRIORITY_LEVELS).join("|")} (got "${opts.priority}")`
    );
  }
  return opts;
}

const ISSUES_QUERY = `query($f: IssueFilter) {
  issues(first: 250, filter: $f) {
    nodes { id identifier title url createdAt updatedAt dueDate priority state { name type } }
  }
}`;

/** Pull issues for a team (optionally priority-filtered) from Linear's GraphQL API. */
export async function fetchIssues({ team, priority, apiKey, fetchImpl = fetch }) {
  if (!apiKey) {
    throw new Error(
      "LINEAR_API_KEY not set — run via: dotenvx run --quiet -- node scripts/connectors/linear-comms-sync.mjs ..."
    );
  }
  const filter = { team: { key: { eq: team } } };
  if (priority) filter.priority = { eq: PRIORITY_LEVELS[priority] };

  const res = await fetchImpl(LINEAR_API, {
    method: "POST",
    headers: { Authorization: apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ query: ISSUES_QUERY, variables: { f: filter } }),
  });
  const body = await res.json().catch(() => null);
  if (!body || body.errors) {
    const detail = body?.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`;
    throw new Error(`linear-comms-sync: Linear API error: ${detail}`);
  }
  const nodes = body?.data?.issues?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("linear-comms-sync: unexpected Linear response (no issues.nodes array)");
  }
  return nodes;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(argv);
  const issues = await fetchIssues({
    team: opts.team,
    priority: opts.priority,
    apiKey: env.LINEAR_API_KEY,
  });
  const records = issues.map((i) => mapIssueToRecord(i, { tier: opts.tier }));
  const { written, skipped } = appendRecords(opts.out, records);
  console.log(`wrote ${written} new records, skipped ${skipped} duplicates`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
