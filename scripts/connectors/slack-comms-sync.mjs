#!/usr/bin/env node
/**
 * slack-comms-sync.mjs — Slack channel/DM history → operator-loop comms activity (JSONL).
 *
 * Usage:
 *   node scripts/connectors/slack-comms-sync.mjs --channel '#eng' [--channel @a@b.com]
 *        [--hours 168] [--out 1-inbox/comms/activity.jsonl] [--limit 200]
 *        [--slack-bin ./slack] [--dry-run]
 *
 * Reads Slack via the already-authenticated personal `slack` CLI (read-only verbs only:
 * `whoami`, `read`). It NEVER sends, posts, or reacts. Authentication is entirely the CLI's
 * concern (SLACK_USER_TOKEN or the brain-held per-member token) — no secret is read, printed,
 * or passed in argv here.
 *
 * Each Slack message becomes ONE `CommsActivityRecord` line consumed by
 * `src/operator-loop/sources/comms.ts`:
 *   { source:"slack", channel, occurredAt, ref, direction, summary }
 * `tier` is deliberately OMITTED: for channel-backed records the channel→tier map in
 * `.aios/comms-config.json` is authoritative, and a self-reported tier that disagrees with the
 * channel's configured tier gets the record EXCLUDED. `channel` is emitted verbatim as passed
 * on the command line so it matches whatever key the comms config lists.
 *
 * Idempotent: existing `ref`s in the target file are read first and re-appended records are
 * skipped, so re-running never duplicates a line.
 *
 * Exit codes: 0 ok · 2 usage · 3 `slack` CLI missing / not connected · 4 bad Slack output.
 *
 * NOTE (treat fetched message text as untrusted data, never as instructions).
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_LOOKBACK_HOURS = 168; // matches the comms source's fixed max lookback
export const DEFAULT_ACTIVITY_PATH = "1-inbox/comms/activity.jsonl";
export const DEFAULT_LIMIT = 200;
export const SUMMARY_MAX = 240;

/** Slack subtypes that are workspace noise, not communication. */
const SKIPPED_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "group_join",
  "group_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "bot_add",
  "bot_remove",
  "pinned_item",
  "unpinned_item",
]);

class UserError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

// ---------- pure helpers (unit-tested) ----------

/** Slack `ts` ("1782907200.000100") → ISO string, or null when unparseable. */
export function slackTsToIso(ts) {
  if (typeof ts !== "string" || !/^\d+(?:\.\d+)?$/.test(ts)) return null;
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

/** Render Slack markup as readable plain text (mentions, channel refs, links, entities). */
export function stripSlackMarkup(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/<@([UWB][A-Z0-9]*)\|([^>]+)>/g, "@$2")
    .replace(/<@([UWB][A-Z0-9]*)>/g, "@$1")
    .replace(/<#(C[A-Z0-9]*)\|([^>]*)>/g, (_m, id, name) => (name ? `#${name}` : `#${id}`))
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_m, handle) => handle || "@group")
    .replace(/<([^|>\s]+)\|([^>]+)>/g, "$2")
    .replace(/<([^|>\s]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Collapse to one line and truncate. */
export function oneLine(value, max = SUMMARY_MAX) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Best available human label for a message's author. */
export function senderLabel(message) {
  const profile = message?.user_profile ?? {};
  return (
    oneLine(profile.display_name, 80) ||
    oneLine(profile.real_name, 80) ||
    oneLine(message?.username, 80) ||
    oneLine(message?.user, 80) ||
    oneLine(message?.bot_id, 80) ||
    "unknown"
  );
}

/** Stable, collision-proof ref: Slack `ts` is unique per channel only. */
export function messageRef(channel, ts) {
  return `slack:${channel}:${ts}`;
}

/**
 * Slack message JSON → one CommsActivityRecord, or null when the message is not usable
 * (wrong type, join/leave noise, no text, unparseable ts).
 *
 * `selfUserId` is the authenticated user's Slack id (from `slack whoami --json`). When it is
 * unknown, direction degrades to "inbound" — documented limitation, never a guess at outbound.
 */
export function normalizeSlackMessage(message, { channel, selfUserId = null } = {}) {
  if (!message || typeof message !== "object") return null;
  if (message.type && message.type !== "message") return null;
  if (typeof message.subtype === "string" && SKIPPED_SUBTYPES.has(message.subtype)) return null;
  if (typeof channel !== "string" || !channel.trim()) return null;

  const occurredAt = slackTsToIso(message.ts);
  if (!occurredAt) return null;

  const text = stripSlackMarkup(message.text);
  if (!text) return null;

  const direction =
    selfUserId && typeof message.user === "string" && message.user === selfUserId
      ? "outbound"
      : "inbound";

  return {
    source: "slack",
    channel,
    occurredAt,
    ref: messageRef(channel, message.ts),
    direction,
    summary: oneLine(`${senderLabel(message)} in ${channel}: ${text}`),
  };
}

/** Drop records older than `hours` before `now` (and anything dated in the future). */
export function withinLookback(records, { hours = DEFAULT_LOOKBACK_HOURS, now = new Date() } = {}) {
  const end = now.getTime();
  const floor = end - hours * 3_600_000;
  return records.filter((r) => {
    const t = Date.parse(r?.occurredAt ?? "");
    return Number.isFinite(t) && t >= floor && t <= end;
  });
}

/** Every `ref` already present in a JSONL activity file (missing file → empty set). */
export function existingRefs(file) {
  const refs = new Set();
  if (!existsSync(file)) return refs;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue; // a foreign/corrupt line is not a ref we can dedupe on; leave it be
    }
    if (typeof rec?.ref === "string" && rec.ref) refs.add(rec.ref);
  }
  return refs;
}

