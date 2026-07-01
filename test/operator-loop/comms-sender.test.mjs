import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchOnEvent,
  canChannelReceive,
  detectEvents,
  defaultCommsConfig,
  parseCommsConfig,
} from "../../dist/operator-loop/index.js";

// A recording transport so we can assert send happened (or didn't) and with what.
function recorder() {
  const sends = [];
  return {
    send: (msg) => {
      sends.push(msg);
      return { ok: true };
    },
    sends,
  };
}

const ref = (tier) => ({ path: "3-log/decision-log.md", row: "d1", tier });
const event = (tier, extra = {}) => ({
  kind: "decision",
  tier,
  summary: "Ship v1",
  ref: ref(tier),
  ...extra,
});

function config({ channel = "#loop", channels = { "#loop": "team" }, defaultChannel = null } = {}) {
  const cfg = defaultCommsConfig();
  cfg.sender.channel = channel;
  cfg.slack.defaultChannel = defaultChannel;
  cfg.channels = new Map(Object.entries(channels));
  return cfg;
}

test("canChannelReceive: team channel takes team+external, refuses admin; external takes only external", () => {
  assert.equal(canChannelReceive("team", "team"), true);
  assert.equal(canChannelReceive("team", "external"), true);
  assert.equal(canChannelReceive("team", "admin"), false);
  assert.equal(canChannelReceive("external", "external"), true);
  assert.equal(canChannelReceive("external", "team"), false); // team content must NOT reach an external channel
  assert.equal(canChannelReceive("external", "admin"), false);
});

test("sender: authorized team message to a team channel is formatted + sent with evidence ref", async () => {
  const { send, sends } = recorder();
  const res = await dispatchOnEvent(event("team"), config(), { send });
  assert.equal(res.status, "sent");
  assert.equal(res.channel, "#loop");
  assert.equal(res.channelTier, "team");
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Ship v1/);
  assert.match(sends[0].text, /decision-log\.md#d1/); // triggering evidence referenced
});

test("sender (BLOCKER): team message to an external channel is rejected — NOT sent", async () => {
  const { send, sends } = recorder();
  const res = await dispatchOnEvent(
    event("team"),
    config({ channel: "#clients", channels: { "#clients": "external" } }),
    { send }
  );
  assert.equal(res.status, "rejected");
  assert.equal(res.reason, "audience-not-authorized");
  assert.equal(res.channelTier, "external");
  assert.equal(sends.length, 0);
});

test("sender: admin content is NEVER emitted outward, whatever the channel is configured as", async () => {
  const { send, sends } = recorder();
  // Even an admin-tier channel (owner-only) must not receive admin content via the sender.
  const res = await dispatchOnEvent(
    event("admin"),
    config({ channel: "#private", channels: { "#private": "admin" } }),
    { send }
  );
  assert.equal(res.status, "rejected");
  assert.equal(res.reason, "admin-never-outbound");
  assert.equal(sends.length, 0);
});

test("sender: an unresolvable destination channel is default-denied (no send)", async () => {
  const { send, sends } = recorder();
  const res = await dispatchOnEvent(
    event("team"),
    config({ channel: "#unknown", channels: { "#loop": "team" } }),
    { send }
  );
  assert.equal(res.status, "rejected");
  assert.equal(res.reason, "unresolvable-destination-tier");
  assert.equal(sends.length, 0);
});

test("sender: destination falls back to slack.defaultChannel when sender.channel is null", async () => {
  const { send, sends } = recorder();
  const cfg = config({
    channel: null,
    defaultChannel: "#general",
    channels: { "#general": "team" },
  });
  const res = await dispatchOnEvent(event("team"), cfg, { send });
  assert.equal(res.status, "sent");
  assert.equal(res.channel, "#general");
  assert.equal(sends.length, 1);
});

test("sender: no destination channel configured → rejected before any send", async () => {
  const { send, sends } = recorder();
  const cfg = config({ channel: null, defaultChannel: null });
  const res = await dispatchOnEvent(event("team"), cfg, { send });
  assert.equal(res.status, "rejected");
  assert.equal(res.reason, "no-destination-channel");
  assert.equal(sends.length, 0);
});

test("detectEvents: decision Type 2/3, scope change, task assignment, deliverable status, stale inbox", () => {
  const now = new Date("2026-07-01T00:00:00Z");
  const sig = (o) => ({
    kind: o.kind,
    source: o.source ?? o.kind,
    tier: o.tier ?? "team",
    occurredAt: o.occurredAt ?? "2026-07-01T00:00:00Z",
    ref: { path: "p", row: o.row ?? "r", tier: o.tier ?? "team" },
    summary: o.summary ?? "s",
    payload: o.payload ?? {},
  });

  const events = detectEvents(
    [
      sig({ kind: "decision", summary: "Adopt X", payload: { type: "Type 3" } }),
      sig({ kind: "decision", summary: "Cut scope of feature Y", payload: { type: "1" } }),
      sig({ kind: "decision", summary: "Minor tweak", payload: { type: "1" } }), // Type 1, no scope → no event
      sig({ kind: "task", summary: "Do thing", payload: { assignee: "sam", due: "2026-07-05" } }),
      sig({ kind: "task", summary: "Unassigned", payload: { assignee: "" } }), // no assignee → no event
      sig({
        kind: "deliverable",
        summary: "Report",
        payload: { status: "in-review", owner: "alex" },
      }),
      sig({ kind: "inbox", summary: "Old note", occurredAt: "2026-06-01T00:00:00Z" }), // 30d → stale
      sig({ kind: "inbox", summary: "Fresh note", occurredAt: "2026-06-30T00:00:00Z" }), // 1d → not stale
    ],
    now
  );

  const byKind = events.map((e) => e.kind);
  assert.deepEqual(byKind, [
    "decision", // Type 3
    "scope-change", // "scope" in summary wins
    "task-assignment",
    "deliverable-status",
    "stale-inbox",
  ]);
  const assignment = events.find((e) => e.kind === "task-assignment");
  assert.equal(assignment.waitingOn, "sam");
  assert.equal(assignment.dueAt, "2026-07-05");
});

test("parseCommsConfig: rejects a channel with an invalid tier (never silently up-scopes)", () => {
  assert.throws(
    () => parseCommsConfig({ channels: { "#x": "public" } }),
    /channels\["#x"\] must be one of admin\|team\|external/
  );
});

test("parseCommsConfig: rejects a non-positive lookbackHours", () => {
  assert.throws(
    () => parseCommsConfig({ lookbackHours: 0 }),
    /lookbackHours must be a positive number/
  );
});
