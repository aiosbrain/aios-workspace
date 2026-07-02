// C4 classifier tests (daily.ts buildDailyOrientation). Pure over manifest literals + a prior
// change-snapshot (built via diffSignals). Run after `npm run build:loop`.

import test from "node:test";
import assert from "node:assert/strict";
import { buildDailyOrientation, diffSignals } from "../../dist/operator-loop/index.js";

const GEN = "2026-06-30T12:00:00.000Z";
const TODAY = "2026-06-30";

function mani(signals, opts = {}) {
  return {
    member: opts.member ?? "alex",
    project: "acme",
    generatedAt: opts.generatedAt ?? GEN,
    window: { cadence: "daily", from: opts.from ?? "2026-06-29T12:00:00.000Z", to: opts.to ?? GEN },
    signals,
    excluded: opts.excluded ?? [],
  };
}

const sig = (kind, tier, ref, summary, payload = {}, occurredAt = GEN) => ({
  kind,
  source: kind,
  tier,
  occurredAt,
  ref,
  summary,
  payload,
});

// A prior baseline in which every given signal is already recorded (so it reads "unchanged").
const baselineOf = (signals) =>
  diffSignals({ prior: null, signals, now: new Date(GEN), scope: "daily" }).next;

test("decision in the window is Changed on first run; an out-of-window decision is omitted", () => {
  const dIn = sig(
    "decision",
    "team",
    { path: "3-log/decision-log.md", row: "7", tier: "team" },
    "Adopt PG16"
  );
  const dOld = sig(
    "decision",
    "team",
    { path: "3-log/decision-log.md", row: "1", tier: "team" },
    "Old",
    {},
    "2026-01-01T00:00:00.000Z"
  );
  const { orientation } = buildDailyOrientation({ manifest: mani([dIn, dOld]), prior: null });
  assert.deepEqual(
    orientation.changed.map((i) => i.ref.row),
    ["7"]
  );
});

test("an empty on-scope snapshot still uses the first-run bootstrap window", () => {
  const dIn = sig(
    "decision",
    "team",
    { path: "3-log/decision-log.md", row: "7", tier: "team" },
    "Today"
  );
  const dOld = sig(
    "decision",
    "team",
    { path: "3-log/decision-log.md", row: "1", tier: "team" },
    "Old",
    {},
    "2026-01-01T00:00:00.000Z"
  );
  const { orientation } = buildDailyOrientation({
    manifest: mani([dIn, dOld]),
    prior: { version: 1, scope: "daily", updatedAt: GEN, artifacts: {} },
  });
  assert.deepEqual(
    orientation.changed.map((i) => i.ref.row),
    ["7"]
  );
});

test("an unchanged decision is omitted once a baseline exists", () => {
  const d = sig(
    "decision",
    "team",
    { path: "3-log/decision-log.md", row: "7", tier: "team" },
    "Adopt PG16"
  );
  const { orientation } = buildDailyOrientation({ manifest: mani([d]), prior: baselineOf([d]) });
  assert.equal(orientation.changed.length, 0);
});

test("deliverable is Changed by default, Blocked when its status says so", () => {
  const ok = sig("deliverable", "team", { path: "2-work/a.md", tier: "team" }, "Guide", {
    status: null,
  });
  const blk = sig("deliverable", "team", { path: "2-work/b.md", tier: "team" }, "API", {
    status: "blocked",
  });
  const { orientation } = buildDailyOrientation({ manifest: mani([ok, blk]), prior: null });
  assert.deepEqual(
    orientation.changed.map((i) => i.ref.path),
    ["2-work/a.md"]
  );
  assert.deepEqual(
    orientation.blocked.map((i) => i.ref.path),
    ["2-work/b.md"]
  );
});

