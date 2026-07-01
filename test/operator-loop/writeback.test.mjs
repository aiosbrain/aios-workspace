// C6 approval-gated writeback tests. The planner is pure + deterministic, so every tier-safety
// property is proven offline with fixtures — no fs, no network. Sentinels stand in for
// above-audience content; they must never reach a syncable file or task row.

import test from "node:test";
import assert from "node:assert/strict";
import {
  planWriteback,
  promotability,
  audienceForTier,
  resolveTierOrDefault,
  stampFrontmatter,
  deriveRowKey,
  actionToRow,
  sweepForLeaks,
  aboveAudienceStrings,
} from "../../dist/operator-loop/index.js";
import { mergeTaskWriteback } from "../../scripts/tasks-table.mjs";

// ── fixtures ────────────────────────────────────────────────────────────────
const ADMIN_SENTINEL = "ZZACQUISITION40M";
const TEAM_SENTINEL = "ZZINTERNALTEAMNOTE";

const sig = (path, row, tier, kind, summary) => ({
  kind,
  source: kind,
  tier,
  occurredAt: "2026-06-29T00:00:00.000Z",
  ref: { path, row, tier },
  summary,
});

const MANIFEST = {
  member: "alex",
  project: "acme",
  generatedAt: "2026-07-01T00:00:00.000Z",
  window: { cadence: "weekly", from: "2026-06-24", to: "2026-07-01" },
  signals: [
    sig("4-shared/public.md", "1", "external", "deliverable", "Shipped the public widget"),
    sig("2-work/notes.md", "2", "team", "task", `Team note ${TEAM_SENTINEL}`),
    sig("5-personal/secret.md", "7", "admin", "decision", `Acquisition price ${ADMIN_SENTINEL}`),
  ],
  excluded: [],
};

const ROOT = "/ws";
const repoRel = (p) => p.replace(`${ROOT}/`, "");
const SPINE = { work: `${ROOT}/2-work`, log: `${ROOT}/3-log`, shared: `${ROOT}/4-shared` };
const TASKS = `${ROOT}/3-log/tasks.md`;

const digest = (
  audience,
  { shippable = true, hasFailedMarker = false, body, status = "pass" } = {}
) => ({
  audience,
  shippable,
  hasFailedMarker,
  digestMarkdown: shippable ? (body ?? `# Weekly digest — ${audience}\n\nClean content.`) : null,
  verifierStatus: status,
});

const action = (title, tier) => ({ title, tier, rationale: "because" });

function makeInput(overrides = {}) {
  return {
    stamp: "2026-07-01T00-00-00-000Z",
    member: "alex",
    repoRel,
    briefMarkdown: `---\naccess: admin\n---\n\n# Private brief\n\nAcquisition ${ADMIN_SENTINEL}`,
    ownerNextWeekActions: [action("Ship v2", "team"), action("Client update", "external")],
    shareables: [digest("team"), digest("external")],
    spinePaths: SPINE,
    tasksPath: TASKS,
    tasksFileTier: "team",
    manifest: MANIFEST,
    ...overrides,
  };
}

const SEED_TASKS = `---
access: team
---
# Tasks

| ID | Task | Assignee | Status | Sprint | Due |
|----|------|----------|--------|--------|-----|
| T-01 | Existing task | Bob | done | s1 | 2026-01-01 |
`;

// ── 1. only shippable promotes ────────────────────────────────────────────────
test("only shippable digests promote; a FAILED audience is skipped not-shippable", () => {
  const plan = planWriteback(
    makeInput({
      shareables: [digest("team"), digest("external", { shippable: false, hasFailedMarker: true })],
    })
  );
  assert.ok(plan.fileWrites.some((f) => f.id === "digest-team"));
  assert.ok(!plan.fileWrites.some((f) => f.id === "digest-external"));
  assert.ok(
    plan.skips.some(
      (s) => s.artifact === "digest" && s.audience === "external" && s.code === "not-shippable"
    )
  );
});

// ── 2. admin brief never syncable, never double-stamped ───────────────────────
test("admin brief is local-only, tier admin, under log, targets=[local], not double-stamped", () => {
  const plan = planWriteback(makeInput());
  const brief = plan.fileWrites.find((f) => f.artifact === "brief");
  assert.equal(brief.tier, "admin");
  assert.equal(brief.syncable, false);
  assert.deepEqual(brief.targets, ["local"]);
  assert.ok(brief.destRel.startsWith("3-log/"));
  assert.equal(brief.content.match(/access: admin/g).length, 1, "exactly one frontmatter block");
});

