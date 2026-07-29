import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collect } from "../../../dist/operator-loop/index.js";
import {
  appendRecords,
  existingRefs,
  issueSummary,
  mapIssueToRecord,
  parseArgs,
  planAppend,
  toIso,
} from "../../../scripts/connectors/linear-comms-sync.mjs";

// Fixture Linear issues (the subset of fields the GraphQL query selects). No network.
const ISSUE_A = {
  id: "9d1f0a1e-0000-4000-8000-000000000001",
  identifier: "AIO-123",
  title: "Fix the thing",
  url: "https://linear.app/je4light/issue/AIO-123",
  createdAt: "2026-07-01T09:00:00.000Z",
  updatedAt: "2026-07-01T12:00:00.000Z",
  dueDate: "2026-07-10",
  priority: 2,
  state: { name: "In Progress" },
};

const ISSUE_B = {
  id: "9d1f0a1e-0000-4000-8000-000000000002",
  identifier: "AIO-124",
  title: "Ship the other thing",
  createdAt: "2026-07-01T09:00:00.000Z",
  updatedAt: "2026-07-02T08:30:00.000Z",
  dueDate: null,
  priority: 3,
  state: { name: "Todo" },
};

function outFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-sync-"));
  return path.join(realpathSync(dir), "comms", "activity.jsonl");
}

// ── mapping ──────────────────────────────────────────────────────────────────

test("mapIssueToRecord: emits the CommsActivityRecord contract the comms source reads", () => {
  const rec = mapIssueToRecord(ISSUE_A);
  assert.deepEqual(rec, {
    source: "linear",
    tier: "team",
    occurredAt: "2026-07-01T12:00:00.000Z",
    ref: "AIO-123",
    summary: "AIO-123: Fix the thing (In Progress)",
    dueAt: "2026-07-10T00:00:00.000Z",
  });
  // Channel-less by design: tier must therefore resolve from the record's own tier.
  assert.equal("channel" in rec, false);
  assert.equal("direction" in rec, false);
});

test("mapIssueToRecord: --tier is honoured and validated (default-deny on a bad tier)", () => {
  assert.equal(mapIssueToRecord(ISSUE_A, { tier: "admin" }).tier, "admin");
  assert.throws(() => mapIssueToRecord(ISSUE_A, { tier: "public" }), /admin\|team\|external/);
});

test("mapIssueToRecord: a due-date-less issue omits dueAt entirely", () => {
  const rec = mapIssueToRecord(ISSUE_B);
  assert.equal("dueAt" in rec, false);
  assert.equal(rec.summary, "AIO-124: Ship the other thing (Todo)");
  assert.equal(rec.occurredAt, "2026-07-02T08:30:00.000Z");
});

test("mapIssueToRecord: falls back to the UUID ref, and fails loudly with no ref/timestamp", () => {
  const noIdent = { ...ISSUE_A, identifier: undefined };
  assert.equal(mapIssueToRecord(noIdent).ref, ISSUE_A.id);
  assert.throws(
    () => mapIssueToRecord({ ...ISSUE_A, identifier: undefined, id: undefined }),
    /no stable ref/
  );
  assert.throws(
    () => mapIssueToRecord({ ...ISSUE_A, updatedAt: "not-a-date", createdAt: null }),
    /no parsable updatedAt/
  );
});

test("issueSummary / toIso: degrade safely on missing fields", () => {
  assert.equal(issueSummary({ identifier: "AIO-9", title: "  " }), "AIO-9: (untitled)");
  assert.equal(issueSummary({ identifier: "AIO-9", title: "T" }), "AIO-9: T");
  assert.equal(toIso(""), null);
  assert.equal(toIso(null), null);
  assert.equal(toIso("2026-07-10"), "2026-07-10T00:00:00.000Z");
});

// ── idempotent append ────────────────────────────────────────────────────────

test("existingRefs: collects refs and ignores blank / unparsable lines", () => {
  const refs = existingRefs('{"ref":"AIO-1"}\n\nnot json\n{"ref":"AIO-2"}\n{"noref":true}\n');
  assert.deepEqual([...refs].sort(), ["AIO-1", "AIO-2"]);
});

