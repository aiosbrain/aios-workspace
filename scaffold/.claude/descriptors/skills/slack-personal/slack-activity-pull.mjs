#!/usr/bin/env node
/**
 * slack-activity-pull.mjs — unread Slack → operator-loop comms activity (AIO-366).
 *
 * Manual use:
 *   node slack-activity-pull.mjs [--repo PATH] [--tier admin|team|external]
 *                                [--max-channels N] [--max-messages N]
 *                                [--activity-path PATH] [--dry-run]
 *
 * Authentication is the same personal connector boundary as slack.py: SLACK_USER_TOKEN first,
 * otherwise GET /api/v1/me/slack-token using AIOS_BRAIN_URL + AIOS_API_KEY (+ AIOS_TEAM). Secrets
 * are held in memory only and never printed, written, or passed in argv.
 *
 * Slack exposes last_read/unread state only on some conversation objects. We scan only objects with
 * an authoritative last_read marker and evidence of newer/unread content; missing state is skipped,
 * never guessed. Records are owner-private (admin) by default and idempotent by stable Slack ref.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_TIER = "admin";
export const ACTIVITY_BASENAME = "comms/activity.jsonl";
export const SLACK_API = "https://slack.com/api";
const TIERS = new Set(["admin", "team", "external"]);

function oneLine(value, max = 300) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
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
  const channel = channelLabel(conversation);
  return {
    source: "slack",
    tier,
    occurredAt,
    ref: `slack:${channelId}:${message.ts}`,
    channel,
    direction: "inbound",
    summary: `Slack needing reply in ${channel}: ${text}`,
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
      // Group DMs require the separate `mpim:read` scope. Do not let one optional conversation
      // class make Slack reject channel + 1:1 DM ingestion for otherwise correctly-scoped tokens.
      types: "public_channel,private_channel,im",
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

export async function resolveSlackToken({ env = process.env, fetchImpl = fetch } = {}) {
  const direct = String(env.SLACK_USER_TOKEN || "").trim();
  if (direct) return direct;
  const brainUrl = String(env.AIOS_BRAIN_URL || "").replace(/\/$/, "");
  const apiKey = String(env.AIOS_API_KEY || "").trim();
  if (!brainUrl || !apiKey) throw new Error("Slack is not connected");
  const response = await fetchImpl(`${brainUrl}/api/v1/me/slack-token`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(env.AIOS_TEAM ? { "X-AIOS-Team": env.AIOS_TEAM } : {}),
    },
  });
  if (!response.ok) throw new Error(`Slack token fetch failed (HTTP ${response.status})`);
  const body = await response.json().catch(() => null);
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!token) throw new Error("Slack is not connected");
  return token;
}

export function makeSlackCall(token, { fetchImpl = fetch, apiBase = SLACK_API } = {}) {
  return async (method, params = {}) => {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) body.set(key, String(value));
    }
    const response = await fetchImpl(`${apiBase}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) throw new Error(`Slack HTTP ${response.status} on ${method}`);
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) throw new Error(`Slack API rejected ${method}`);
    return payload;
  };
}

function parseArgs(argv) {
  const value = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  return {
    repo: path.resolve(value("--repo", process.cwd())),
    tier: value("--tier", DEFAULT_TIER),
    maxChannels: positiveInt(value("--max-channels"), 100),
    maxMessages: positiveInt(value("--max-messages"), 50),
    activityPath: value("--activity-path"),
    dryRun: argv.includes("--dry-run"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (!TIERS.has(opts.tier)) throw new Error("--tier must be admin|team|external");
  const inbox = existsSync(path.join(opts.repo, "1-inbox")) ? "1-inbox" : "01-intake";
  const activityPath = opts.activityPath
    ? path.resolve(opts.activityPath)
    : path.join(opts.repo, inbox, ACTIVITY_BASENAME);
  const token = await resolveSlackToken();
  const result = await collectSlackUnread({
    call: makeSlackCall(token),
    tier: opts.tier,
    maxChannels: opts.maxChannels,
    maxMessages: opts.maxMessages,
  });
  const append = appendActivity(activityPath, result.records, { dryRun: opts.dryRun });
  console.log(
    `slack-activity-pull: ${opts.dryRun ? "would write" : "wrote"} ${append.written}, skipped ${append.skipped} (${result.scanned}/${result.conversations} conversations had unread markers) -> ${path.relative(opts.repo, activityPath)}`
  );
  return { ...result, ...append, activityPath };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch((error) => {
    // The orchestrator suppresses child output; this is for the retained manual command. Messages
    // are deliberately fixed/sanitized by helpers above and never contain tokens or response bodies.
    console.error(`slack-activity-pull: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  });
}
