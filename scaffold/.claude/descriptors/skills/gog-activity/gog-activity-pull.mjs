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
 * DUAL EMISSION (AIO-387): alongside the legacy `activity.jsonl` line (kept byte-identical), each
 * object also emits a VERSIONED enriched observation to `.aios/loop/inbox/observations.ndjson`
 * (account/tenant identity, object kind, thread id, participants, edit/delete revisions). The
 * corrected dedup key `(connection/account/tenant, object_kind, native_id)` keeps two accounts
 * observing one native message as two items. Both streams stay admin-tier local, never synced.
 *
 * Usage:
 *   node gog-activity-pull.mjs [--repo PATH] [--tier admin|team|external]
 *                              [--query "gmail search query"] [--max N]
 *                              [--activity-path PATH] [--observations-path PATH]
 *                              [--account EMAIL] [--tenant NAME] [--dry-run]
 *
 * This script is invoked manually or via cron/scheduler — like the granola-direct
 * connector, `aios loop` never calls out to gog itself; it only reads whatever
 * activity.jsonl already contains. See `docs/v1-operator-loop/domains/communication.md`.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_EMAIL_QUERY = "in:inbox is:unread";
export const DEFAULT_TIER = "admin"; // personal gmail/calendar is owner-private by default
export const ACTIVITY_BASENAME = path.join("comms", "activity.jsonl");

// ── enriched adapter-observation record (I-06 / AIO-387) — DUAL EMISSION ─────
//
// Alongside the legacy `activity.jsonl` line (kept byte-identical), each pulled object also emits a
// VERSIONED enriched observation to `.aios/loop/inbox/observations.ndjson`. The enriched record
// carries account/tenant identity, object kind, thread id, participants, and edit/delete revisions —
// so the CORRECTED dedup key `(connection/account/tenant, object_kind, native_id)` keeps two
// accounts observing one native message as two items. Bodies are never stored (snippet + metadata).
// This is a dependency-free reimplementation of the record shape + idempotent append in
// `src/operator-loop/inbox/observations.ts`; the two MUST agree on the key + line schema so the TS
// dual-read projection consumes what this writer produces (asserted in test/gog-activity.test.mjs).
export const OBSERVATIONS_SCHEMA_VERSION = 1;
export const OBSERVATIONS_BASENAME = path.join(".aios", "loop", "inbox", "observations.ndjson");
export const DEFAULT_ACCOUNT = process.env.GOG_ACCOUNT || "primary"; // the observing gmail/cal account
export const DEFAULT_TENANT = "personal";
/** Connection identity: gog is one connector per account. Matches the TS dedup-key scope. */
export function gogConnectionId(account = DEFAULT_ACCOUNT) {
  return `gog:${account}`;
}

/** Corrected dedup key — MUST byte-match observationDedupKey() in observations.ts. */
export function observationDedupKey(o) {
  return JSON.stringify([o.connection_id, o.account, o.tenant, o.object_kind, o.native_id]);
}

/** Per-line idempotency key = dedup key + revision op + number — MUST match observations.ts. */
export function observationLineKey(o) {
  return createHash("sha256")
    .update(observationDedupKey(o))
    .update("|")
    .update(o.revision.op)
    .update("|")
    .update(String(o.revision.revision))
    .digest("hex");
}

/** Parse a gmail `from` header ("Name <email>" or bare email) into a participant identity. */
function parseSender(from) {
  if (typeof from !== "string" || !from.trim()) return null;
  const m = from.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) {
    const display = m[1].trim();
    return { id: m[2].trim(), display: display || null, role: "from" };
  }
  return { id: from.trim(), display: null, role: "from" };
}

/** One `gog calendar events --json` event → an enriched observation, or null if unusable. Field
 *  order matches observations.ts serializeObservation for stable line bytes. */
export function enrichCalendarEvent(event, opts = {}) {
  if (!event || typeof event.id !== "string" || !event.id) return null;
  const { account = DEFAULT_ACCOUNT, tenant = DEFAULT_TENANT, connection_id } = opts;
  const ts = isoFromCalendarTime(event.start) || new Date(0).toISOString();
  const participants = Array.isArray(event.attendees)
    ? event.attendees
        .filter((a) => a && (a.email || a.displayName))
        .map((a) => ({
          id: a.email || a.displayName,
          display: a.displayName || null,
          role: a.organizer ? "organizer" : "attendee",
        }))
    : [];
  return {
    schema_version: OBSERVATIONS_SCHEMA_VERSION,
    connection_id: connection_id || gogConnectionId(account),
    account,
    tenant,
    object_kind: "calendar-event",
    native_id: event.id,
    thread_id: typeof event.recurringEventId === "string" ? event.recurringEventId : event.id,
    participants,
    revision: { op: "create", revision: 0, ts },
    ts,
    snippet: typeof event.summary === "string" ? event.summary : null,
    cursor: null,
    metadata: { status: typeof event.status === "string" ? event.status : null },
  };
}