test("task owed / omitted / blocked classification, with precedence Blocked > Owed", () => {
  const t = (row, payload, summary = "T") =>
    sig("task", "team", { path: "3-log/tasks.md", row, tier: "team" }, summary, payload);
  const m = mani([
    t("due-past", { status: "open", due: "2026-06-01" }), // overdue → owed
    t("due-today", { status: "open", due: TODAY }), // due today → owed
    t("due-future", { status: "open", due: "2026-12-01" }), // future → omitted
    t("blocked-overdue", { status: "blocked", due: "2026-06-01" }), // blocked wins over owed
    t("unblocked", { status: "unblocked", due: "2026-12-01" }), // "unblocked" ≠ blocked → omitted
    t("done", { status: "done", due: "2026-06-01" }), // closed → omitted
    t("malformed", { status: "open", due: "next week" }), // unparseable due → not owed → omitted
    t("invalid-day", { status: "open", due: "2026-02-31" }), // impossible day → not owed
  ]);
  // Baseline so no task is "changed" — isolates owed/blocked/omit.
  const { orientation } = buildDailyOrientation({ manifest: m, prior: baselineOf(m.signals) });
  assert.deepEqual(
    orientation.owedToday.map((i) => i.ref.row).sort(),
    ["due-past", "due-today"].sort()
  );
  assert.deepEqual(
    orientation.blocked.map((i) => i.ref.row),
    ["blocked-overdue"]
  );
  assert.equal(orientation.changed.length, 0);
});

test("a modified open task that isn't owed or blocked surfaces in Changed", () => {
  const ref = { path: "3-log/tasks.md", row: "T-1", tier: "team" };
  const before = sig("task", "team", ref, "Roadmap", {
    status: "open",
    due: "2026-12-01",
    note: "v1",
  });
  const after = sig("task", "team", ref, "Roadmap", {
    status: "open",
    due: "2026-12-01",
    note: "v2",
  });
  const { orientation } = buildDailyOrientation({
    manifest: mani([after]),
    prior: baselineOf([before]),
  });
  assert.equal(orientation.changed.length, 1);
  assert.equal(orientation.changed[0].changeType, "modified");
});

test("carryover: fresh → owed; stale or waiting → blocked; missing createdAt → owed (not stale)", () => {
  const cref = (id) => ({ path: ".aios/loop/continuity/actions.json", row: id, tier: "team" });
  const co = (id, title, payload) =>
    sig("carryover", "team", cref(id), `Carry over: ${title}`, {
      title,
      status: "open",
      ...payload,
    });
  const m = mani([
    co("c1", "Follow up", { due: TODAY, createdAt: "2026-06-29T00:00:00Z" }), // fresh → owed
    co("c2", "Metrics", { createdAt: "2026-06-01T00:00:00Z" }), // 29 days → stale → blocked
    co("c3", "waiting on vendor", { createdAt: "2026-06-29T00:00:00Z" }), // waiting → blocked
    co("c4", "No date", { createdAt: null }), // no createdAt → not stale → owed
  ]);
  const { orientation } = buildDailyOrientation({ manifest: m, prior: null, staleDays: 7 });
  assert.deepEqual(orientation.blocked.map((i) => i.ref.row).sort(), ["c2", "c3"]);
  assert.deepEqual(orientation.owedToday.map((i) => i.ref.row).sort(), ["c1", "c4"]);
  assert.ok(orientation.blocked.find((i) => i.ref.row === "c2").stale >= 28);
});

test("carryover staleness uses calendar days, not elapsed milliseconds", () => {
  const ref = { path: ".aios/loop/continuity/actions.json", row: "c1", tier: "team" };
  const co = sig("carryover", "team", ref, "Carry over: Follow up", {
    title: "Follow up",
    status: "open",
    createdAt: "2026-06-22T23:30:00Z",
  });
  const { orientation } = buildDailyOrientation({
    manifest: mani([co], { generatedAt: "2026-06-30T00:30:00Z" }),
    prior: null,
    staleDays: 7,
  });
  assert.equal(orientation.blocked[0].ref.row, "c1");
  assert.equal(orientation.blocked[0].stale, 8);
});

test("audience filter drops higher tiers; excluded full only for owner", () => {
  const admin = sig(
    "decision",
    "admin",
    { path: "5-personal/secret.md", row: "9", tier: "admin" },
    "Secret"
  );
  const team = sig(
    "decision",
    "team",
    { path: "3-log/decision-log.md", row: "2", tier: "team" },
    "Team"
  );
  const ext = sig(
    "deliverable",
    "external",
    { path: "4-shared/pub.md", tier: "external" },
    "Public"
  );
  const m = mani([admin, team, ext], {
    excluded: [{ ref: "3-log/tasks.md#x", reason: "no tier" }],
  });

  const owner = buildDailyOrientation({ manifest: m, prior: null, audience: "owner" }).orientation;
  assert.equal(owner.excluded.length, 1);
  assert.equal(owner.counts.excluded, 1);
  assert.ok(new Set(owner.changed.map((i) => i.tier)).has("admin"));

  const view = buildDailyOrientation({ manifest: m, prior: null, audience: "team" }).orientation;
  assert.ok(!view.changed.some((i) => i.tier === "admin"));
  assert.equal(view.excluded.length, 0); // withheld from a shareable view
  assert.equal(view.counts.excluded, 1); // count still visible
});

