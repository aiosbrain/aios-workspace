// test/delivery/render.test.mjs — human table + --json rendering for `aios delivery status`.
import test from "node:test";
import assert from "node:assert/strict";

import { renderTable, renderJson } from "../../scripts/delivery/render.mjs";
import { reconcileRepo } from "../../scripts/delivery/reconcile.mjs";

const FIXED_NOW = () => new Date("2026-07-28T12:00:00.000Z");

function sampleReports() {
  return [
    reconcileRepo({
      slug: "aiosbrain/aios-workspace",
      localPath: "/repo/aios-workspace",
      prs: [
        {
          number: 10,
          title: "feat: something",
          url: "https://github.com/aiosbrain/aios-workspace/pull/10",
          state: "OPEN",
          isDraft: false,
          headRefName: "feat/x",
          headRefOid: "a".repeat(40),
          baseRefName: "main",
          mergeStateStatus: "CLEAN",
          mergeable: "MERGEABLE",
          reviewDecision: "",
          statusCheckRollup: [{ __typename: "CheckRun", conclusion: "SUCCESS" }],
          updatedAt: "2026-07-28T00:00:00Z",
        },
        {
          number: 9,
          title: "fix: cleanup candidate",
          url: "https://github.com/aiosbrain/aios-workspace/pull/9",
          state: "MERGED",
          isDraft: false,
          headRefName: "fix/y",
          headRefOid: "b".repeat(40),
          mergeStateStatus: "UNKNOWN",
          mergeable: "UNKNOWN",
          reviewDecision: "",
          statusCheckRollup: [],
          mergedAt: "2026-07-20T00:00:00Z",
        },
      ],
      worktrees: [{ path: "/repo/aios-workspace-worktrees/y", branch: "fix/y" }],
      branches: { local: [{ name: "fix/y", sha: "b".repeat(40) }], remote: [] },
      dirty: false,
    }),
    reconcileRepo({
      slug: "aiosbrain/aios-team-brain",
      localPath: "/repo/aios-team-brain",
      localError: "not found at /repo/aios-team-brain",
      prs: [],
      worktrees: null,
      branches: null,
      dirty: null,
    }),
  ];
}

test("renderJson: stable field names, round-trips, and the injected clock is honored", () => {
  const out = renderJson(sampleReports(), { now: FIXED_NOW });
  const parsed = JSON.parse(out);
  assert.equal(parsed.generatedAt, "2026-07-28T12:00:00.000Z");
  assert.equal(parsed.repos.length, 2);
  assert.equal(parsed.repos[0].slug, "aiosbrain/aios-workspace");
  assert.equal(parsed.repos[0].prs[1].needsCleanup, true);
  assert.equal(parsed.repos[1].localError, "not found at /repo/aios-team-brain");
});

test("renderJson output is idempotent for the same input", () => {
  const reports = sampleReports();
  assert.equal(renderJson(reports, { now: FIXED_NOW }), renderJson(reports, { now: FIXED_NOW }));
});

test("renderTable: includes both repo slugs, PR numbers, and the needs-cleanup flag", () => {
  const out = renderTable(sampleReports(), { now: FIXED_NOW });
  assert.match(out, /aiosbrain\/aios-workspace/);
  assert.match(out, /aiosbrain\/aios-team-brain/);
  assert.match(out, /#10/);
  assert.match(out, /#9/);
  assert.match(out, /needs-cleanup/);
  assert.match(out, /not found at \/repo\/aios-team-brain/);
});

test("renderTable: always states the read-only guarantee", () => {
  const out = renderTable(sampleReports(), { now: FIXED_NOW });
  assert.match(out, /Read-only: this report never merges, deploys, tags, or deletes anything\./);
});

test("renderTable: a dirty checkout is labelled reported-only, never as an action taken", () => {
  const reports = [
    reconcileRepo({
      slug: "acme/repo",
      localPath: "/repo/acme",
      prs: [],
      worktrees: [],
      branches: { local: [], remote: [] },
      dirty: true,
    }),
  ];
  const out = renderTable(reports, { now: FIXED_NOW });
  assert.match(out, /DIRTY/);
  assert.match(out, /reported only — never touched/);
});
