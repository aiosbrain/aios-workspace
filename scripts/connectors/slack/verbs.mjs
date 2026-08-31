/**
 * Message-surface verbs for `aios slack …` (AIO-1068): whoami, resolve, channels, read,
 * send, dm, react. Output strings match slack.py so agents and scripts keep parsing the
 * same shapes; `--json` prints the same structured results.
 */
import { AiosError } from "../../cli.mjs";
import { parseVerbArgs, readMessage } from "./args.mjs";
import {
  brainResolveSlack,
  openDm,
  listConversations,
  resolveMemberChannel,
  resolveTarget,
  slackCall,
} from "./web.mjs";

const print = (line) => process.stdout.write(`${line}\n`);
const json = (value) => print(JSON.stringify(value, null, 2));

export async function cmdWhoami(ctx, argv) {
  const args = parseVerbArgs(argv);
  if (args.help) return null;
  const result = await slackCall(ctx, "auth.test");
  if (args.json) json(result);
  else print(`${result.user} (${result.user_id}) on team ${result.team} (${result.team_id})`);
  return 0;
}

export async function cmdResolve(ctx, argv) {
  const args = parseVerbArgs(argv, {
    flags: { member: "value" },
    positional: "email",
    requireOneOf: [["member", "email"]],
  });
  if (args.help) return null;
  if (args.member) {
    const uid = await brainResolveSlack(ctx.brain, args.member, ctx);
    if (!uid) {
      throw new AiosError(
        "AIOS_E_PROVIDER",
        `Could not resolve teammate '${args.member}' (no brain match).`,
        "Try the email form instead."
      );
    }
    const channel = await openDm(ctx, uid);
    if (args.json) json({ id: uid, dm_channel: channel });
    else print(`${args.member} → ${uid} (dm: ${channel})`);
    return 0;
  }
  const user = (await slackCall(ctx, "users.lookupByEmail", { email: args.email })).user;
  if (args.json) {
    json({ id: user.id, name: user.name, real_name: user.real_name, team_id: user.team_id });
  } else {
    print(`${user.real_name || user.name} → ${user.id}`);
  }
  return 0;
}

export async function cmdChannels(ctx, argv) {
  const args = parseVerbArgs(argv, { flags: { types: "value" } });
  if (args.help) return null;
  const channels = await listConversations(ctx, args.types || "im,public_channel");
  if (args.json) {
    json(channels);
    return 0;
  }
  for (const channel of channels) {
    const label = channel.name || (channel.is_im ? channel.user : channel.id);
    print(`${channel.id}\t${channel.is_im ? "im" : "channel"}\t${label}`);
  }
  return 0;
}

export async function cmdRead(ctx, argv) {
  const args = parseVerbArgs(argv, {
    flags: { target: "value", limit: "value", thread: "value" },
    requireOneOf: [["target"]],
  });
  if (args.help) return null;
  const limit = args.limit ? Number(args.limit) : 20;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AiosError(
      "AIOS_E_USAGE",
      "--limit must be a positive integer.",
      "Example: --limit 20"
    );
  }
  const channel = await resolveTarget(ctx, args.target);
  const result = args.thread
    ? await slackCall(ctx, "conversations.replies", { channel, ts: args.thread, limit })
    : await slackCall(ctx, "conversations.history", { channel, limit });
  const messages = result.messages ?? [];
  if (args.json) {
    json(messages);
    return 0;
  }
  for (const message of [...messages].reverse()) {
    const who = message.user || message.username || message.bot_id || "?";
    print(`[${message.ts}] ${who}: ${(message.text || "").replaceAll("\n", " ")}`);
  }
  return 0;
}

async function post(ctx, channel, text, thread) {
  return slackCall(ctx, "chat.postMessage", {
    channel,
    text,
    thread_ts: thread ?? null,
    as_user: "true",
  });
}

const MESSAGE_FLAGS = {
  target: "value",
  message: "value",
  "message-stdin": "boolean",
  thread: "value",
};

function printSent(args, result) {
  if (args.json) print(JSON.stringify({ ok: true, channel: result.channel, ts: result.ts }));
  else print(`sent → ${result.channel} @ ${result.ts}`);
}

export async function cmdSend(ctx, argv) {
  const args = parseVerbArgs(argv, {
    flags: MESSAGE_FLAGS,
    requireOneOf: [["target"], ["message", "message-stdin"]],
  });
  if (args.help) return null;
  const channel = await resolveTarget(ctx, args.target);
  printSent(args, await post(ctx, channel, await readMessage(args, ctx.stdin), args.thread));
  return 0;
}

export async function cmdDm(ctx, argv) {
  const args = parseVerbArgs(argv, {
    flags: { ...MESSAGE_FLAGS, member: "value" },
    requireOneOf: [
      ["target", "member"],
      ["message", "message-stdin"],
    ],
  });
  if (args.help) return null;
  const channel = args.member
    ? await resolveMemberChannel(ctx, args.member)
    : await resolveTarget(ctx, args.target);
  printSent(args, await post(ctx, channel, await readMessage(args, ctx.stdin), args.thread));
  return 0;
}

export async function cmdReact(ctx, argv) {
  const args = parseVerbArgs(argv, {
    flags: { target: "value", ts: "value", emoji: "value" },
    requireOneOf: [["target"], ["ts"], ["emoji"]],
  });
  if (args.help) return null;
  const channel = await resolveTarget(ctx, args.target);
  await slackCall(ctx, "reactions.add", {
    channel,
    timestamp: args.ts,
    name: args.emoji.replace(/^:+|:+$/g, ""),
  });
  print("ok");
  return 0;
}
