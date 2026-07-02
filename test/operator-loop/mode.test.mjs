// Attention mode (AIO-168) — deep-work silences preferredNotifChannel, orchestration restores the
// exact prior value INCLUDING absence, push stays untouched, malformed settings are never clobbered.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  NOTIF_DISABLED_VALUE,
  modeStatus,
  enterDeepWork,
  enterOrchestration,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const AIOS = path.join(ROOT, "scripts", "aios.mjs");

function fixture(settings) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-mode-"));
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { dir, paths: { settingsPath, statePath: path.join(dir, "aios-mode.json") } };
}
const readSettings = (p) => JSON.parse(readFileSync(p.settingsPath, "utf8"));

test("deep-work with a PRESENT prior channel: silenced, then restored byte-equal", () => {
  const { dir, paths } = fixture({ preferredNotifChannel: "iterm2", agentPushNotifEnabled: true });
  try {
    const dw = enterDeepWork(paths);
    assert.equal(dw.changed, true);
    assert.equal(readSettings(paths).preferredNotifChannel, NOTIF_DISABLED_VALUE);
    assert.equal(modeStatus(paths).mode, "deep-work");

    const back = enterOrchestration(paths);
    assert.equal(back.changed, true);
    assert.equal(readSettings(paths).preferredNotifChannel, "iterm2", "exact prior value restored");
    assert.equal(modeStatus(paths).mode, "orchestration");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deep-work with an ABSENT prior channel: restore deletes the key (default), never guesses", () => {
  const { dir, paths } = fixture({ agentPushNotifEnabled: true, model: "opus" });
  try {
    enterDeepWork(paths);
    assert.equal(readSettings(paths).preferredNotifChannel, NOTIF_DISABLED_VALUE);
    enterOrchestration(paths);
    const after = readSettings(paths);
    assert.ok(!("preferredNotifChannel" in after), "absent key restored to absent");
    assert.equal(after.model, "opus", "unrelated keys preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agentPushNotifEnabled is never touched by either direction", () => {
  const { dir, paths } = fixture({ agentPushNotifEnabled: true });
  try {
    enterDeepWork(paths);
    assert.equal(readSettings(paths).agentPushNotifEnabled, true);
    enterOrchestration(paths);
    assert.equal(readSettings(paths).agentPushNotifEnabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("idempotency: repeated deep-work / orchestration are no-ops and never corrupt the memory", () => {
  const { dir, paths } = fixture({ preferredNotifChannel: "bell" });
  try {
    assert.equal(enterDeepWork(paths).changed, true);
    assert.equal(enterDeepWork(paths).changed, false, "second deep-work is a no-op");
    assert.equal(enterOrchestration(paths).changed, true);
    assert.equal(
      readSettings(paths).preferredNotifChannel,
      "bell",
      "double deep-work did not overwrite the memory with notifications_disabled"
    );
    assert.equal(enterOrchestration(paths).changed, false, "second orchestration is a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore with a missing/corrupt sidecar falls back to deleting the key", () => {
  const { dir, paths } = fixture({ preferredNotifChannel: "iterm2" });
  try {
    enterDeepWork(paths);
    writeFileSync(paths.statePath, "{corrupt");
    enterOrchestration(paths);
    assert.ok(!("preferredNotifChannel" in readSettings(paths)), "falls back to unset (default)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed settings file: command aborts, file is not clobbered", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-mode-"));
  const settingsPath = path.join(dir, "settings.json");
  writeFileSync(settingsPath, "{not json");
  try {
    assert.throws(() => enterDeepWork({ settingsPath, statePath: path.join(dir, "s.json") }));
    assert.equal(readFileSync(settingsPath, "utf8"), "{not json", "original bytes untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: offline routing + --settings override + --json round-trip", () => {
  const { dir, paths } = fixture({ preferredNotifChannel: "iterm2" });
  const bare = mkdtempSync(path.join(tmpdir(), "aios-mode-bare-")); // no aios.yaml
  try {
    const run = (args) =>
      JSON.parse(
        execFileSync(
          "node",
          [AIOS, "mode", ...args, "--repo", bare, "--settings", paths.settingsPath, "--json"],
          { cwd: bare, encoding: "utf8" }
        )
      );
    assert.equal(run(["status"]).mode, "orchestration");
    assert.equal(run([]).mode, "orchestration", "bare `aios mode --json` defaults to status");
    const dw = run(["deep-work"]);
    assert.equal(dw.mode, "deep-work");
    assert.equal(dw.changed, true);
    assert.equal(readSettings(paths).preferredNotifChannel, NOTIF_DISABLED_VALUE);
    const back = run(["orchestration"]);
    assert.equal(back.channel, "iterm2");
    assert.ok(existsSync(paths.settingsPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("stale sidecar after a hand-edit cannot restore an outdated channel", () => {
  const { dir, paths } = fixture({ preferredNotifChannel: "iterm2" });
  try {
    enterDeepWork(paths); // sidecar remembers "iterm2"
    // Hand-edit: user flips the channel to "bell" themselves (now in orchestration).
    const s1 = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
    s1.preferredNotifChannel = "bell";
    writeFileSync(paths.settingsPath, JSON.stringify(s1, null, 2) + "\n");
    assert.equal(enterOrchestration(paths).changed, false, "no-op, but consumes the stale sidecar");
    assert.ok(!existsSync(paths.statePath), "sidecar consumed on the no-op path");
    // Hand-edit: user sets notifications_disabled directly, then asks aios to restore.
    const s2 = JSON.parse(readFileSync(paths.settingsPath, "utf8"));
    s2.preferredNotifChannel = "notifications_disabled";
    writeFileSync(paths.settingsPath, JSON.stringify(s2, null, 2) + "\n");
    enterOrchestration(paths);
    const after = readSettings(paths);
    assert.ok(
      !("preferredNotifChannel" in after),
      "no stale memory: falls back to unset instead of resurrecting iterm2"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
