#!/usr/bin/env node
/**
 * gog-comms-sync — Gmail → comms activity JSONL connector (AIO-140 comms source).
 *
 * The comms source (`src/operator-loop/sources/comms.ts`) READS normalized activity
 * records from `<inbox>/comms/activity.jsonl`. This script WRITES them, from real Gmail
 * data pulled through the already-authenticated `gog` CLI.
 *
 * Contract per line (one JSON object), matching `CommsActivityRecord`:
 *   { source: "email", tier, occurredAt, ref, direction, summary }
 * Email records are deliberately CHANNEL-LESS — the comms source resolves a channel-backed
 * record's tier through the (default-deny) channel→tier map, and email has no channel. So a
 * channel-less record resolves tier from its OWN `tier` field, which means this connector
 * must ALWAYS set it explicitly (`--tier`, default "team") or the record is excluded.
 *
 * Idempotency: the target file is read first and every existing `ref` collected; a message
 * whose id is already present is skipped. Re-running never duplicates a line.
 *
 * Usage:
 *   node scripts/connectors/gog-comms-sync.mjs --out 1-inbox/comms/activity.jsonl
 *   node scripts/connectors/gog-comms-sync.mjs --hours 24 --query "in:inbox is:unread" --tier team
 *
 * Flags:
 *   --out <path>      target JSONL file (default: 1-inbox/comms/activity.jsonl)
 *   --query <q>       Gmail query (default: "in:inbox")
 *   --hours <n>       lookback window in hours (default: 168 = 7 days)
 *   --tier <t>        admin | team | external (default: team)
 *   --account <email> gog account (default: $GOG_ACCOUNT, else gog's default)
 *   --max <n>         max messages to pull (default: 200)
 *   --dry-run         print what would be appended, write nothing
 *
 * Zero npm deps. Requires `gog` on PATH, already authenticated (this script never auths).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export const TIERS = new Set(["admin", "team", "external"]);
export const DEFAULT_OUT = "1-inbox/comms/activity.jsonl";
export const DEFAULT_QUERY = "in:inbox";
export const DEFAULT_HOURS = 168;
export const DEFAULT_TIER = "team";
export const DEFAULT_MAX = 200;
/** Summary lines are a one-line human signal, not a body dump. */
export const SUMMARY_MAX = 180;

// ── pure mapping ─────────────────────────────────────────────────────────────

/**
 * Parse gog's `--json -z UTC` date field ("YYYY-MM-DD HH:MM", already UTC) into an ISO
 * string. Also accepts an already-ISO value (Gmail `internalDate`-style callers / fixtures).
 * Returns null when unparseable — the caller drops the message rather than inventing a time.
 */
