// AIO-354 — scaffold .aios/comms-config.json by default. A real (non-interactive)
// `scaffold-project.sh` run must stamp a starter .aios/comms-config.json that:
//   1. is valid JSON (JSON can't carry real comments, so guidance lives in a
//      `_comment`/`_docs` key, per the convention this test locks in)
//   2. parses cleanly through the real operator-loop config loader (src/operator-loop/
//      comms/config.ts, compiled to dist/) into a config that is a CLEAN NO-OP: no
//      channels resolvable, no destination channel configured
//   3. is mentioned in the stamped .claude/CLAUDE.md where tool connections are described

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommsConfig, resolveChannelTier } from "../dist/operator-loop/comms/config.js";
import { dispatchOnEvent } from "../dist/operator-loop/comms/sender.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAFFOLD_SCRIPT = path.join(ROOT, "scripts", "scaffold-project.sh");

function scaffold(output) {
  execFileSync(
    "bash",
    [
      SCAFFOLD_SCRIPT,
      "--context",
      "employee",
      "--slug",
      "test-ws",
      "--owner",
      "tester",
      "--output",
      output,
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
}

function tmpOut(prefix) {
  const output = mkdtempSync(path.join(tmpdir(), prefix));
  rmSync(output, { recursive: true, force: true });
  return output;
}

test("scaffold stamps .aios/comms-config.json by default, valid JSON", () => {
  const output = tmpOut("scaffold-comms-json-");
  try {
    scaffold(output);
    const file = path.join(output, ".aios", "comms-config.json");
    assert.ok(existsSync(file), ".aios/comms-config.json must be stamped by default");
    const raw = readFileSync(file, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw), "stamped comms-config.json must be valid JSON");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("stamped comms-config.json parses to a clean no-op config (nothing auto-dispatches)", () => {
  const output = tmpOut("scaffold-comms-noop-");
  try {
    scaffold(output);
    const file = path.join(output, ".aios", "comms-config.json");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const cfg = parseCommsConfig(parsed, file);

    // Default-deny: no channel is resolvable.
    assert.equal(cfg.channels.size, 0);
    assert.equal(resolveChannelTier(cfg, "#anything"), null);
    // No destination configured either way.
    assert.equal(cfg.sender.channel, null);
    assert.equal(cfg.slack.defaultChannel, null);

    // End-to-end: dispatching a real event against this exact config is a clean,
    // non-throwing no-op — never sent, never crashes on a bare scaffold.
    let sent = false;
    const result = dispatchOnEvent(
      {
        kind: "decision",
        tier: "team",
        summary: "test",
        ref: { path: "3-log/decision-log.md", row: 1, tier: "team" },
      },
      cfg,
      {
        send: () => {
          sent = true;
        },
      }
    );
    return result.then((r) => {
      assert.equal(sent, false);
      assert.equal(r.status, "rejected");
      assert.equal(r.reason, "no-destination-channel");
    });
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test("stamped .claude/CLAUDE.md mentions .aios/comms-config.json where tool connections are described", () => {
  const output = tmpOut("scaffold-comms-doc-");
  try {
    scaffold(output);
    const claudeMd = readFileSync(path.join(output, ".claude", "CLAUDE.md"), "utf8");
    assert.match(claudeMd, /\.aios\/comms-config\.json/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
