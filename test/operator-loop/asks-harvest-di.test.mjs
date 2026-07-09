// AIO-320 — proves the asks→comms composition seam (Constitution §4). The core `harvestAsks`
// (asks/harvest.js) no longer imports comms; it runs entirely on injected deps. Here we inject
// stubs and assert they are the ones invoked — no real comms config/detectors/sender is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { harvestAsks } from "../../dist/operator-loop/asks/harvest.js";

test("core harvestAsks runs on injected deps (no direct comms reach)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "asks-di-"));
  try {
    const calls = { loadCommsConfig: 0, detectEvents: 0, dispatchOnEvent: 0 };
    const stubEvent = {
      kind: "test",
      ref: { path: "inbox/x.md", row: "1" },
      summary: "s",
      tier: "team",
    };
    const deps = {
      loadCommsConfig: () => {
        calls.loadCommsConfig++;
        return { sender: {}, slack: {}, channels: {} };
      },
      detectEvents: () => {
        calls.detectEvents++;
        return [stubEvent];
      },
      dispatchOnEvent: async () => {
        calls.dispatchOnEvent++;
        return { status: "sent", receipt: { id: "ask_1" } };
      },
    };

    const res = await harvestAsks(
      dir,
      { cadence: "daily", now: new Date("2026-07-09T12:00:00Z") },
      deps
    );

    assert.equal(calls.loadCommsConfig, 1, "injected loadCommsConfig was used");
    assert.equal(calls.detectEvents, 1, "injected detectEvents was used");
    assert.equal(calls.dispatchOnEvent, 1, "injected dispatchOnEvent was used");
    assert.equal(res.events, 1);
    assert.equal(res.delivered, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