test("nextSnapshot is owner-complete regardless of the requested audience", () => {
  const admin = sig(
    "decision",
    "admin",
    { path: "5-personal/s.md", row: "9", tier: "admin" },
    "Secret"
  );
  const team = sig("decision", "team", { path: "3-log/d.md", row: "2", tier: "team" }, "T");
  const { nextSnapshot } = buildDailyOrientation({
    manifest: mani([admin, team]),
    prior: null,
    audience: "team",
  });
  assert.ok(nextSnapshot.artifacts["5-personal/s.md#9"]); // admin still baselined
  assert.ok(nextSnapshot.artifacts["3-log/d.md#2"]);
});

test("deterministic ordering with tied timestamps; unknown kind ignored; empty manifest", () => {
  const cref = (id) => ({ path: ".aios/loop/continuity/actions.json", row: id, tier: "team" });
  const co = (id) =>
    sig("carryover", "team", cref(id), `Carry over: ${id}`, {
      title: id,
      status: "open",
      due: TODAY,
      createdAt: "2026-06-29T00:00:00Z",
    });
  const m = mani([
    co("c3"),
    co("c1"),
    co("c2"),
    sig("hours", "team", { path: "x.md", row: "1", tier: "team" }, "ignored"),
  ]);
  const a = buildDailyOrientation({ manifest: m, prior: null }).orientation;
  const b = buildDailyOrientation({ manifest: m, prior: null }).orientation;
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.owedToday.map((i) => i.ref.row),
    ["c1", "c2", "c3"]
  ); // ref-sorted (due tie)
  assert.ok(![...a.changed, ...a.blocked, ...a.owedToday].some((i) => i.kind === "hours"));

  const empty = buildDailyOrientation({ manifest: mani([]), prior: null }).orientation;
  assert.deepEqual(empty.counts, {
    attention: 0,
    queuedAsks: 0,
    changed: 0,
    blocked: 0,
    owedToday: 0,
    excluded: 0,
  });
});

test("section cap: totals are true even when the display list is capped", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    sig(
      "carryover",
      "team",
      { path: ".aios/loop/continuity/actions.json", row: `c${i}`, tier: "team" },
      `Carry over: ${i}`,
      {
        title: String(i),
        status: "open",
        due: TODAY,
        createdAt: "2026-06-29T00:00:00Z",
      }
    )
  );
  const { orientation } = buildDailyOrientation({ manifest: mani(many), prior: null });
  assert.equal(orientation.counts.owedToday, 10);
  assert.equal(orientation.owedToday.length, 7); // SECTION_CAP
});

// ── Asks: Attention + Queued asks sections (AIO-169) ──────────────────────────────────────────
// buildDailyOrientation stays pure — asks are passed in via opts.asks. Owner-only (admin-tier).

// A minimal folded Ask (only the fields the classifier reads: id/severity/title/tier/createdAt/status).
const ask = (id, severity, title, createdAt, status = "open", tier = "admin") => ({
  id,
  dedupeKey: null,
  kind: severity,
  severity,
  title,
  body: "",
  ref: null,
  source: "cli",
  sessionId: null,
  tailHash: null,
  transcriptPath: null,
  tier,
  createdAt,
  status,
  resolvedAt: status === "open" ? null : createdAt,
});

