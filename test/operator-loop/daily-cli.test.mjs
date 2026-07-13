// `aios loop daily` CLI tests. Drives the real CLI as a child process against a temp workspace.
// Proves: --manifest --json is deterministic and parseable; --manifest writes NOTHING (the
// key C4-vs-weekly property); --as external hides admin content + excluded refs; the human view
// renders three sections + owner marker + empty-state; --as bogus gates non-zero; a real owner
// run in TEXT mode records ONLY the local snapshot, leaving the continuity store untouched; and
// (AIO-365) `--json` does NOT record by default — only text mode and `--record --json` do — so a
// repeated `--json` poller never self-consumes its own "changed" signal.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(ROOT, "scripts", "aios.mjs");
const ADMIN_SENTINEL = "ZZACQUISITION40M";
const GEN = "2026-06-30T12:00:00.000Z";

const sig = (kind, tier, ref, summary, payload = {}) => ({
  kind,
  source: kind,
  tier,
  occurredAt: GEN,
  ref,
  summary,
  payload,
});

const MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: GEN,
  window: { cadence: "daily", from: "2026-06-29T12:00:00.000Z", to: GEN },
  windowed: false,
  signals: [
    sig(
      "decision",
      "external",
      { path: "4-shared/pub.md", row: "1", tier: "external" },
      "Public decision"
    ),
    sig(
      "task",
      "admin",
      { path: "3-log/tasks.md", row: "T-1", tier: "admin" },
      `Admin task ${ADMIN_SENTINEL}`,
      {
        status: "blocked",
      }
    ),
    sig(
      "carryover",
      "team",
      { path: ".aios/loop/continuity/actions.json", row: "c1", tier: "team" },
      "Carry over: Follow up",
      { title: "Follow up", status: "open", due: "2026-06-30", createdAt: "2026-06-29T00:00:00Z" }
    ),
  ],
  excluded: [{ ref: "3-log/hours.md", reason: "no tier" }],
};

function workspace(manifest = MANIFEST) {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-cli-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  const m = path.join(dir, "manifest.json");
  writeFileSync(m, JSON.stringify(manifest));
  return { dir, m };
}

