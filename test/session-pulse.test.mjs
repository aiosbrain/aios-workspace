// Session pulse Stop hook (AIO-214) — spawns hooks/session-pulse.mjs with a realistic
// analyze-state fixture and asserts the pulse format, the 45-min throttle, the 24h missing-state
// suggestion throttle, and the never-block guarantees (garbage stdin, non-Stop events, recursion
// guard). Also asserts buildLastSummary's shape.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLastSummary } from "../scripts/analyze/report.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "hooks", "session-pulse.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "session-pulse-"));
}

function writeSummary(dir, summary) {
  const p = path.join(dir, ".aios", "analyze-state.json");
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      last_run: summary.generated_at,
      sources: {},
      last_summary: summary,
    })
  );
}

function runHook(dir, payload, { rawInput, env } = {}) {
  const input = rawInput !== undefined ? rawInput : JSON.stringify(payload);
  try {
    const out = execFileSync("node", [HOOK], {
      input,
      // Isolate the machine-global deep-work preference from the developer's real Claude config.
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, HOME: path.join(dir, "home"), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout: out.toString("utf8") };
  } catch (e) {
    return { code: e.status ?? 1, stdout: (e.stdout || "").toString("utf8") };
  }
}

function summary(over = {}) {
  return {
    generated_at: new Date().toISOString(),
    window: { since: "2026-06-27", until: "2026-07-04" },
    spine: "L4",
    overall: 2.8,
    weakest: "context_hygiene",
    weakest_tip: "Cache more of your context.",
    ce_band: 2,
    attention_reading: "steady",
    ce_tip: "protect your focus blocks",
    ...over,
  };
}

test("hook file: executable bit set + node shebang", () => {
  assert.ok(statSync(HOOK).mode & 0o111, "hooks/session-pulse.mjs is executable");
  assert.equal(readFileSync(HOOK, "utf8").split("\n")[0], "#!/usr/bin/env node");
});

test("fresh summary → one concise aios tip", () => {
  const dir = ws();
  try {
    writeSummary(dir, summary());
    const { code, stdout } = runHook(dir, { hook_event_name: "Stop" });
    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.match(
      parsed.systemMessage,
      /^aios tip: Cache more of your context\.$/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("immediate rerun → throttled (no output)", () => {
  const dir = ws();
  try {
    writeSummary(dir, summary());
    const first = runHook(dir, { hook_event_name: "Stop" });
    assert.equal(first.stdout.trim().length > 0, true);
    const second = runHook(dir, { hook_event_name: "Stop" });
    assert.equal(second.code, 0);
    assert.equal(second.stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summary older than 24h → message names stale data and the analyze action", () => {
  const dir = ws();
  try {
    writeSummary(
      dir,
      summary({ generated_at: new Date(Date.now() - 30 * 3_600_000).toISOString() })
    );
    const { code, stdout } = runHook(dir, { hook_event_name: "Stop" });
    assert.equal(code, 0);
    assert.match(stdout, /data 1d ago old — run aios analyze/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing state → at most one analyze suggestion per 24h", () => {
  const dir = ws();
  try {
    const first = runHook(dir, { hook_event_name: "Stop" });
    assert.equal(first.code, 0);
    assert.match(first.stdout, /^\{"systemMessage":"aios tip: run `aios analyze` once to start maturity tracking\."\}/);
    const second = runHook(dir, { hook_event_name: "Stop" });
    assert.equal(second.code, 0);
    assert.equal(second.stdout.trim(), "", "second suggestion within 24h must be silent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deep-work → silent without changing throttle state", () => {
  const dir = ws();
  const home = path.join(dir, "home");
  try {
    writeSummary(dir, summary());
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    writeFileSync(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ preferredNotifChannel: "notifications_disabled" })
    );
    const { code, stdout } = runHook(dir, { hook_event_name: "Stop" }, { env: { HOME: home } });
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "");
    assert.equal(statSync(path.join(dir, ".aios", "session-pulse-state.json"), { throwIfNoEntry: false }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("garbage stdin → exit 0, silent", () => {
  const dir = ws();
  try {
    const { code, stdout } = runHook(dir, null, { rawInput: "not json at all {{{" });
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-Stop event → nothing", () => {
  const dir = ws();
  try {
    writeSummary(dir, summary());
    const { code, stdout } = runHook(dir, { hook_event_name: "Notification", message: "x" });
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop_hook_active → nothing (no recursion)", () => {
  const dir = ws();
  try {
    writeSummary(dir, summary());
    const { code, stdout } = runHook(dir, { hook_event_name: "Stop", stop_hook_active: true });
    assert.equal(code, 0);
    assert.equal(stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildLastSummary: shape matches the hook's dumb-reader contract", () => {
  const result = {
    window: { since: "2026-06-27", until: "2026-07-04" },
    placement: {
      spine: "L4",
      overall: 2.8,
      weakest: "context_hygiene",
      axes: {
        verification: 4,
        context_hygiene: 1,
        autonomy: 3,
        learning: 3,
        cost_governance: 2,
      },
    },
    signals: {
      delegation_ratio: 0.3,
      correction_loop_avg: 1.2,
      error_rate: 0.05,
      cost_per_task: 0.4,
      tokens_per_task: 30_000,
      cache_hit_rate: 0.8,
      tool_diversity: 8,
      verify_tool_rate: 0.3,
      subagent_usage: 0.5,
      context_switch_rate: 2,
      focus_block_avg_min: 40,
      interrupts_per_hour: 1,
      concurrent_sessions_peak: 1,
    },
    days: [],
  };
  const s = buildLastSummary(result);
  assert.deepEqual(
    Object.keys(s).sort(),
    [
      "attention_reading",
      "ce_band",
      "ce_tip",
      "generated_at",
      "overall",
      "spine",
      "weakest",
      "weakest_tip",
      "window",
    ].sort()
  );
  assert.equal(s.spine, "L4");
  assert.equal(s.overall, 2.8);
  assert.equal(s.weakest, "context_hygiene");
  assert.equal(typeof s.weakest_tip, "string");
  assert.ok(s.generated_at); // ISO timestamp
});