// ── 3. admin actions never become rows ────────────────────────────────────────
test("admin next-week actions never become task rows (excluded + counted)", () => {
  const plan = planWriteback(
    makeInput({
      ownerNextWeekActions: [
        action("Ship v2", "team"),
        action(`Secret ${ADMIN_SENTINEL}`, "admin"),
      ],
    })
  );
  const rows = plan.taskWrite?.rows ?? [];
  assert.ok(rows.every((r) => !r.title.includes(ADMIN_SENTINEL)));
  assert.ok(rows.every((r) => r.row_key !== deriveRowKey(`Secret ${ADMIN_SENTINEL}`)));
  assert.ok(plan.skips.some((s) => s.code === "admin-tier" && s.count === 1));
});

// ── 4. pathological admin ceiling still excludes admin ────────────────────────
test("tasksFileTier=admin still excludes admin actions (audienceForTier + explicit delete)", () => {
  const plan = planWriteback(
    makeInput({
      tasksFileTier: "admin",
      ownerNextWeekActions: [action("Ship v2", "team"), action("Admin only", "admin")],
    })
  );
  const rows = plan.taskWrite?.rows ?? [];
  assert.ok(rows.some((r) => r.title === "Ship v2"));
  assert.ok(!rows.some((r) => r.title === "Admin only"));
  assert.ok(plan.skips.some((s) => s.code === "admin-tier"));
});

// ── 5. ceiling honored ─────────────────────────────────────────────────────────
test("a team action against an external-tier tasks.md is above-ceiling", () => {
  const plan = planWriteback(
    makeInput({
      tasksFileTier: "external",
      ownerNextWeekActions: [action("Team thing", "team"), action("Client thing", "external")],
    })
  );
  const rows = plan.taskWrite?.rows ?? [];
  assert.ok(rows.some((r) => r.title === "Client thing"));
  assert.ok(!rows.some((r) => r.title === "Team thing"));
  assert.ok(plan.skips.some((s) => s.code === "above-ceiling" && s.count === 1));
});

// ── 6. malformed tier defaults safely ─────────────────────────────────────────
test("resolveTierOrDefault: malformed/multi-valued/empty → team; valid passes through", () => {
  assert.equal(resolveTierOrDefault("foobar"), "team");
  assert.equal(resolveTierOrDefault(""), "team");
  assert.equal(resolveTierOrDefault(null), "team");
  assert.equal(resolveTierOrDefault(["team", "admin"]), "team"); // multi-valued is malformed
  assert.equal(resolveTierOrDefault("external"), "external");
  assert.equal(resolveTierOrDefault("private"), "admin"); // alias
  assert.equal(audienceForTier("admin"), "owner");
});

// ── 7. sweep the actual written bytes ─────────────────────────────────────────
test("no above-audience sentinel appears in any syncable file or task row", () => {
  const plan = planWriteback(makeInput());
  for (const f of plan.fileWrites.filter((x) => x.syncable)) {
    assert.ok(!f.content.includes(ADMIN_SENTINEL), `${f.id} leaks admin`);
    if (f.audience === "external")
      assert.ok(!f.content.includes(TEAM_SENTINEL), "external leaks team");
  }
  for (const r of plan.taskWrite?.rows ?? []) {
    assert.ok(!r.title.includes(ADMIN_SENTINEL) && !r.title.includes(TEAM_SENTINEL));
  }
});

// ── 8. idempotent ──────────────────────────────────────────────────────────────
test("re-planning yields identical row_keys; merging twice does not duplicate", () => {
  const a = planWriteback(makeInput());
  const b = planWriteback(makeInput());
  assert.deepEqual(
    a.taskWrite.rows.map((r) => r.row_key),
    b.taskWrite.rows.map((r) => r.row_key)
  );
  const once = mergeTaskWriteback(SEED_TASKS, a.taskWrite.rows);
  const twice = mergeTaskWriteback(once, b.taskWrite.rows);
  const count = (s) => (s.match(/\| nw-/g) || []).length;
  assert.equal(count(once), a.taskWrite.rows.length);
  assert.equal(count(twice), count(once), "no duplicate rows on re-merge");
});

