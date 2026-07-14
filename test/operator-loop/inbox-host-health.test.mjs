// Inbox host health — adapter supervision → AttentionItem projection (I-15 / AIO-396, the G6b gate).
//
// The named acceptance check: "Kill an adapter process → within the supervision window an
// AttentionItem with origin: agent-event appears in the queue" — the supervisor is FAKED locally
// (deterministic events with an injected clock; no live Fly machine, no real process). This suite
// drives the pure supervision fold, the health→AttentionItem projection, the durable host-health
// state file, and the end-to-end merge into `aios inbox --json` / `aios inbox status`.
//
// Runs against the COMPILED barrel (`dist/operator-loop/index.js`) — `npm run build:loop` first.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SUPERVISOR_POLICY,
  foldSupervisor,
  isUnhealthy,
  healthToInboxItem,
  unhealthyInboxItems,
  coordinatorHealthSummary,
  sanitizeAdapterHealth,
  writeHostHealth,
  readHostHealth,
  hostHealthPath,
  MAX_DETAIL_LEN,
} from "../../dist/operator-loop/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");

function ws() {
  return mkdtempSync(path.join(tmpdir(), "inbox-host-health-"));
}
function runInbox(dir, args) {
  try {
    const stdout = execFileSync("node", [CLI, "inbox", ...args, "--repo", dir], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// A deterministic clock — fixed epoch base so every fold result is reproducible.
const T0 = Date.UTC(2026, 6, 14, 12, 0, 0);
const at = (secs) => T0 + secs * 1000;
const ISO = (ms) => new Date(ms).toISOString();

test("a healthy adapter (start→ready→heartbeat) is healthy and produces NO attention item", () => {
  const events = [
    { adapter: "gmail", kind: "start", at: at(0) },
    { adapter: "gmail", kind: "ready", at: at(1) },
    { adapter: "gmail", kind: "heartbeat", at: at(30) },
  ];
  const health = foldSupervisor(events, DEFAULT_SUPERVISOR_POLICY, at(35));
  const g = health.get("gmail");
  assert.equal(g.state, "healthy");
  assert.equal(g.healthy, true);
  assert.equal(isUnhealthy(g), false);
  assert.deepEqual(unhealthyInboxItems(health.values(), ISO(at(35))), []);
});

test("KILL an adapter → within the supervision window an origin:agent-event AttentionItem appears", () => {
  // gmail starts healthy, then is KILLED. As of a moment inside the backoff window it is degraded.
  const events = [
    { adapter: "gmail", kind: "start", at: at(0) },
    { adapter: "gmail", kind: "ready", at: at(1) },
    { adapter: "gmail", kind: "kill", at: at(10), reason: "SIGKILL" },
  ];
  const asOf = at(11); // inside the backoff window (backoff base 1s → until at(11))
  const health = foldSupervisor(events, DEFAULT_SUPERVISOR_POLICY, asOf);
  const g = health.get("gmail");
  assert.equal(isUnhealthy(g), true, "a killed adapter is unhealthy within the window");
  assert.equal(g.restarts, 1);

  const item = healthToInboxItem(g, ISO(asOf));
  assert.equal(item.origin, "agent-event", "host-health rows ride the agent-event queue");
  assert.equal(item.protected, true, "a degraded adapter is protected (above the fold)");
  assert.equal(item.health.adapter, "gmail");
  assert.equal(item.action_state, "none");
  assert.equal(item.attention_state, "surfaced");
  assert.match(item.id, /^host-health:gmail$/);
});

test("the killed-adapter AttentionItem surfaces end-to-end in `aios inbox --json`", () => {
  const dir = ws();
  try {
    // The coordinator's supervision tick would write this after observing the kill. We fake that
    // write directly (the supervisor is faked locally) and prove the CLI merges + protects it.
    const health = foldSupervisor(
      [
        { adapter: "telegram", kind: "start", at: at(0) },
        { adapter: "telegram", kind: "ready", at: at(1) },
        { adapter: "telegram", kind: "kill", at: at(10) },
      ],
      DEFAULT_SUPERVISOR_POLICY,
      at(11)
    );
    writeHostHealth(dir, health.values(), ISO(at(11)));

    const res = runInbox(dir, ["--json"]);
    assert.equal(res.code, 0, res.stderr);
    const view = JSON.parse(res.stdout);
    const row = view.items.find(
      (i) => i.origin === "agent-event" && i.health?.adapter === "telegram"
    );
    assert.ok(
      row,
      "the killed telegram adapter appears as an agent-event AttentionItem in the queue"
    );
    assert.equal(row.protected, true);
    // Protected rows render above the fold — it is first in the ranked order.
    assert.equal(view.items[0].id, row.id, "the protected health item ranks above the rest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`aios inbox status --json` reports coordinator degraded + exit 1 when an adapter is down", () => {
  const dir = ws();
  try {
    const health = foldSupervisor(
      [
        { adapter: "gmail", kind: "start", at: at(0) },
        { adapter: "gmail", kind: "ready", at: at(1) },
        { adapter: "telegram", kind: "start", at: at(0) },
        { adapter: "telegram", kind: "ready", at: at(1) },
        { adapter: "telegram", kind: "kill", at: at(10) },
      ],
      DEFAULT_SUPERVISOR_POLICY,
      at(11)
    );
    writeHostHealth(dir, health.values(), ISO(at(11)));

    const res = runInbox(dir, ["status", "--json"]);
    assert.equal(res.code, 1, "degraded coordinator exits non-zero");
    const status = JSON.parse(res.stdout);
    assert.equal(status.coordinator_ok, false);
    assert.equal(status.counts.total, 2);
    assert.equal(status.counts.degraded, 1);
    assert.ok(status.adapters.find((a) => a.adapter === "telegram" && !a.healthy));
    assert.ok(status.adapters.find((a) => a.adapter === "gmail" && a.healthy));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("`aios inbox status` with no host-health state is clean (local-only run) and exits 0", () => {
  const dir = ws();
  try {
    const res = runInbox(dir, ["status", "--json"]);
    assert.equal(res.code, 0);
    const status = JSON.parse(res.stdout);
    assert.equal(status.coordinator_ok, true);
    assert.equal(status.counts.total, 0);
    assert.equal(readHostHealth(dir), null, "no state file present");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("crash-loop detection: N exits inside the window escalate to crash-looping", () => {
  const p = { ...DEFAULT_SUPERVISOR_POLICY, crashLoopThreshold: 3, crashWindowMs: 120_000 };
  const events = [
    { adapter: "gmail", kind: "exit", at: at(0), code: 1 },
    { adapter: "gmail", kind: "exit", at: at(5), code: 1 },
    { adapter: "gmail", kind: "exit", at: at(10), code: 1 },
  ];
  const g = foldSupervisor(events, p, at(11)).get("gmail");
  assert.equal(g.state, "crash-looping");
  assert.equal(g.recentExits, 3);
  assert.equal(isUnhealthy(g), true);
});

test("an exited adapter stays surfaced through the backoff window and only an explicit restart clears it", () => {
  const p = { ...DEFAULT_SUPERVISOR_POLICY, backoffBaseMs: 1000, backoffFactor: 2 };
  const exited = [{ adapter: "gmail", kind: "exit", at: at(0), code: 1 }];
  // Inside the backoff window: down.
  assert.equal(foldSupervisor(exited, p, at(0) + 500).get("gmail").state, "backoff");
  // PAST the backoff window but with NO restart events: it MUST remain surfaced (not silently healthy).
  const stillDown = foldSupervisor(exited, p, at(0) + 5000).get("gmail");
  assert.equal(
    isUnhealthy(stillDown),
    true,
    "an un-recovered adapter is not auto-cleared by the timer"
  );
  // An explicit restart (start→ready) is what clears it.
  const recovered = foldSupervisor(
    [
      ...exited,
      { adapter: "gmail", kind: "start", at: at(2) },
      { adapter: "gmail", kind: "ready", at: at(3) },
    ],
    p,
    at(4)
  ).get("gmail");
  assert.equal(recovered.state, "healthy");
  assert.equal(isUnhealthy(recovered), false);
});

test("heartbeat-timeout: a healthy adapter whose heartbeat lapses becomes unhealthy", () => {
  const p = { ...DEFAULT_SUPERVISOR_POLICY, heartbeatTimeoutMs: 90_000 };
  const events = [
    { adapter: "gmail", kind: "start", at: at(0) },
    { adapter: "gmail", kind: "ready", at: at(1) },
    { adapter: "gmail", kind: "heartbeat", at: at(30) },
  ];
  const stillOk = foldSupervisor(events, p, at(60)).get("gmail"); // 30s since last beat < 90s
  assert.equal(stillOk.state, "healthy");
  const lapsed = foldSupervisor(events, p, at(30) + 91_000).get("gmail"); // > 90s since last beat
  assert.equal(lapsed.state, "unhealthy");
  assert.equal(isUnhealthy(lapsed), true);
});

test("maxRestarts exceeded parks the adapter as stopped (no auto-retry)", () => {
  const p = { ...DEFAULT_SUPERVISOR_POLICY, maxRestarts: 2, crashLoopThreshold: 99 };
  const events = [
    { adapter: "gmail", kind: "exit", at: at(0), code: 1 },
    { adapter: "gmail", kind: "exit", at: at(5), code: 1 },
    { adapter: "gmail", kind: "exit", at: at(10), code: 1 },
  ];
  const g = foldSupervisor(events, p, at(11)).get("gmail");
  assert.equal(g.state, "stopped");
  assert.equal(g.restarts, 3);
  assert.equal(isUnhealthy(g), true);
});

// ── defensive validation of the (untrusted) host-health state file ─────────────────────────────────

function writeRawHostHealth(dir, obj) {
  mkdirSync(path.dirname(hostHealthPath(dir)), { recursive: true });
  writeFileSync(hostHealthPath(dir), typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
}

test("sanitizeAdapterHealth drops records with a missing id or an unknown state (fail closed)", () => {
  assert.equal(sanitizeAdapterHealth(null), null);
  assert.equal(sanitizeAdapterHealth("not-an-object"), null);
  assert.equal(sanitizeAdapterHealth({ state: "healthy" }), null, "no adapter id → dropped");
  assert.equal(
    sanitizeAdapterHealth({ adapter: "gmail", state: "totally-bogus" }),
    null,
    "unknown state → dropped"
  );
  assert.equal(
    sanitizeAdapterHealth({ adapter: "!!!", state: "healthy" }),
    null,
    "id with no safe chars → dropped"
  );
});

test("sanitizeAdapterHealth coerces field types and re-derives `healthy` from state (never trusts it)", () => {
  const clean = sanitizeAdapterHealth({
    adapter: "gmail",
    state: "crash-looping",
    healthy: true, // a LIE — must be overridden to false
    restarts: -5, // invalid → 0
    recentExits: "9", // wrong type → 0
    lastExitCode: 137.9, // floored
    lastHeartbeatAt: "nope", // → null
    backoffUntil: 1234,
  });
  assert.ok(clean);
  assert.equal(clean.healthy, false, "healthy is derived from state, not trusted");
  assert.equal(clean.restarts, 0);
  assert.equal(clean.recentExits, 0);
  assert.equal(clean.lastExitCode, 137);
  assert.equal(clean.lastHeartbeatAt, null);
  assert.equal(clean.backoffUntil, 1234);
});

test("sanitizeAdapterHealth strips control chars/newlines from detail and caps its length (content-free)", () => {
  const clean = sanitizeAdapterHealth({
    adapter: "gmail",
    state: "unhealthy",
    detail: "line1\nline2\u001b[31mANSI" + "x".repeat(500),
  });
  assert.ok(clean);
  assert.ok(!clean.detail.includes("\n"), "newlines stripped");
  assert.ok(!clean.detail.includes("\u001b"), "ANSI escape stripped");
  assert.ok(clean.detail.length <= MAX_DETAIL_LEN + 1, "detail is length-capped");
});

test("sanitizeAdapterHealth strips unsafe characters from the adapter id", () => {
  const clean = sanitizeAdapterHealth({ adapter: "gmail\n<script>:evil ok", state: "healthy" });
  assert.ok(clean);
  assert.equal(clean.adapter, "gmailscript:evilok", "only [A-Za-z0-9._:@-] survive");
});

test("readHostHealth on a corrupt / non-JSON / wrong-shape file returns null (never throws)", () => {
  for (const bad of ["{ not json", "[]", '{"adapters": "nope"}', '{"foo":1}']) {
    const dir = ws();
    try {
      writeRawHostHealth(dir, bad);
      const res = readHostHealth(dir);
      // "[]" and missing adapters → null; a valid object with a non-array adapters → null.
      assert.ok(res === null, `corrupt file (${bad}) → null`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("readHostHealth keeps valid records, drops invalid ones, and reports the dropped count", () => {
  const dir = ws();
  try {
    writeRawHostHealth(dir, {
      state_version: 1,
      generated_at: "2026-07-14T12:00:00.000Z",
      adapters: [
        { adapter: "gmail", state: "healthy", healthy: true },
        { adapter: "telegram", state: "backoff", healthy: true }, // healthy LIE → re-derived false
        { adapter: "", state: "healthy" }, // dropped (no id)
        { adapter: "adapter-b", state: "bogus" }, // dropped (unknown state)
        "garbage", // dropped (not an object)
      ],
    });
    const res = readHostHealth(dir);
    assert.ok(res);
    assert.equal(res.dropped, 3, "three unusable records dropped");
    assert.deepEqual(
      res.adapters.map((a) => a.adapter),
      ["gmail", "telegram"]
    );
    assert.equal(res.adapters.find((a) => a.adapter === "telegram").healthy, false);
    // The degraded (backoff) record still surfaces as an AttentionItem via the normal path.
    assert.equal(coordinatorHealthSummary(res.adapters).ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt host-health file cannot inject content into `aios inbox --json`", () => {
  const dir = ws();
  try {
    writeRawHostHealth(dir, {
      adapters: [
        { adapter: "gmail", state: "backoff", detail: "evil\nInjected: secret-body\u001b[0m" },
        { adapter: "x".repeat(200), state: "not-a-state" }, // dropped
      ],
    });
    const res = runInbox(dir, ["--json"]);
    assert.equal(res.code, 0, res.stderr);
    const view = JSON.parse(res.stdout);
    const row = view.items.find((i) => i.origin === "agent-event" && i.health?.adapter === "gmail");
    assert.ok(row, "the valid degraded record still surfaces");
    assert.ok(!row.health.detail.includes("\n"), "no injected newline reaches the render surface");
    assert.ok(!row.health.detail.includes("\u001b"), "no ANSI escape reaches the render surface");
    assert.ok(
      !JSON.stringify(view).includes("not-a-state"),
      "the invalid record was dropped entirely"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coordinatorHealthSummary rolls up ok/degraded correctly", () => {
  const health = foldSupervisor(
    [
      { adapter: "a", kind: "ready", at: at(0) },
      { adapter: "b", kind: "ready", at: at(0) },
      { adapter: "b", kind: "kill", at: at(10) },
    ],
    DEFAULT_SUPERVISOR_POLICY,
    at(11)
  );
  const s = coordinatorHealthSummary(health.values());
  assert.equal(s.ok, false);
  assert.equal(s.counts.total, 2);
  assert.equal(s.counts.healthy, 1);
  assert.equal(s.counts.degraded, 1);
  assert.deepEqual(
    s.degraded.map((h) => h.adapter),
    ["b"]
  );
});