export function toIso(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}.000Z`;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Display name from a `Name <addr@x>` / bare-address `from` header. */
export function senderLabel(from) {
  if (typeof from !== "string" || !from.trim()) return "unknown sender";
  const s = from.trim();
  const named = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s);
  if (named) return (named[1].trim() || named[2].trim()).trim();
  return s;
}

export function truncate(text, max = SUMMARY_MAX) {
  const s = String(text).replace(/\s+/g, " ").trim();
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Direction from Gmail labels: a message carrying SENT is outbound, everything else is
 * inbound. LIMITATION: gog's message list exposes labels only — a message that is neither
 * in SENT nor a normal inbox delivery (e.g. DRAFT, or an imported archive item) is reported
 * as "inbound". That is the conservative default; it never mislabels a sent message.
 */
export function directionFor(labels) {
  const list = Array.isArray(labels) ? labels : [];
  return list.some((l) => typeof l === "string" && l.toUpperCase() === "SENT")
    ? "outbound"
    : "inbound";
}

/**
 * Map one gog Gmail message object → one CommsActivityRecord, or null when the message
 * cannot yield a valid record (no stable id, or no parseable date). Never throws.
 *
 * Shape in (from `gog gmail messages search --json`):
 *   { id, threadId, date: "YYYY-MM-DD HH:MM", from, subject, labels: [...] }
 */
export function mapMessage(msg, { tier = DEFAULT_TIER } = {}) {
  if (!msg || typeof msg !== "object") return null;
  const ref = typeof msg.id === "string" && msg.id.trim() ? msg.id.trim() : null;
  if (!ref) return null;
  const occurredAt = toIso(msg.date);
  if (!occurredAt) return null;

  const subject =
    typeof msg.subject === "string" && msg.subject.trim() ? msg.subject.trim() : "(no subject)";
  // `summary` is REQUIRED by the comms source (records without one are excluded), so it is
  // always synthesized here — sender + subject is the smallest useful triage line.
  const summary = truncate(`${senderLabel(msg.from)}: ${subject}`);

  // No `channel` key: email is channel-less, so the source resolves tier from this record.
  return {
    source: "email",
    tier,
    occurredAt,
    ref,
    direction: directionFor(msg.labels),
    summary,
  };
}

/** Map a batch, dropping unmappable messages. */
export function mapMessages(messages, opts = {}) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    const rec = mapMessage(m, opts);
    if (rec) out.push(rec);
  }
  return out;
}

// ── idempotent append ────────────────────────────────────────────────────────

/**
 * Collect the `ref`s already present in an existing activity JSONL. Missing file → empty
 * set. Unparseable lines are skipped (a hand-edited or truncated file must not make the
 * connector re-append everything, but it also must not crash the run).
 */
export function existingRefs(file) {
  const refs = new Set();
  if (!existsSync(file)) return refs;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed);
      if (rec && typeof rec.ref === "string" && rec.ref.trim()) refs.add(rec.ref.trim());
    } catch {
      continue;
    }
  }
  return refs;
}

/**
 * Filter records against the refs already on disk AND against duplicates within the batch
 * itself. Pure — returns `{ fresh, skipped }` without touching the filesystem.
 */
export function selectNew(records, refs) {
  const seen = new Set(refs);
  const fresh = [];
  let skipped = 0;
  for (const rec of records) {
    if (!rec || typeof rec.ref !== "string" || seen.has(rec.ref)) {
      skipped += 1;
      continue;
    }
    seen.add(rec.ref);
    fresh.push(rec);
  }
  return { fresh, skipped };
}

/**
 * Append only records whose `ref` is not already in `file`. Idempotent: calling twice with
 * the same records writes once. Returns `{ wrote, skipped }`.
 */
export function appendRecords(file, records, { dryRun = false } = {}) {
  const { fresh, skipped } = selectNew(records, existingRefs(file));
  if (fresh.length && !dryRun) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    appendFileSync(file, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  }
  return { wrote: fresh.length, skipped };
}

// ── gog invocation ───────────────────────────────────────────────────────────

/** Gmail can only express a lookback in whole days; round UP so the window is never short. */
export function gmailWindowQuery(query, hours) {
  const days = Math.max(1, Math.ceil(hours / 24));
  return `${query} newer_than:${days}d`;
}

export function gogArgs({ query, hours, max, account }) {
  const args = [
    "gmail",
    "messages",
    "search",
    gmailWindowQuery(query, hours),
    "--json",
    "--no-input",
    "-z",
    "UTC",
    "--max",
    String(max),
  ];
  if (account) args.push("-a", account);
  return args;
}

/** Shell out to `gog` and return the parsed `messages` array. Throws with a clear message. */
export function fetchMessages(opts, run = defaultRun) {
  let raw;
  try {
    raw = run("gog", gogArgs(opts));
  } catch (e) {
    if (e && e.code === "ENOENT") {
      throw new Error("`gog` CLI not found on PATH — install and authenticate it first");
    }
    const stderr = e && e.stderr ? String(e.stderr).trim() : "";
    throw new Error(`gog gmail search failed${stderr ? `: ${stderr}` : `: ${e.message}`}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`gog returned non-JSON output (first 200 chars): ${String(raw).slice(0, 200)}`);
  }
  const messages = parsed && Array.isArray(parsed.messages) ? parsed.messages : null;
  if (!messages) throw new Error("gog JSON has no `messages` array — unexpected output shape");
  return messages;
}

function defaultRun(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    out: DEFAULT_OUT,
    query: DEFAULT_QUERY,
    hours: DEFAULT_HOURS,
    tier: DEFAULT_TIER,
    max: DEFAULT_MAX,
    account: process.env.GOG_ACCOUNT || null,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const need = (name) => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${name} requires a value`);
      i += 1;
      return v;
    };
    if (a === "--out") opts.out = need("--out");
    else if (a === "--query") opts.query = need("--query");
    else if (a === "--tier") opts.tier = need("--tier");
    else if (a === "--account") opts.account = need("--account");
    else if (a === "--since" || a === "--hours") opts.hours = Number(need(a));
    else if (a === "--max") opts.max = Number(need("--max"));
    else if (a === "--dry-run" || a === "-n") opts.dryRun = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new Error(`unknown flag: ${a}`);
  }
  if (!TIERS.has(opts.tier)) {
    throw new Error(`--tier must be one of admin|team|external (got "${opts.tier}")`);
  }
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) {
    throw new Error("--hours/--since must be a positive number of hours");
  }
  if (!Number.isInteger(opts.max) || opts.max <= 0) throw new Error("--max must be a positive int");
  return opts;
}

const USAGE = `gog-comms-sync — Gmail → comms activity JSONL

  --out <path>      target JSONL (default ${DEFAULT_OUT})
  --query <q>       Gmail query (default "${DEFAULT_QUERY}")
  --hours/--since   lookback hours (default ${DEFAULT_HOURS})
  --tier <t>        admin|team|external (default ${DEFAULT_TIER})
  --account <email> gog account (default $GOG_ACCOUNT)
  --max <n>         max messages (default ${DEFAULT_MAX})
  --dry-run, -n     print, do not write`;

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const messages = fetchMessages(opts);
  const records = mapMessages(messages, { tier: opts.tier });
  const dropped = messages.length - records.length;
  const { wrote, skipped } = appendRecords(opts.out, records, { dryRun: opts.dryRun });
  process.stdout.write(
    `${opts.dryRun ? "[dry-run] " : ""}wrote ${wrote} new records, skipped ${skipped} duplicates` +
      `${dropped > 0 ? `, dropped ${dropped} unmappable` : ""} (${opts.out})\n`
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]).endsWith("gog-comms-sync.mjs");
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`gog-comms-sync: ${e.message}\n`);
    process.exit(1);
  }
}