test("planAppend: dedupes against known refs AND within the incoming batch", () => {
  const batch = [{ ref: "AIO-1" }, { ref: "AIO-2" }, { ref: "AIO-1" }, { ref: "" }];
  const { toWrite, skipped } = planAppend(batch, new Set(["AIO-2"]));
  assert.deepEqual(
    toWrite.map((r) => r.ref),
    ["AIO-1"]
  );
  assert.equal(skipped, 3);
});

test("appendRecords: creates the file, then a second identical run appends nothing", () => {
  const out = outFile();
  const records = [ISSUE_A, ISSUE_B].map((i) => mapIssueToRecord(i));

  const first = appendRecords(out, records);
  assert.deepEqual(first, { written: 2, skipped: 0 });

  const second = appendRecords(out, records);
  assert.deepEqual(second, { written: 0, skipped: 2 });

  const lines = readFileSync(out, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).ref),
    ["AIO-123", "AIO-124"]
  );
});

test("appendRecords: only the genuinely-new record lands on an incremental run", () => {
  const out = outFile();
  appendRecords(out, [mapIssueToRecord(ISSUE_A)]);
  const res = appendRecords(
    out,
    [ISSUE_A, ISSUE_B].map((i) => mapIssueToRecord(i))
  );
  assert.deepEqual(res, { written: 1, skipped: 1 });
  assert.equal(readFileSync(out, "utf8").trim().split("\n").length, 2);
});

test("appendRecords: heals a file missing its trailing newline instead of gluing lines", () => {
  const out = outFile();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ source: "linear", ref: "AIO-1" })); // no trailing \n
  appendRecords(out, [mapIssueToRecord(ISSUE_A)]);
  const lines = readFileSync(out, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
});

// ── CLI flag parsing ─────────────────────────────────────────────────────────

test("parseArgs: defaults, overrides, and loud rejection of bad flags", () => {
  assert.deepEqual(parseArgs(["--out", "a.jsonl"]), {
    team: "AIO",
    tier: "team",
    priority: null,
    out: "a.jsonl",
  });
  assert.deepEqual(
    parseArgs(["--team", "OPS", "--tier", "admin", "--priority", "urgent", "--out", "a.jsonl"]),
    { team: "OPS", tier: "admin", priority: "urgent", out: "a.jsonl" }
  );
  assert.throws(() => parseArgs([]), /--out <path> is required/);
  assert.throws(() => parseArgs(["--out", "a.jsonl", "--tier", "nope"]), /admin\|team\|external/);
  assert.throws(() => parseArgs(["--out", "a.jsonl", "--priority", "spicy"]), /--priority must be/);
  assert.throws(() => parseArgs(["--bogus", "x", "--out", "a.jsonl"]), /unknown or incomplete/);
});

// ── end-to-end: written records resolve as source "linear" (KNOWN_SOURCES) ────

test("comms source: a linear record emits source 'linear', not the generic 'comms' bucket", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "aios-ws-linear-")));
  mkdirSync(path.join(root, "1-inbox", "comms"), { recursive: true });
  mkdirSync(path.join(root, "3-log"), { recursive: true });
  mkdirSync(path.join(root, ".aios"), { recursive: true });

  const activity = path.join(root, "1-inbox", "comms", "activity.jsonl");
  const res = appendRecords(activity, [mapIssueToRecord(ISSUE_A)]);
  assert.deepEqual(res, { written: 1, skipped: 0 });

  const m = collect({ root, cadence: "weekly", now: new Date("2026-07-02T00:00:00Z") });
  const comms = m.signals.filter((s) => s.kind === "comms");
  assert.equal(comms.length, 1);
  const s = comms[0];
  assert.equal(s.source, "linear");
  assert.equal(s.tier, "team");
  assert.equal(s.ref.row, "AIO-123");
  // Channel-less linear records get the `_` channel segment in the collision-proof path.
  assert.equal(s.ref.path, ".aios/loop/comms/linear/team/_.ndjson");
  assert.equal(s.payload.channel, null);
  assert.equal(s.payload.summary, "AIO-123: Fix the thing (In Progress)");
  assert.equal(s.payload.dueAt, "2026-07-10T00:00:00.000Z");
});