function run(cwd, args, env = {}) {
  try {
    const stdout = execFileSync("node", [CLI, "loop", "daily", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

const CONNECTOR_PATHS = {
  granola: ["granola-direct", "granola-pull.mjs"],
  gog: ["gog-activity", "gog-activity-pull.mjs"],
  slack: ["slack-personal", "slack-activity-pull.mjs"],
};

function seedConnectorStubs(dir, bodies = {}) {
  for (const [name, parts] of Object.entries(CONNECTOR_PATHS)) {
    const file = path.join(dir, ".claude", "descriptors", "skills", ...parts);
    mkdirSync(path.dirname(file), { recursive: true });
    const body =
      bodies[name] ??
      `
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const root = args[args.indexOf("--repo") + 1];
const activity = path.join(root, "1-inbox", "comms", "activity.jsonl");
mkdirSync(path.dirname(activity), { recursive: true });
appendFileSync(path.join(root, "connector-invocations.log"), ${JSON.stringify(name + "\n")});
appendFileSync(activity, JSON.stringify({
  source: "slack",
  tier: "admin",
  occurredAt: new Date().toISOString(),
  ref: ${JSON.stringify("stub:" + name)},
  channel: null,
  direction: "inbound",
  summary: ${JSON.stringify("Slack needing reply from " + name)},
  waitingOn: "me"
}) + "\\n");
`;
    writeFileSync(file, body);
  }
}

function liveConnectorWorkspace(bodies) {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-connectors-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  seedConnectorStubs(dir, bodies);
  return dir;
}

function invocationCount(dir) {
  const file = path.join(dir, "connector-invocations.log");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).length
    : 0;
}

test("daily --manifest --json emits a parseable, deterministic DailyOrientation", () => {
  const { dir, m } = workspace();
  const r1 = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r1.code, 0, r1.stderr);
  const o = JSON.parse(r1.stdout);
  assert.ok(Array.isArray(o.changed) && Array.isArray(o.blocked) && Array.isArray(o.owedToday));
  const r2 = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r2.stdout, r1.stdout);
});

test("daily --manifest writes nothing — no snapshot, no artifacts (read-only)", () => {
  const { dir, m } = workspace();
  const before = readdirSync(dir).sort();
  const r = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.ok(!existsSync(path.join(dir, ".aios")));
});

test("daily --manifest rejects windowed daily collect manifests", () => {
  const { dir, m } = workspace({ ...MANIFEST, windowed: true });
  const r = run(dir, ["--manifest", m, "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires an unwindowed full-state manifest/);
});

test("daily --manifest without a path fails before any live collect or snapshot write", () => {
  const { dir } = workspace();
  const before = readdirSync(dir).sort();
  const r = run(dir, ["--manifest", "--json"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--manifest requires a path/);
  assert.deepEqual(readdirSync(dir).sort(), before);
  assert.ok(!existsSync(path.join(dir, ".aios")));
});

test("daily --as external hides admin content and withholds excluded refs", () => {
  const { dir, m } = workspace();
  const r = run(dir, ["--manifest", m, "--as", "external", "--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes(ADMIN_SENTINEL), "admin sentinel must not appear in a shared view");
  const o = JSON.parse(r.stdout);
  assert.equal(o.audience, "external");
  assert.equal(o.excluded.length, 0);
  assert.equal(o.counts.excluded, 1);
  assert.ok(
    ![...o.changed, ...o.blocked, ...o.owedToday, ...o.calendar, ...o.commsNeedingReply].some(
      (i) => i.tier === "admin"
    )
  );
});

test("daily human view is actions-first and empty manifest has a friendly empty-state", () => {
  const { dir, m } = workspace();
  const r = run(dir, ["--manifest", m]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /owner-private/);
  assert.match(r.stdout, /Changed \(/);
  assert.match(r.stdout, /Blocked \(/);
  assert.match(r.stdout, /Owed today \(/);
  assert.match(r.stdout, /Today's calendar \(/);
  assert.match(r.stdout, /Comms needing reply \(/);
  assert.ok(r.stdout.indexOf("Blocked (") < r.stdout.indexOf("Owed today ("));
  assert.ok(r.stdout.indexOf("Owed today (") < r.stdout.indexOf("Today's calendar ("));
  assert.ok(r.stdout.indexOf("Today's calendar (") < r.stdout.indexOf("Comms needing reply ("));
  assert.ok(r.stdout.indexOf("Comms needing reply (") < r.stdout.indexOf("Changed ("));

  const { dir: d2, m: em } = workspace({ ...MANIFEST, signals: [], excluded: [] });
  const r2 = run(d2, ["--manifest", em]);
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /You're clear/);

  const { dir: d3, m: excludedOnly } = workspace({
    ...MANIFEST,
    signals: [],
    excluded: [{ ref: "3-log/tasks.md#x", reason: "no tier" }],
  });
  const r3 = run(d3, ["--manifest", excludedOnly]);
  assert.equal(r3.code, 0, r3.stderr);
  assert.match(r3.stdout, /No classifiable daily items/);
  assert.match(r3.stdout, /excluded \(default-deny\)/);
  assert.doesNotMatch(r3.stdout, /You're clear/);
});

test("truncated Changed section names the exact expansion command", () => {
  const signals = Array.from({ length: 10 }, (_, i) =>
    sig(
      "decision",
      "team",
      { path: "3-log/decision-log.md", row: String(i + 1), tier: "team" },
      `Decision ${i + 1}`
    )
  );
  const { dir, m } = workspace({ ...MANIFEST, signals, excluded: [] });
  const r = run(dir, ["--manifest", m]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /\+3 more — run `aios loop manifest --explain --daily` to inspect/);
});

test("empty shareable views distinguish withheld activity from a true zero without details", () => {
  const privateSummary = "ZZ-PRIVATE-DAILY-SUMMARY";
  const privatePath = "5-personal/zz-private-daily.md";
  const admin = sig(
    "decision",
    "admin",
    { path: privatePath, row: "1", tier: "admin" },
    privateSummary
  );
  const { dir, m } = workspace({
    ...MANIFEST,
    signals: [admin],
    excluded: [{ ref: "5-personal/hidden-source.md#2", reason: "no tier" }],
  });
  const hidden = run(dir, ["--manifest", m, "--as", "team"]);
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.match(hidden.stdout, /0 team-visible items \(1 withheld; 1 excluded \(default-deny\)\)/);
  assert.match(hidden.stdout, /`aios loop manifest --explain --daily --as team` to audit/);
  assert.doesNotMatch(hidden.stdout, new RegExp(privateSummary));
  assert.doesNotMatch(hidden.stdout, new RegExp(privatePath.replaceAll(".", "\\.")));
  assert.equal((hidden.stdout.match(/excluded \(default-deny\)/g) ?? []).length, 1);

  const { dir: zeroDir, m: zeroManifest } = workspace({
    ...MANIFEST,
    signals: [],
    excluded: [],
  });
  const zero = run(zeroDir, ["--manifest", zeroManifest, "--as", "team"]);
  assert.equal(zero.code, 0, zero.stderr);
  assert.match(zero.stdout, /0 team-visible items\. Nothing happened in this view/);
  assert.doesNotMatch(zero.stdout, /withheld|default-deny|to audit/);
});

test("daily --as bogus exits non-zero with a clear message", () => {
  const { dir, m } = workspace();
  const r = run(dir, ["--manifest", m, "--as", "bogus"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /must be team\|external/);
});

test("live owner daily surfaces seeded asks; --as team gates them out (constitution)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-asks-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  mkdirSync(path.join(dir, ".aios", "loop", "asks"), { recursive: true });
  const now = new Date().toISOString();
  const createLine = (ask) => JSON.stringify({ v: 1, op: "create", ask });
  const asks = [
    {
      id: "blk-1",
      severity: "blocker",
      title: "Prod is down",
      kind: "blocker",
      source: "cli",
      tier: "admin",
      createdAt: now,
    },
    {
      id: "dec-1",
      severity: "decision",
      title: "Pick a database",
      kind: "decision",
      source: "cli",
      tier: "admin",
      createdAt: now,
    },
    {
      id: "fyi-1",
      severity: "fyi",
      title: "Deploy finished",
      kind: "fyi",
      source: "cli",
      tier: "admin",
      createdAt: now,
    },
  ];
  writeFileSync(
    path.join(dir, ".aios", "loop", "asks", "asks.ndjson"),
    asks.map(createLine).join("\n") + "\n"
  );

  // Owner JSON: one blocker in Attention, decision+fyi in Queued asks.
  const rj = run(dir, ["--json"]);
  assert.equal(rj.code, 0, rj.stderr);
  const o = JSON.parse(rj.stdout);
  assert.equal(o.counts.attention, 1);
  assert.equal(o.counts.queuedAsks, 2);
  assert.equal(o.attention[0].ref.row, "blk-1");
  assert.deepEqual(
    o.queuedAsks.map((i) => i.ref.row),
    ["dec-1", "fyi-1"]
  );

  // Owner human view renders BOTH sections with counts.
  const rh = run(dir, []);
  assert.equal(rh.code, 0, rh.stderr);
  assert.match(rh.stdout, /Attention \(1\)/);
  assert.match(rh.stdout, /Queued asks \(2\)/);
  assert.match(rh.stdout, /Prod is down/);
  assert.match(rh.stdout, /Manage this queue with `aios asks`/);

  // --as team: asks never enter the output.
  const rt = run(dir, ["--as", "team", "--json"]);
  assert.equal(rt.code, 0, rt.stderr);
  const ot = JSON.parse(rt.stdout);
  assert.equal(ot.counts.attention, 0);
  assert.equal(ot.counts.queuedAsks, 0);
  assert.deepEqual(ot.attention, []);
  assert.deepEqual(ot.queuedAsks, []);
  assert.ok(!rt.stdout.includes("Prod is down"));
});

// Shared fixture for the record-default tests below: seeds a real (non-carryover) "changed"-
// eligible signal — a decision-log row — since `changed` classification only applies to
// decision/task/deliverable kinds, not carryover (which is owed/blocked). Dated "today" so the
// first run's 24h bootstrap window picks it up as Changed.
function liveDecisionWorkspace() {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-live-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  mkdirSync(path.join(dir, "3-log"), { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    path.join(dir, "3-log", "decision-log.md"),
    "---\naccess: team\n---\n\n| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |\n|---|---|---|---|---|---|---|---|\n" +
      `| 1 | ${today} | Ship the daily fix | keep signal alive | alex | i | 1 | team |\n`
  );
  return dir;
}

test("AIO-365 regression: repeated `--json` (no --record) calls do NOT self-consume the changed signal", () => {
  const dir = liveDecisionWorkspace();

  const r1 = run(dir, ["--json"]);
  assert.equal(r1.code, 0, r1.stderr);
  const o1 = JSON.parse(r1.stdout);
  assert.ok(o1.counts.changed >= 1, "first call sees the seeded decision as changed");
  assert.ok(
    !existsSync(path.join(dir, ".aios", "loop", "state", "changes-daily.json")),
    "a bare --json call must NOT record a snapshot (new default)"
  );

  const r2 = run(dir, ["--json"]);
  assert.equal(r2.code, 0, r2.stderr);
  const o2 = JSON.parse(r2.stdout);
  // Before the fix, `--json` recorded by default same as text mode: the first call above would
  // have advanced the baseline, so this second call would see the decision as unchanged
  // (counts.changed === 0) — exactly the AIO-365 symptom (a poller hitting `--json` on every tick
  // silently sees zero "changed" from the second call onward). With the fix, the baseline never
  // advanced, so the second call still sees the same real signal.
  assert.equal(
    o2.counts.changed,
    o1.counts.changed,
    "second --json call must still see the real changed signal, not a silently emptied one"
  );
  assert.ok(o2.changed.some((i) => i.ref.path === "3-log/decision-log.md"));
  assert.ok(
    !existsSync(path.join(dir, ".aios", "loop", "state", "changes-daily.json")),
    "still no snapshot after a second bare --json call"
  );
});

test("daily --record --json DOES advance the snapshot (opt-in recording alongside --json)", () => {
  const dir = liveDecisionWorkspace();

  const r1 = run(dir, ["--record", "--json"]);
  assert.equal(r1.code, 0, r1.stderr);
  const o1 = JSON.parse(r1.stdout);
  assert.ok(o1.counts.changed >= 1, "first call sees the seeded decision as changed");
  assert.ok(
    existsSync(path.join(dir, ".aios", "loop", "state", "changes-daily.json")),
    "--record --json must write the snapshot"
  );

  // Baseline now reflects the decision as seen, so a follow-up call (even a bare --json, which
  // itself never records) correctly sees nothing NEW since the --record call above.
  const r2 = run(dir, ["--json"]);
  assert.equal(r2.code, 0, r2.stderr);
  const o2 = JSON.parse(r2.stdout);
  assert.equal(
    o2.counts.changed,
    0,
    "second call sees nothing new since the --record call already advanced the baseline"
  );
});

test("plain text mode (no --json) still records by default — unchanged behavior", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "c4-rec-"));
  writeFileSync(path.join(dir, "aios.yaml"), "member: alex\n");
  mkdirSync(path.join(dir, ".aios", "loop", "continuity"), { recursive: true });
  const actionsPath = path.join(dir, ".aios", "loop", "continuity", "actions.json");
  const actions = JSON.stringify(
    {
      version: 1,
      actions: [
        {
          id: "c1",
          title: "Follow up",
          status: "open",
          tier: "team",
          createdAt: "2026-06-29T00:00:00Z",
        },
      ],
    },
    null,
    2
  );
  writeFileSync(actionsPath, actions);

  const topBefore = readdirSync(dir).sort();
  const r = run(dir, []); // owner, text mode, no flags → records by default (unchanged)
  assert.equal(r.code, 0, r.stderr);
  // Carryover is visible somewhere (owed if fresh, blocked if the wall clock makes it stale).
  assert.match(r.stdout, /Follow up/);

  assert.deepEqual(readdirSync(dir).sort(), topBefore); // no new top-level entries
  assert.ok(existsSync(path.join(dir, ".aios", "loop", "state", "changes-daily.json")));
  assert.equal(readFileSync(actionsPath, "utf8"), actions); // continuity untouched
});

test("AIO-366: recording owner daily completes all connector pulls before C1 collect", () => {
  const dir = liveConnectorWorkspace();
  const result = run(dir, ["--record", "--json"]);
  assert.equal(result.code, 0, result.stderr);
  const orientation = JSON.parse(result.stdout);
  assert.equal(invocationCount(dir), 3, "Granola, GOG, and Slack adapters all ran");
  const refs = orientation.commsNeedingReply
    .filter((item) => item.kind === "comms")
    .map((item) => item.ref.row)
    .sort();
  assert.deepEqual(
    refs,
    ["stub:gog", "stub:granola", "stub:slack"],
    "activity written by every connector was present when runDaily collected"
  );
});

test("AIO-366: connector non-zero exit + timeout fail open and daily JSON still renders", () => {
  const markerScript = (name) => `
import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const root = args[args.indexOf("--repo") + 1];
appendFileSync(path.join(root, "connector-invocations.log"), ${JSON.stringify(name + "\n")});
`;
  const dir = liveConnectorWorkspace({
    granola: `${markerScript("granola")}process.exit(9);\n`,
    gog: `${markerScript("gog")}setInterval(() => {}, 1000);\n`,
    slack: markerScript("slack"),
  });
  const result = run(dir, ["--record", "--json"], { AIOS_LOOP_CONNECTOR_TIMEOUT_MS: "300" });
  assert.equal(result.code, 0, result.stderr);
  const orientation = JSON.parse(result.stdout);
  assert.ok(Array.isArray(orientation.changed));
  assert.ok(Array.isArray(orientation.blocked));
  assert.ok(Array.isArray(orientation.owedToday));
  assert.equal(
    invocationCount(dir),
    3,
    "a failed/slow adapter never prevents the others from running"
  );
});

test("AIO-366: inspection/projection/opt-out paths never invoke connectors", () => {
  const dir = liveConnectorWorkspace({ granola: "", gog: "", slack: "" });
  const manifestPath = path.join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ ...MANIFEST, signals: [], excluded: [] }));
  const noPullCases = [
    ["--manifest", manifestPath, "--json"],
    ["--as", "team"],
    ["--no-record"],
    ["--json"],
    ["--no-connectors"],
  ];
  for (const args of noPullCases) {
    const before = invocationCount(dir);
    const result = run(dir, args);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(invocationCount(dir), before, `${args.join(" ")} must stay pull-free`);
  }

  // Replace the empty adapters with marker-only scripts and prove the explicit recording JSON path
  // opts into the connector preamble while retaining clean parseable stdout.
  const marker = (name) => `
import { appendFileSync } from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const root = args[args.indexOf("--repo") + 1];
appendFileSync(path.join(root, "connector-invocations.log"), ${JSON.stringify(name + "\n")});
`;
  seedConnectorStubs(dir, {
    granola: marker("granola"),
    gog: marker("gog"),
    slack: marker("slack"),
  });
  const recording = run(dir, ["--record", "--json"]);
  assert.equal(recording.code, 0, recording.stderr);
  JSON.parse(recording.stdout);
  assert.equal(invocationCount(dir), 3);
});
