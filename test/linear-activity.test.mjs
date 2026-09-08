import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// AIO-1072: the activity adapter is the built-in `aios linear activity` verb now — the
// descriptor-vendored client is retired.
import { normalizeLinearIssues } from "../scripts/connectors/linear/activity.mjs";
import * as linearActivity from "../scripts/connectors/linear/activity.mjs";

test("normalizes viewer-assigned open Linear issues into admin activity revisions", () => {
  const records = normalizeLinearIssues(
    {
      viewer: {
        assignedIssues: {
          nodes: [
            {
              id: "issue-631",
              identifier: "AIO-631",
              title: "Confirm Q3 travel expense policy with finance",
              updatedAt: "2026-07-27T09:15:00.000Z",
              state: { name: "Backlog" },
            },
          ],
        },
      },
    },
    { observedAt: "2026-07-29T09:15:00.000Z" }
  );

  assert.deepEqual(records, [
    {
      source: "linear",
      tier: "admin",
      occurredAt: "2026-07-29T09:15:00.000Z",
      ref: "linear:issue-631",
      revision: "2026-07-27T09:15:00.000Z@2026-07-29",
      active: true,
      summary: "Linear AIO-631 · Backlog: Confirm Q3 travel expense policy with finance",
      waitingOn: "me",
    },
  ]);
});

test("provides an idempotent activity writer for Linear revisions", () => {
  assert.equal(typeof linearActivity.appendLinearActivity, "function");
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-activity-"));
  const activityPath = path.join(dir, "comms", "activity.jsonl");
  const first = {
    source: "linear",
    tier: "admin",
    occurredAt: "2026-07-29T09:15:00.000Z",
    ref: "linear:issue-631",
    revision: "2026-07-29T09:00:00.000Z@2026-07-29",
    active: true,
    summary: "Linear AIO-631 · Backlog: Confirm policy",
    waitingOn: "me",
  };
  const revised = {
    ...first,
    occurredAt: "2026-07-29T10:15:00.000Z",
    revision: "2026-07-29T10:00:00.000Z@2026-07-29",
    summary: "Linear AIO-631 · In Progress: Confirm policy",
  };

  assert.deepEqual(linearActivity.appendLinearActivity(activityPath, [first]), {
    written: 1,
    skipped: 0,
  });
  assert.deepEqual(linearActivity.appendLinearActivity(activityPath, [first, revised]), {
    written: 1,
    skipped: 1,
  });
  assert.equal(readFileSync(activityPath, "utf8").trim().split("\n").length, 2);
});

test("records a safer tier for an otherwise unchanged Linear revision", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-tier-change-"));
  const activityPath = path.join(dir, "comms", "activity.jsonl");
  const team = {
    source: "linear",
    tier: "team",
    occurredAt: "2026-07-29T09:15:00.000Z",
    ref: "linear:issue-631",
    revision: "2026-07-29T09:00:00.000Z@2026-07-29",
    active: true,
    summary: "Linear AIO-631 · Backlog: Confirm policy",
    waitingOn: "me",
  };
  const admin = { ...team, tier: "admin", occurredAt: "2026-07-29T10:15:00.000Z" };

  linearActivity.appendLinearActivity(activityPath, [team]);
  const result = linearActivity.appendLinearActivity(activityPath, [admin]);

  assert.equal(result.written, 1);
  assert.equal(
    linearActivity.loadLatestLinearRecords(activityPath).get("linear:issue-631").tier,
    "admin"
  );
});

test("pulls through the existing Linear query connector before writing activity", async () => {
  assert.equal(typeof linearActivity.pullLinearActivity, "function");
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-pull-"));
  const activityPath = path.join(repo, "1-inbox", "comms", "activity.jsonl");
  let queried = 0;
  const result = await linearActivity.pullLinearActivity({
    repo,
    activityPath,
    query() {
      // The adapter's own query verb (credential resolved by the index.mjs preflight) —
      // no repo argument since AIO-1072; the pull only normalizes and appends.
      queried++;
      return {
        viewer: {
          assignedIssues: {
            nodes: [
              {
                id: "issue-632",
                identifier: "AIO-632",
                title: "Follow up on overdue onboarding review",
                updatedAt: "2026-07-29T09:30:00.000Z",
                state: { name: "Backlog" },
              },
            ],
          },
        },
      };
    },
  });

  assert.equal(queried, 1);
  assert.equal(result.records.length, 1);
  assert.equal(result.written, 1);
  assert.match(readFileSync(activityPath, "utf8"), /"source":"linear"/);
});

test("emits a tombstone when a previously assigned issue is no longer returned", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-tombstone-"));
  const activityPath = path.join(repo, "1-inbox", "comms", "activity.jsonl");
  const pages = [
    {
      viewer: {
        assignedIssues: {
          nodes: [
            {
              id: "issue-631",
              identifier: "AIO-631",
              title: "Confirm policy",
              updatedAt: "2026-07-27T09:00:00.000Z",
              state: { name: "Backlog" },
            },
          ],
        },
      },
    },
    { viewer: { assignedIssues: { nodes: [] } } },
  ];
  const query = () => pages.shift();

  await linearActivity.pullLinearActivity({
    repo,
    activityPath,
    now: new Date("2026-07-29T09:00:00.000Z"),
    query,
  });
  const result = await linearActivity.pullLinearActivity({
    repo,
    activityPath,
    now: new Date("2026-07-29T10:00:00.000Z"),
    query,
  });

  assert.equal(result.written, 1);
  assert.equal(result.records[0].ref, "linear:issue-631");
  assert.equal(result.records[0].active, false);
  assert.equal(result.records[0].waitingOn, undefined);
});

test("reactivates a same-day issue after an absence tombstone", async () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-reactivate-"));
  const activityPath = path.join(repo, "1-inbox", "comms", "activity.jsonl");
  const issue = {
    id: "issue-631",
    identifier: "AIO-631",
    title: "Confirm policy",
    updatedAt: "2026-07-27T09:00:00.000Z",
    state: { name: "Backlog" },
  };
  const pages = [
    { viewer: { assignedIssues: { nodes: [issue] } } },
    { viewer: { assignedIssues: { nodes: [] } } },
    { viewer: { assignedIssues: { nodes: [issue] } } },
  ];
  const query = () => pages.shift();

  await linearActivity.pullLinearActivity({
    repo,
    activityPath,
    now: new Date("2026-07-29T09:00:00.000Z"),
    query,
  });
  await linearActivity.pullLinearActivity({
    repo,
    activityPath,
    now: new Date("2026-07-29T10:00:00.000Z"),
    query,
  });
  const result = await linearActivity.pullLinearActivity({
    repo,
    activityPath,
    now: new Date("2026-07-29T11:00:00.000Z"),
    query,
  });

  assert.equal(result.written, 1);
  assert.equal(
    linearActivity.loadLatestLinearRecords(activityPath).get("linear:issue-631").active,
    true
  );
});

test("exposes the manual Linear activity command used by the daily orchestrator", () => {
  // Invoked as `aios linear activity pull` by the operator loop (AIO-1072).
  assert.equal(typeof linearActivity.cmdActivity, "function");
});