test("open blocker ask → Attention section; item shape maps to the asks store row", () => {
  const a = ask("blk-1", "blocker", "Prod is down", "2026-06-30T09:00:00.000Z");
  const { orientation } = buildDailyOrientation({ manifest: mani([]), prior: null, asks: [a] });
  assert.equal(orientation.counts.attention, 1);
  assert.equal(orientation.attention.length, 1);
  const it = orientation.attention[0];
  assert.equal(it.kind, "ask");
  assert.match(it.summary, /Prod is down \[blocker\]/);
  assert.equal(it.tier, "admin");
  assert.equal(it.ref.path, ".aios/loop/asks/asks.ndjson");
  assert.equal(it.ref.row, "blk-1");
  assert.equal(orientation.counts.queuedAsks, 0);
});

test("Attention blockers are oldest-first", () => {
  const older = ask("blk-old", "blocker", "Older", "2026-06-28T00:00:00.000Z");
  const newer = ask("blk-new", "blocker", "Newer", "2026-06-30T00:00:00.000Z");
  const { orientation } = buildDailyOrientation({
    manifest: mani([]),
    prior: null,
    asks: [newer, older],
  });
  assert.deepEqual(
    orientation.attention.map((i) => i.ref.row),
    ["blk-old", "blk-new"]
  );
});

test("decision + fyi → Queued asks; decisions before fyi, newest-first within severity", () => {
  const decOld = ask("dec-old", "decision", "Pick DB", "2026-06-28T00:00:00.000Z");
  const decNew = ask("dec-new", "decision", "Pick cloud", "2026-06-30T00:00:00.000Z");
  const fyi = ask("fyi-1", "fyi", "Deploy done", "2026-06-29T00:00:00.000Z");
  const { orientation } = buildDailyOrientation({
    manifest: mani([]),
    prior: null,
    asks: [fyi, decOld, decNew],
  });
  assert.equal(orientation.counts.queuedAsks, 3);
  assert.deepEqual(
    orientation.queuedAsks.map((i) => i.ref.row),
    ["dec-new", "dec-old", "fyi-1"] // decisions (newest→oldest) before fyi
  );
  assert.equal(orientation.counts.attention, 0);
});

test("resolved / orphaned asks are excluded from both sections", () => {
  const resolved = ask("blk-r", "blocker", "Fixed", "2026-06-30T00:00:00.000Z", "resolved");
  const orphaned = ask("dec-o", "decision", "Gone", "2026-06-30T00:00:00.000Z", "orphaned");
  const open = ask("blk-o", "blocker", "Open", "2026-06-30T00:00:00.000Z", "open");
  const { orientation } = buildDailyOrientation({
    manifest: mani([]),
    prior: null,
    asks: [resolved, orphaned, open],
  });
  assert.equal(orientation.counts.attention, 1);
  assert.equal(orientation.counts.queuedAsks, 0);
  assert.equal(orientation.attention[0].ref.row, "blk-o");
});

test("asks sections respect SECTION_CAP with true counts", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    ask(`blk-${i}`, "blocker", `B${i}`, `2026-06-${10 + i}T00:00:00.000Z`)
  );
  const { orientation } = buildDailyOrientation({ manifest: mani([]), prior: null, asks: many });
  assert.equal(orientation.counts.attention, 10);
  assert.equal(orientation.attention.length, 7); // SECTION_CAP
});

test("CONSTITUTION: audience 'team' → asks never enter the output (both sections empty)", () => {
  const asks = [
    ask("blk-1", "blocker", "Prod is down", "2026-06-30T00:00:00.000Z"),
    ask("dec-1", "decision", "Pick DB", "2026-06-30T00:00:00.000Z"),
  ];
  const { orientation } = buildDailyOrientation({
    manifest: mani([]),
    prior: null,
    audience: "team",
    asks,
  });
  assert.equal(orientation.counts.attention, 0);
  assert.equal(orientation.counts.queuedAsks, 0);
  assert.deepEqual(orientation.attention, []);
  assert.deepEqual(orientation.queuedAsks, []);
  // and no ask leaks into any other section either
  assert.ok(
    ![...orientation.changed, ...orientation.blocked, ...orientation.owedToday].some(
      (i) => i.kind === "ask"
    )
  );
});

test("no asks (undefined) → empty sections, no crash", () => {
  const { orientation } = buildDailyOrientation({ manifest: mani([]), prior: null });
  assert.deepEqual(orientation.attention, []);
  assert.deepEqual(orientation.queuedAsks, []);
  assert.equal(orientation.counts.attention, 0);
  assert.equal(orientation.counts.queuedAsks, 0);
});