// ── 9. tier → folder + frontmatter mapping ────────────────────────────────────
test("team→work, external→shared, brief→log with matching access frontmatter", () => {
  const plan = planWriteback(makeInput());
  const team = plan.fileWrites.find((f) => f.id === "digest-team");
  const ext = plan.fileWrites.find((f) => f.id === "digest-external");
  assert.ok(team.destRel.startsWith("2-work/") && team.tier === "team");
  assert.match(team.content, /^---\naccess: team\n---/);
  assert.deepEqual(team.targets, ["local", "sync"]);
  assert.ok(ext.destRel.startsWith("4-shared/") && ext.tier === "external");
  assert.match(ext.content, /^---\naccess: external\n---/);
});

// ── 10. missing / invalid verifier ────────────────────────────────────────────
test("promotability: failed / pass-but-no-digest / null verifier are all un-promotable", () => {
  assert.deepEqual(promotability(digest("team", { status: "failed" })), {
    ok: false,
    code: "verifier-failed",
  });
  assert.deepEqual(promotability(digest("team", { shippable: false, hasFailedMarker: false })), {
    ok: false,
    code: "missing-digest",
  });
  assert.deepEqual(promotability(digest("team", { shippable: false, hasFailedMarker: true })), {
    ok: false,
    code: "not-shippable",
  });
  assert.deepEqual(promotability({ ...digest("team"), verifierStatus: null }), {
    ok: false,
    code: "verifier-unavailable",
  });
  assert.deepEqual(promotability(digest("team", { status: "corrected" })), { ok: true });
});

// ── 11. manifest fail-closed ──────────────────────────────────────────────────
test("no manifest → all syncable withheld (no-manifest), brief still planned", () => {
  const plan = planWriteback(makeInput({ manifest: null }));
  assert.ok(plan.fileWrites.some((f) => f.artifact === "brief"));
  assert.ok(!plan.fileWrites.some((f) => f.artifact === "digest"), "no digest without manifest");
  assert.equal(plan.taskWrite, null, "no task rows without manifest");
  assert.equal(plan.tierSafetyWithheld, true);
  assert.ok(plan.skips.some((s) => s.artifact === "digest" && s.code === "no-manifest"));
  assert.ok(plan.skips.some((s) => s.artifact === "tasks" && s.code === "no-manifest"));
});

// ── 12. stamp mapping (mismatched --manifest guard, unit form) ─────────────────
test("a manifest's stamp is derived from generatedAt (the CLI compares this to <stamp>)", () => {
  const derive = (g) => g.replace(/[:.]/g, "-");
  assert.equal(derive(MANIFEST.generatedAt), "2026-07-01T00-00-00-000Z");
  assert.notEqual(derive("2020-01-01T00:00:00.000Z"), "2026-07-01T00-00-00-000Z");
});

// ── 13. leak re-sweep aborts a syncable entry ─────────────────────────────────
test("a digest containing an above-audience sentinel is withheld leak-detected", () => {
  const dirty = digest("team", { body: `# digest\n\nLeaked ${ADMIN_SENTINEL}` });
  const plan = planWriteback(makeInput({ shareables: [dirty, digest("external")] }));
  assert.ok(!plan.fileWrites.some((f) => f.id === "digest-team"), "leaky team digest excluded");
  assert.ok(plan.skips.some((s) => s.audience === "team" && s.code === "leak-detected"));
  assert.equal(plan.tierSafetyWithheld, true);
  assert.ok(
    plan.fileWrites.some((f) => f.id === "digest-external"),
    "clean external still planned"
  );
});

// ── 14. planner is side-effect free ───────────────────────────────────────────
test("planWriteback never touches the filesystem (fake, nonexistent spine paths)", () => {
  assert.doesNotThrow(() =>
    planWriteback(
      makeInput({
        spinePaths: { work: "/nope/a", log: "/nope/b", shared: "/nope/c" },
        tasksPath: "/nope/b/tasks.md",
      })
    )
  );
});

