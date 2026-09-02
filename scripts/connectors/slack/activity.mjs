/**
 * `aios slack activity [pull]` — unread Slack → operator-loop comms activity
 * (AIO-1072, ported from the retired slack-personal descriptor adapter, AIO-366).
 *
 * The token is resolved by the adapter preflight (index.mjs → credentials.mjs), never
 * here, and every Slack call routes through web.mjs `slackCall` (trustedFetch,
 * destination policy, 429/5xx retries). Slack exposes last_read/unread state only on
 * some conversation objects; only objects with an authoritative last_read marker AND
 * evidence of newer/unread content are scanned — missing state is skipped, never
 * guessed. Records are owner-private (`admin`) by default and idempotent by stable
 * Slack ref. Flags and the output line keep the descriptor adapter's shape:
 *
 *   aios slack activity pull [--repo PATH] [--tier admin|team|external]
 *                            [--max-channels N] [--max-messages N]
 *                            [--activity-path PATH] [--dry-run]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { slackCall } from "./web.mjs";

export const DEFAULT_TIER = "admin";
export const ACTIVITY_BASENAME = path.join("comms", "activity.jsonl");
// Tier membership is validated offline in args.mjs VERB_SPECS.activity (round-5 contract).

const print = (line) => process.stdout.write(`${line}\n`);

function oneLine(value, max = 300) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function slackIso(ts) {
  if (typeof ts !== "string" || !/^\d+(?:\.\d+)?$/.test(ts)) return null;
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function latestTs(conversation) {
  const latest = conversation?.latest;
  if (typeof latest === "string") return latest;
  return typeof latest?.ts === "string" ? latest.ts : null;
}

function isAfter(ts, boundary) {
  const left = Number(ts);
  const right = Number(boundary);
  return Number.isFinite(left) && Number.isFinite(right) && left > right;
}

function unreadEvidence(conversation) {
  const lastRead = typeof conversation?.last_read === "string" ? conversation.last_read : null;
  if (!lastRead) return null;
  const count = Number(conversation.unread_count ?? conversation.unread_count_display ?? 0);
  const latest = latestTs(conversation);
  if (!(count > 0) && !(latest && isAfter(latest, lastRead))) return null;
  return lastRead;
}

function channelLabel(conversation) {
  if (conversation?.name) return `#${oneLine(conversation.name, 80)}`;
  if (conversation?.is_im) return `dm:${oneLine(conversation.user || conversation.id, 80)}`;
  return oneLine(conversation?.id, 80);
}

export function normalizeSlackMessage(message, conversation, selfUserId, tier = DEFAULT_TIER) {
  if (!message || message.type !== "message") return null;
  if (typeof message.user !== "string" || message.user === selfUserId) return null;
  const occurredAt = slackIso(message.ts);
  const text = oneLine(message.text);
  const channelId = typeof conversation?.id === "string" ? conversation.id : null;
  if (!occurredAt || !text || !channelId) return null;
  const label = channelLabel(conversation);
  return {
    source: "slack",
    tier,
    occurredAt,
    ref: `slack:${channelId}:${message.ts}`,
    channel: label,
    channelId,
    direction: "inbound",
    summary: `Slack needing reply in ${label}: ${text}`,
    waitingOn: "me",
  };
}

/** Collect a bounded unread set using an injected Slack Web API caller. */
export async function collectSlackUnread({
  call,
  tier = DEFAULT_TIER,
  maxChannels = 100,
  maxMessages = 50,
}) {
  const auth = await call("auth.test", {});
  const selfUserId = auth?.user_id;
  if (typeof selfUserId !== "string" || !selfUserId)
    throw new Error("Slack auth response missing user_id");

  const conversations = [];
  let cursor = "";
  while (conversations.length < maxChannels) {
    const page = await call("conversations.list", {
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: "true",
      limit: String(Math.min(200, maxChannels - conversations.length)),
      cursor: cursor || undefined,
    });
    conversations.push(...(Array.isArray(page?.channels) ? page.channels : []));
    cursor = page?.response_metadata?.next_cursor || "";
    if (!cursor) break;
  }

  const records = [];
  let scanned = 0;
  for (const conversation of conversations.slice(0, maxChannels)) {
    const oldest = unreadEvidence(conversation);
    if (!oldest || typeof conversation?.id !== "string") continue;
    scanned++;
    const history = await call("conversations.history", {
      channel: conversation.id,
      oldest,
      inclusive: "false",
      limit: String(Math.min(200, maxMessages)),
    });
    for (const message of Array.isArray(history?.messages) ? history.messages : []) {
      if (typeof message?.ts !== "string" || !isAfter(message.ts, oldest)) continue;
      const record = normalizeSlackMessage(message, conversation, selfUserId, tier);
      if (record) records.push(record);
      if (records.length >= maxMessages) break;
    }
    if (records.length >= maxMessages) break;
  }
  return { records, conversations: conversations.length, scanned };
}

export function loadExistingRefs(activityPath) {
  const refs = new Set();
  if (!existsSync(activityPath)) return refs;
  for (const line of readFileSync(activityPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (typeof record?.ref === "string") refs.add(record.ref);
    } catch {
      // Existing malformed lines are not this connector's authority; tolerate and append safely.
    }
  }
  return refs;
}

export function appendActivity(activityPath, records, { dryRun = false } = {}) {
  const refs = loadExistingRefs(activityPath);
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

/**
 * `aios slack activity [pull] …` — args pre-parsed by VERB_SPECS.activity; ctx carries the
 * resolved token (preflight) and the trustedFetch seams.
 */
export async function cmdActivity(ctx, args) {
  // Flags are already validated offline by VERB_SPECS.activity (args.mjs) before any
  // credential resolved — tier membership and the positive-integer bounds included.
  // Repo precedence: an explicit --repo that survived to the verb argv (compat bin),
  // the dispatch-resolved workspace root (canonical route, which consumes --repo),
  // then the working directory — the descriptor adapter's old default.
  const repo = path.resolve(args.repo ?? ctx.repo ?? ctx.cwd ?? process.cwd());
  const tier = args.tier ?? DEFAULT_TIER;
  const inbox = existsSync(path.join(repo, "1-inbox")) ? "1-inbox" : "01-intake";
  const activityPath = args.activityPath
    ? path.resolve(args.activityPath)
    : path.join(repo, inbox, ACTIVITY_BASENAME);
  const result = await collectSlackUnread({
    call: (method, params) => slackCall(ctx, method, params),
    tier,
    maxChannels: args.maxChannels ? Number(args.maxChannels) : 100,
    maxMessages: args.maxMessages ? Number(args.maxMessages) : 50,
  });
  const append = appendActivity(activityPath, result.records, { dryRun: args.dryRun === true });
  print(
    `slack-activity-pull: ${args.dryRun ? "would write" : "wrote"} ${append.written}, skipped ${append.skipped} (${result.scanned}/${result.conversations} conversations had unread markers) -> ${path.relative(repo, activityPath)}`
  );
  return 0;
}