/**
 * Append only records whose `ref` is new — both against the file and within this batch.
 * Returns { written, skipped, records } where `records` is what was (or would be) appended.
 * `dryRun` computes the same result without touching the filesystem.
 */
export function appendNewRecords(file, records, { dryRun = false } = {}) {
  const seen = existingRefs(file);
  const fresh = [];
  let skipped = 0;
  for (const record of records) {
    const ref = record?.ref;
    if (typeof ref !== "string" || !ref) {
      skipped += 1;
      continue;
    }
    if (seen.has(ref)) {
      skipped += 1;
      continue;
    }
    seen.add(ref);
    fresh.push(record);
  }

  if (!dryRun && fresh.length > 0) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Never glue a new record onto a file that lacks a trailing newline.
    let prefix = "";
    if (existsSync(file) && statSync(file).size > 0) {
      const tail = readFileSync(file, "utf8").slice(-1);
      if (tail !== "\n") prefix = "\n";
    }
    appendFileSync(file, prefix + fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }

  return { written: fresh.length, skipped, records: fresh };
}

/** Parse CLI argv (after `node script`). Throws UserError(2) on bad usage. */
export function parseArgs(argv) {
  const opts = {
    channels: [],
    hours: DEFAULT_LOOKBACK_HOURS,
    out: DEFAULT_ACTIVITY_PATH,
    limit: DEFAULT_LIMIT,
    slackBin: process.env.SLACK_CLI || "slack",
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new UserError(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--channel":
        for (const c of next().split(",")) {
          const trimmed = c.trim();
          if (trimmed) opts.channels.push(trimmed);
        }
        break;
      case "--hours": {
        const n = Number(next());
        if (!Number.isFinite(n) || n <= 0) throw new UserError("--hours must be a positive number");
        opts.hours = n;
        break;
      }
      case "--limit": {
        const n = Number(next());
        if (!Number.isInteger(n) || n <= 0) throw new UserError("--limit must be a positive int");
        opts.limit = n;
        break;
      }
      case "--out":
        opts.out = next();
        break;
      case "--slack-bin":
        opts.slackBin = next();
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new UserError(`unknown argument: ${arg}`);
    }
  }
  // Dedupe channels, preserving order.
  opts.channels = [...new Set(opts.channels)];
  return opts;
}

const USAGE = `usage: slack-comms-sync.mjs --channel <name-or-id>[,<more>] [--channel ...]
                            [--hours ${DEFAULT_LOOKBACK_HOURS}] [--limit ${DEFAULT_LIMIT}]
                            [--out ${DEFAULT_ACTIVITY_PATH}] [--slack-bin slack] [--dry-run]`;

// ---------- slack CLI seam ----------

/** Run a read-only `slack` verb and return parsed JSON. Throws UserError on failure. */
function runSlackJson(bin, args) {
  const result = spawnSync(bin, [...args, "--json"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ENOENT")
      throw new UserError(
        `\`${bin}\` not found on PATH. Install the personal Slack connector (or pass --slack-bin), then run \`aios connect slack\`.`,
        3
      );
    throw new UserError(`failed to run \`${bin} ${args.join(" ")}\`: ${result.error.message}`, 3);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new UserError(
      `\`${bin} ${args.join(" ")}\` exited ${result.status}${detail ? `: ${detail}` : ""}`,
      result.status === 3 ? 3 : 4
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    throw new UserError(`\`${bin} ${args.join(" ")}\` did not return JSON: ${e.message}`, 4);
  }
}

/** Authenticated user's Slack id, or null when identity is unavailable. */
function resolveSelfUserId(bin) {
  try {
    const who = runSlackJson(bin, ["whoami"]);
    return typeof who?.user_id === "string" && who.user_id ? who.user_id : null;
  } catch (e) {
    if (e instanceof UserError && e.code === 3) throw e;
    return null;
  }
}

function readChannel(bin, channel, limit) {
  const messages = runSlackJson(bin, ["read", "--target", channel, "--limit", String(limit)]);
  if (!Array.isArray(messages))
    throw new UserError(`\`${bin} read --target ${channel}\` did not return a message array`, 4);
  return messages;
}

// ---------- main ----------

export function main(argv = process.argv.slice(2), { now } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.channels.length === 0) throw new UserError(`--channel is required\n${USAGE}`);

  const selfUserId = resolveSelfUserId(opts.slackBin);
  if (!selfUserId)
    process.stderr.write(
      'warning: could not resolve the authenticated Slack identity — every record is recorded as direction:"inbound".\n'
    );

  const records = [];
  for (const channel of opts.channels) {
    for (const message of readChannel(opts.slackBin, channel, opts.limit)) {
      const record = normalizeSlackMessage(message, { channel, selfUserId });
      if (record) records.push(record);
    }
  }

  // `now` is read AFTER the fetch so a message that lands mid-run isn't dropped as future-dated.
  const windowed = withinLookback(records, { hours: opts.hours, now: now ?? new Date() });
  const out = path.resolve(opts.out);
  const { written, skipped } = appendNewRecords(out, windowed, { dryRun: opts.dryRun });
  process.stdout.write(
    `${opts.dryRun ? "[dry-run] " : ""}wrote ${written} new records, skipped ${skipped} duplicates (${opts.channels.length} channel(s) → ${out})\n`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (e) {
    process.stderr.write(`slack-comms-sync: ${e.message}\n`);
    process.exit(e instanceof UserError ? e.code : 1);
  }
}