// ── 15. skips + json payload audience-safe ────────────────────────────────────
test("a serialized plan payload carries no brief content and trips no leak sweep", () => {
  const plan = planWriteback(
    makeInput({
      ownerNextWeekActions: [
        action("Ship v2", "team"),
        action(`Secret ${ADMIN_SENTINEL}`, "admin"),
      ],
    })
  );
  const payload = {
    stamp: plan.stamp,
    files: plan.fileWrites.map((f) => ({
      id: f.id,
      tier: f.tier,
      destRel: f.destRel,
      syncable: f.syncable,
    })),
    taskRows: plan.taskWrite.rows.map((r) => ({ row_key: r.row_key, title: r.title })),
    skips: plan.skips,
    tierSafetyWithheld: plan.tierSafetyWithheld,
  };
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(ADMIN_SENTINEL), "no admin sentinel in json");
  assert.ok(!json.includes("Private brief"), "no brief body in json");
  assert.deepEqual(sweepForLeaks(json, aboveAudienceStrings(MANIFEST, "external")), []);
});

// ── 16. tasks table not widened ───────────────────────────────────────────────
test("merging 6-field rows keeps a 6-column table 6 columns", () => {
  const plan = planWriteback(makeInput());
  const merged = mergeTaskWriteback(SEED_TASKS, plan.taskWrite.rows);
  const header = merged.split("\n").find((l) => l.startsWith("| ID"));
  assert.equal(header.split("|").filter((c) => c.trim()).length, 6, "still 6 columns");
  assert.ok(!/Parent|Labels|Priority/.test(header));
});

// ── 17. --all both digests ────────────────────────────────────────────────────
test("both shippable digests promote to their tier-faithful folders in one plan", () => {
  const plan = planWriteback(makeInput());
  assert.ok(plan.fileWrites.some((f) => f.id === "digest-team"));
  assert.ok(plan.fileWrites.some((f) => f.id === "digest-external"));
});

// ── 18. stampFrontmatter ENFORCES the intended tier ───────────────────────────
test("stampFrontmatter enforces the passed tier, replacing any existing frontmatter", () => {
  // no frontmatter → stamp the tier
  assert.match(stampFrontmatter("# no fm", "team"), /^---\naccess: team\n---\n\n# no fm/);
  // a wrong/stale access is REPLACED with the intended tier (no mis-tiered promotion)
  assert.equal(
    stampFrontmatter("---\naccess: external\n---\n\nbody", "team"),
    "---\naccess: team\n---\n\nbody"
  );
  // the admin brief re-stamped admin → exactly one block, body intact
  const brief = stampFrontmatter("---\naccess: admin\n---\n\n# brief", "admin");
  assert.equal(brief.match(/access:/g).length, 1);
  assert.match(brief, /# brief/);
});

// ── 19. missing tasks.md ──────────────────────────────────────────────────────
test("no tasks.md → TaskWrite null + missing-tasks skip, no throw", () => {
  const plan = planWriteback(makeInput({ tasksPath: null }));
  assert.equal(plan.taskWrite, null);
  assert.ok(plan.skips.some((s) => s.code === "missing-tasks"));
});

// ── 20. FAILED marker is authoritative even if a stale digest coexists ────────
test("a FAILED marker blocks promotion even when a shippable digest body coexists", () => {
  const stale = { ...digest("team"), hasFailedMarker: true }; // shippable body + FAILED marker
  assert.deepEqual(promotability(stale), { ok: false, code: "not-shippable" });
  const plan = planWriteback(makeInput({ shareables: [stale, digest("external")] }));
  assert.ok(!plan.fileWrites.some((f) => f.id === "digest-team"), "stale+FAILED never promotes");
  assert.ok(plan.skips.some((s) => s.audience === "team" && s.code === "not-shippable"));
});

// ── 21. the task-row leak sweep covers the serialized row, not just the title ──
test("a tier-safe action whose row bytes carry an above-audience sentinel is withheld", () => {
  // team-tier action (passes the tier filter) but the title carries an admin sentinel → the
  // serialized row trips the sweep and the row is withheld leak-detected.
  const plan = planWriteback(
    makeInput({ ownerNextWeekActions: [action(`Do ${ADMIN_SENTINEL} thing`, "team")] })
  );
  assert.equal(plan.taskWrite, null, "no leaky row survives");
  assert.ok(plan.skips.some((s) => s.artifact === "tasks" && s.code === "leak-detected"));
  assert.equal(plan.tierSafetyWithheld, true);
});

// ── row shape sanity ──────────────────────────────────────────────────────────
test("actionToRow emits exactly the six core fields", () => {
  const row = actionToRow(action("Do thing", "team"), "alex");
  assert.deepEqual(Object.keys(row).sort(), [
    "assignee",
    "due",
    "row_key",
    "sprint",
    "status",
    "title",
  ]);
  assert.ok(row.row_key.startsWith("nw-"));
});
