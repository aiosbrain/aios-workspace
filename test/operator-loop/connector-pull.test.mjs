import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";

import { dailyConnectorCommands, pullDailyConnectors } from "../../dist/operator-loop/index.js";
import {
  appendActivity,
  collectSlackUnread,
  resolveSlackToken,
} from "../../scaffold/.claude/descriptors/skills/slack-personal/slack-activity-pull.mjs";

function adapters() {
  const root = mkdtempSync(path.join(tmpdir(), "aio-366-connectors-"));
  for (const command of dailyConnectorCommands(root, new Date("2026-07-13T10:00:00Z"))) {
    mkdirSync(path.dirname(command.file), { recursive: true });
    writeFileSync(command.file, "// fixture\n");
  }
  return root;
}

function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.signalCode = signal;
    queueMicrotask(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

test("daily connector definitions retain all three manual adapters and today's Granola bound", () => {
  const root = adapters();
  const commands = dailyConnectorCommands(root, new Date("2026-07-13T23:59:59Z"));
  assert.deepEqual(
    commands.map((command) => command.name),
    ["granola", "gog", "slack"]
  );
  assert.match(commands[0].file, /granola-direct\/granola-pull\.mjs$/);
  assert.deepEqual(commands[0].args.slice(-2), ["--since", "2026-07-13"]);
  assert.match(commands[1].file, /gog-activity\/gog-activity-pull\.mjs$/);
  assert.match(commands[2].file, /slack-personal\/slack-activity-pull\.mjs$/);
});

test("connector phase starts all adapters concurrently and settles each failure/timeout independently", async () => {
  const root = adapters();
  const started = [];
  const credentialMarker = ["fixture", "credential", "marker"].join("-");
  const spawn = (_command, args, options) => {
    const file = args[0];
    const name = file.includes("granola-") ? "granola" : file.includes("gog-") ? "gog" : "slack";
    started.push(name);
    assert.equal(options.stdio, "ignore", "child output cannot contaminate the daily surface");
    assert.equal(options.env.AIOS_API_KEY, credentialMarker, "credentials ride in env, never argv");
    assert.ok(!args.some((arg) => String(arg).includes(credentialMarker)));
    const child = fakeChild();
    if (name === "granola") queueMicrotask(() => child.emit("close", 7, null));
    if (name === "slack") setTimeout(() => child.emit("close", 0, null), 5);
    // GOG deliberately never closes. Its own 20ms timer must release the phase.
    return child;
  };

  const pending = pullDailyConnectors({
    root,
    credentials: { apiKey: credentialMarker },
    timeouts: { granola: 100, gog: 20, slack: 100 },
    spawn,
  });
  assert.deepEqual(started, ["granola", "gog", "slack"], "all start before any result is awaited");

  const result = await pending;
  assert.deepEqual(
    result.connectors.map(({ name, status }) => ({ name, status })),
    [
      { name: "granola", status: "failed" },
      { name: "gog", status: "timed_out" },
      { name: "slack", status: "ok" },
    ]
  );
  assert.ok(
    !JSON.stringify(result).includes(credentialMarker),
    "result details never copy credentials or connector output"
  );
});

test("missing connector adapters are explicit skips and never reject the phase", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aio-366-empty-"));
  let spawned = 0;
  const result = await pullDailyConnectors({
    root,
    spawn() {
      spawned++;
      throw new Error("must not run");
    },
  });
  assert.equal(spawned, 0);
  assert.deepEqual(
    result.connectors.map((connector) => connector.status),
    ["skipped", "skipped", "skipped"]
  );
});

test("Slack unread scan emits only newer inbound user messages from authoritative read markers", async () => {
  const calls = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "auth.test") return { ok: true, user_id: "U-ME" };
    if (method === "conversations.list") {
      return {
        ok: true,
        channels: [
          {
            id: "C-ACTION",
            name: "client-ops",
            last_read: "100.000000",
            unread_count: 2,
            latest: { ts: "102.000000" },
          },
          { id: "D-NO-MARKER", is_im: true, user: "U-X", unread_count: 3 },
          {
            id: "C-CLEAR",
            name: "clear",
            last_read: "200.000000",
            unread_count: 0,
            latest: { ts: "199.000000" },
          },
        ],
        response_metadata: { next_cursor: "" },
      };
    }
    assert.equal(method, "conversations.history");
    assert.equal(params.channel, "C-ACTION");
    assert.equal(params.oldest, "100.000000");
    return {
      ok: true,
      messages: [
        { type: "message", user: "U-STEPHAN", ts: "101.000001", text: "Need this by 4pm\nplease" },
        { type: "message", user: "U-ME", ts: "102.000000", text: "My own reply" },
        { type: "message", user: "U-OLD", ts: "99.000000", text: "already read" },
        { type: "message", bot_id: "B-1", ts: "101.500000", text: "bot chatter" },
      ],
    };
  };

  const result = await collectSlackUnread({ call });
  const listCall = calls.find((entry) => entry.method === "conversations.list");
  assert.equal(listCall.params.types, "public_channel,private_channel,im");
  assert.doesNotMatch(listCall.params.types, /mpim/);
  assert.equal(result.conversations, 3);
  assert.equal(result.scanned, 1);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.records[0], {
    source: "slack",
    tier: "admin",
    occurredAt: "1970-01-01T00:01:41.000Z",
    ref: "slack:C-ACTION:101.000001",
    channel: "#client-ops",
    direction: "inbound",
    summary: "Slack needing reply in #client-ops: Need this by 4pm please",
    waitingOn: "me",
  });
  assert.equal(calls.filter((entry) => entry.method === "conversations.history").length, 1);
});

test("Slack activity append is idempotent by stable ref and tolerates a fresh store", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aio-366-slack-store-"));
  const activityPath = path.join(dir, "1-inbox", "comms", "activity.jsonl");
  const record = {
    source: "slack",
    tier: "admin",
    occurredAt: "2026-07-13T10:00:00.000Z",
    ref: "slack:D1:123.000001",
    channel: "dm:U1",
    direction: "inbound",
    summary: "Slack needing reply in dm:U1: hello",
    waitingOn: "me",
  };
  assert.deepEqual(appendActivity(activityPath, [record]), { written: 1, skipped: 0 });
  assert.deepEqual(appendActivity(activityPath, [record]), { written: 0, skipped: 1 });
  assert.ok(existsSync(activityPath));
  assert.equal(readFileSync(activityPath, "utf8").trim().split("\n").length, 1);

  let fetched = false;
  const directToken = ["fixture", "slack", "token"].join("-");
  const token = await resolveSlackToken({
    env: { SLACK_USER_TOKEN: directToken },
    fetchImpl() {
      fetched = true;
      throw new Error("must not fetch");
    },
  });
  assert.equal(token, directToken);
  assert.equal(fetched, false);
});