/** One `gog gmail search --json` thread → an enriched observation, or null if unusable. */
export function enrichEmailThread(thread, opts = {}) {
  if (!thread || typeof thread.id !== "string" || !thread.id) return null;
  const { account = DEFAULT_ACCOUNT, tenant = DEFAULT_TENANT, connection_id } = opts;
  const ts = isoFromGmailDate(thread.date) || new Date(0).toISOString();
  const sender = parseSender(thread.from);
  return {
    schema_version: OBSERVATIONS_SCHEMA_VERSION,
    connection_id: connection_id || gogConnectionId(account),
    account,
    tenant,
    object_kind: "email",
    native_id: thread.id,
    thread_id: thread.id,
    participants: sender ? [sender] : [],
    revision: { op: "create", revision: 0, ts },
    ts,
    snippet: typeof thread.subject === "string" ? thread.subject : null,
    cursor: null,
    metadata: {
      messageCount: typeof thread.messageCount === "number" ? thread.messageCount : null,
    },
  };
}

/** Fixed key order → stable line bytes; MUST match observations.ts serializeObservation. */
function serializeObservation(o) {
  return JSON.stringify({
    schema_version: o.schema_version,
    connection_id: o.connection_id,
    account: o.account,
    tenant: o.tenant,
    object_kind: o.object_kind,
    native_id: o.native_id,
    thread_id: o.thread_id,
    participants: o.participants,
    revision: o.revision,
    ts: o.ts,
    snippet: o.snippet,
    cursor: o.cursor,
    metadata: o.metadata,
  });
}

/** Line keys already on disk in the enriched observation log (malformed lines ignored). */
export function loadExistingObservationKeys(observationsPath) {
  const keys = new Set();
  if (!existsSync(observationsPath)) return keys;
  const raw = readFileSync(observationsPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec && rec.revision && typeof rec.revision.op === "string") {
        keys.add(observationLineKey(rec));
      }
    } catch {
      /* not valid JSON — skip */
    }
  }
  return keys;
}

/** Append only enriched observations whose line key isn't already on disk (idempotent by dedup key
 *  + revision). Crash re-pull of an overlapping page never duplicates a line. Returns `{written, skipped}`. */
export function appendObservations(observationsPath, observations) {
  mkdirSync(path.dirname(observationsPath), { recursive: true });
  const existing = loadExistingObservationKeys(observationsPath);
  const seenThisRun = new Set();
  const fresh = [];
  for (const o of observations) {
    if (!o) continue;
    const key = observationLineKey(o);
    if (existing.has(key) || seenThisRun.has(key)) continue;
    seenThisRun.add(key);
    fresh.push(o);
  }
  if (fresh.length) {
    const lines = fresh.map((o) => serializeObservation(o)).join("\n") + "\n";
    appendFileSync(observationsPath, lines);
  }
  return { written: fresh.length, skipped: observations.length - fresh.length };
}

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
  const observationsPathOverride = flag("--observations-path");
  const account = flag("--account", DEFAULT_ACCOUNT);
  const tenant = flag("--tenant", DEFAULT_TENANT);

  const inboxDir = existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake";
  const activityPath = activityPathOverride
    ? path.resolve(activityPathOverride)
    : path.join(repo, inboxDir, ACTIVITY_BASENAME);
  const observationsPath = observationsPathOverride
    ? path.resolve(observationsPathOverride)
    : path.join(repo, OBSERVATIONS_BASENAME);

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

  // Enriched observations — dual emission. Same source objects, versioned identity-bearing records.
  const observations = [
    ...events.map((e) => enrichCalendarEvent(e, { account, tenant })),
    ...threads.map((t) => enrichEmailThread(t, { account, tenant })),
  ].filter(Boolean);

  if (dryRun) {
    const existing = loadExistingRefs(activityPath);
    const fresh = records.filter((r) => !existing.has(r.ref));
    const existingObs = loadExistingObservationKeys(observationsPath);
    const freshObs = observations.filter((o) => !existingObs.has(observationLineKey(o)));
    console.log(
      `gog-activity-pull: would write ${fresh.length} new record(s) (of ${records.length} fetched) → ${path.relative(
        repo,
        activityPath
      )}`
    );
    for (const r of fresh) console.log(`  + ${r.source} ${r.ref} — ${r.summary}`);
    console.log(
      `gog-activity-pull: would write ${freshObs.length} new enriched observation(s) → ${path.relative(
        repo,
        observationsPath
      )}`
    );
    return;
  }

  const { written, skipped } = appendActivity(activityPath, records);
  console.log(
    `gog-activity-pull: wrote ${written} new record(s), skipped ${skipped} duplicate(s) → ${path.relative(
      repo,
      activityPath
    )} [tier: ${tier}]`
  );
  const obs = appendObservations(observationsPath, observations);
  console.log(
    `gog-activity-pull: wrote ${obs.written} new enriched observation(s), skipped ${obs.skipped} duplicate(s) → ${path.relative(
      repo,
      observationsPath
    )} [account: ${account}/${tenant}]`
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
