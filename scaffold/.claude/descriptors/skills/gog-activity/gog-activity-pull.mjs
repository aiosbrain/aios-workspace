#!/usr/bin/env node
/**
 * gog-activity-pull.mjs — AIO-355: minimal GOG (Gmail/Calendar) → operator-loop
 * activity writer.
 *
 * `src/operator-loop/sources/comms.ts` reads a generic, connector-written
 * `<inbox>/comms/activity.jsonl` (one normalized JSON record per line — see
 * `CommsActivityRecord` there) and turns it into tier-tagged `comms` signals for
 * the daily/weekly loop. GOG (John's Google Workspace CLI: gmail/calendar/drive,
 * OAuth refresh token, no API key) has no writer for that contract — this script
 * is it.
 *
 * It pulls TWO gog surfaces, using only documented flags (`gog calendar events
 * --help` / `gog gmail search --help` — nothing invented):
 *   1. today's calendar events        → `gog calendar events --today --json --results-only`
 *   2. inbox threads needing a reply  → `gog gmail search "<query>" --json --results-only -z UTC`
 *      (default query: `in:inbox is:unread` — gog has no dedicated "needs reply"
 *      flag; this is the closest honest proxy over its Gmail-query search surface.
 *      Override with `--query` for a tighter/looser definition.)
 *
 * Each result is normalized into the comms activity record shape and appended
 * IDEMPOTENTLY — re-running never duplicates a record already on disk, keyed by
 * its stable `ref` (`cal:<eventId>` / `gmail:<threadId>`).
 *
 * Calendar/email are personal-by-default: the emitted `tier` defaults to `admin`
 * (owner-private, never syncs) — override with `--tier team|external` only if
 * you deliberately want gog-derived comms signals to leave the machine.
 *
 * Usage:
 *   node gog-activity-pull.mjs [--repo PATH] [--tier admin|team|external]
 *                              [--query "gmail search query"] [--max N]
 *                              [--activity-path PATH] [--dry-run]
 *
 * This script is invoked manually or via cron/scheduler — like the granola-direct
 * connector, `aios loop` never calls out to gog itself; it only reads whatever
 * activity.jsonl already contains. See `docs/v1-operator-loop/domains/communication.md`.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_EMAIL_QUERY = "in:inbox is:unread";
export const DEFAULT_TIER = "admin"; // personal gmail/calendar is owner-private by default
export const ACTIVITY_BASENAME = path.join("comms", "activity.jsonl");

// ════════════════════════════ pure normalization (unit-testable) ═══════════

/** Turn a gog calendar `start`/`end` time object ({dateTime,timeZone} or {date}) into ISO. */
export function isoFromCalendarTime(t) {
  if (!t) return null;
  if (typeof t.dateTime === "string") {
    const d = new Date(t.dateTime);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof t.date === "string") {
    // All-day event: no time-of-day in the Calendar API: anchor at UTC midnight.
    const d = new Date(`${t.date}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** `gog gmail search --json` (with `-z UTC`) emits `date: "YYYY-MM-DD HH:MM"` in UTC. */
export function isoFromGmailDate(dateStr) {
  if (typeof dateStr !== "string" || !dateStr.trim()) return null;
  const d = new Date(dateStr.replace(" ", "T") + ":00Z");
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** One `gog calendar events --json` event → a comms activity record, or null if unusable. */
export function normalizeCalendarEvent(event, { tier = DEFAULT_TIER } = {}) {
  if (!event || typeof event.id !== "string" || !event.id) return null;
  const occurredAt = isoFromCalendarTime(event.start) || new Date(0).toISOString();
  const attendees = Array.isArray(event.attendees)
    ? event.attendees.map((a) => (a && (a.displayName || a.email)) || "").filter(Boolean)
    : [];
  const who = attendees.length ? ` with ${attendees.join(", ")}` : "";
  return {
    source: "calendar",
    tier,
    occurredAt,
    ref: `cal:${event.id}`,
    channel: null,
    direction: null,
    summary: `Meeting: "${event.summary || "untitled"}"${who}`,
  };
}

/** One `gog gmail search --json` thread → a comms activity record, or null if unusable. */
export function normalizeEmailThread(thread, { tier = DEFAULT_TIER } = {}) {
  if (!thread || typeof thread.id !== "string" || !thread.id) return null;
  const occurredAt = isoFromGmailDate(thread.date) || new Date(0).toISOString();
  return {
    source: "email",
    tier,
    occurredAt,
    ref: `gmail:${thread.id}`,
    channel: null,
    direction: "inbound",
    summary: `Email needing reply: "${thread.subject || "(no subject)"}" from ${
      thread.from || "unknown sender"
    }`,
  };
}

// ════════════════════════════ idempotent append ════════════════════════════

/** Set of `ref` values already present in the activity file (malformed lines are ignored —
 *  the reading source, `comms.ts`, tolerates and reports those separately). */
export function loadExistingRefs(activityPath) {
  const refs = new Set();
  if (!existsSync(activityPath)) return refs;
  const raw = readFileSync(activityPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec && typeof rec.ref === "string") refs.add(rec.ref);
    } catch {
      /* not valid JSON — skip; nothing to dedupe against */
    }
  }
  return refs;
}

/** Append only records whose `ref` isn't already on disk. Returns `{written, skipped}`. */
export function appendActivity(activityPath, records) {
  mkdirSync(path.dirname(activityPath), { recursive: true });
  const existing = loadExistingRefs(activityPath);
  const seenThisRun = new Set();
  const fresh = [];
  for (const r of records) {
    if (!r || typeof r.ref !== "string" || !r.ref) continue;
    if (existing.has(r.ref) || seenThisRun.has(r.ref)) continue;
    seenThisRun.add(r.ref);
    fresh.push(r);
  }
  if (fresh.length) {
    const lines = fresh.map((r) => JSON.stringify(r)).join("\n") + "\n";
    appendFileSync(activityPath, lines);
  }
  return { written: fresh.length, skipped: records.length - fresh.length };
}

// ════════════════════════════ gog CLI surface ═══════════════════════════════

function runGogJson(args) {
  const out = execFileSync("gog", [...args, "--json", "--results-only"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

/** `gog calendar events --today` — documented flags only (see `gog calendar events --help`). */
export function fetchTodayEvents({ max = 50 } = {}) {
  const out = runGogJson(["calendar", "events", "--today", "--max", String(max)]);
  return Array.isArray(out) ? out : out.events || [];
}

/** `gog gmail search <query>` — documented flags only (see `gog gmail search --help`).
 *  `-z UTC` pins the returned `date` string to UTC so `isoFromGmailDate` is unambiguous. */
export function fetchNeedingReplyThreads({ query = DEFAULT_EMAIL_QUERY, max = 25 } = {}) {
  const out = runGogJson(["gmail", "search", query, "--max", String(max), "-z", "UTC"]);
  return Array.isArray(out) ? out : out.threads || [];
}

/** True when the `gog` binary is on PATH and runnable (used to skip-not-fail when absent). */
export function gogAvailable() {
  try {
    execFileSync("gog", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ════════════════════════════ CLI ═══════════════════════════════════════════

function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "aios.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d = null) => {
    const i = argv.indexOf(n);
    return i !== -1 ? argv[i + 1] : d;
  };
  const has = (n) => argv.includes(n);

  const repo = path.resolve(flag("--repo", findRepoRoot(process.cwd())));
  const tier = flag("--tier", DEFAULT_TIER);
  const query = flag("--query", DEFAULT_EMAIL_QUERY);
  const max = parseInt(flag("--max", "25"), 10);
  const dryRun = has("--dry-run");
  const activityPathOverride = flag("--activity-path");

  const inboxDir = existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake";
  const activityPath = activityPathOverride
    ? path.resolve(activityPathOverride)
    : path.join(repo, inboxDir, ACTIVITY_BASENAME);

  if (!gogAvailable()) {
    console.error(
      "gog-activity-pull: `gog` not found on PATH. Install/authenticate it first (see the gog-workspace skill) — nothing written."
    );
    process.exit(1);
  }

  let events = [];
  try {
    events = fetchTodayEvents({ max });
  } catch (e) {
    console.error(
      `gog-activity-pull: calendar fetch failed (${e.message}). Continuing without calendar signals.`
    );
  }

  let threads = [];
  try {
    threads = fetchNeedingReplyThreads({ query, max });
  } catch (e) {
    console.error(
      `gog-activity-pull: gmail fetch failed (${e.message}). Continuing without email signals.`
    );
  }

  const records = [
    ...events.map((e) => normalizeCalendarEvent(e, { tier })),
    ...threads.map((t) => normalizeEmailThread(t, { tier })),
  ].filter(Boolean);

  if (dryRun) {
    const existing = loadExistingRefs(activityPath);
    const fresh = records.filter((r) => !existing.has(r.ref));
    console.log(
      `gog-activity-pull: would write ${fresh.length} new record(s) (of ${records.length} fetched) → ${path.relative(
        repo,
        activityPath
      )}`
    );
    for (const r of fresh) console.log(`  + ${r.source} ${r.ref} — ${r.summary}`);
    return;
  }

  const { written, skipped } = appendActivity(activityPath, records);
  console.log(
    `gog-activity-pull: wrote ${written} new record(s), skipped ${skipped} duplicate(s) → ${path.relative(
      repo,
      activityPath
    )} [tier: ${tier}]`
  );
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`gog-activity-pull: ${e.message}`);
    process.exit(1);
  });
}
