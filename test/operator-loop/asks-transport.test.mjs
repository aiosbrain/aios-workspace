// Asks inbox transport (AIO-167) — the sink runs on the SAME `dispatchOnEvent` gate as the Slack
// sender. A team event lands as a structured ask; admin content is never written (the gate rejects
// it before the sink runs); an untriggered event is a no-op; and the additive `sendEvent` hook
// doesn't break plain send-only deps.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  dispatchOnEvent,
  defaultCommsConfig,
  createInboxTransport,
  readAsks,
} from "../../dist/operator-loop/index.js";

function ws() {
  return mkdtempSync(path.join(tmpdir(), "asks-transport-"));
}
function config({ channel = "#loop", channels = { "#loop": "team" } } = {}) {
  const cfg = defaultCommsConfig();
  cfg.sender.channel = channel;
  cfg.channels = new Map(Object.entries(channels));
  return cfg;
}
const event = (tier, extra = {}) => ({
  kind: "decision",
  tier,
  summary: "Ship v1",
  ref: { path: "3-log/decision-log.md", row: "d1", tier },
  ...extra,
});

test("team-tier event lands as a structured ask (severity + ref + tier), not just text", async () => {
  const root = ws();
  try {
    const res = await dispatchOnEvent(event("team"), config(), createInboxTransport(root));
    assert.equal(res.status, "sent");
    const { asks } = readAsks(root);
    assert.equal(asks.length, 1);
    assert.equal(asks[0].kind, "decision");
    assert.equal(asks[0].severity, "decision"); // decision + task-assignment → decision
    assert.equal(asks[0].ref, "3-log/decision-log.md#d1");
    assert.equal(asks[0].tier, "team");
    assert.equal(asks[0].source, "transport:decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-decision event (e.g. stale-inbox) maps to fyi severity", async () => {
  const root = ws();
  try {
    await dispatchOnEvent(
      event("team", { kind: "stale-inbox" }),
      config(),
      createInboxTransport(root)
    );
    const { asks } = readAsks(root);
    assert.equal(asks[0].severity, "fyi");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admin-tier content is rejected by the gate — the sink writes NOTHING", async () => {
  const root = ws();
  try {
    const res = await dispatchOnEvent(
      event("admin"),
      config({ channel: "#private", channels: { "#private": "admin" } }),
      createInboxTransport(root)
    );
    assert.equal(res.status, "rejected");
    assert.equal(res.reason, "admin-never-outbound");
    assert.equal(readAsks(root).asks.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untriggered event (sender.on gate) is a no-op — nothing written", async () => {
  const root = ws();
  try {
    const cfg = config();
    cfg.sender.on = ["scope-change"];
    const res = await dispatchOnEvent(event("team"), cfg, createInboxTransport(root));
    assert.equal(res.status, "noop");
    assert.equal(readAsks(root).asks.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dedupeKey option is stamped onto the created ask (open-ask suppression on re-harvest)", async () => {
  const root = ws();
  try {
    await dispatchOnEvent(event("team"), config(), createInboxTransport(root, { dedupeKey: "K9" }));
    assert.equal(readAsks(root).asks[0].dedupeKey, "K9");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("send-only back-compat: a plain { send } deps still dispatches (additive change is safe)", async () => {
  const sends = [];
  const res = await dispatchOnEvent(event("team"), config(), {
    send: (m) => (sends.push(m), { ok: true }),
  });
  assert.equal(res.status, "sent");
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /Ship v1/);
});
