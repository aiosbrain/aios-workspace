import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { normalizeLinearIssues } from "../scaffold/.claude/descriptors/skills/linear-direct/linear-activity-pull.mjs";
import * as linearActivity from "../scaffold/.claude/descriptors/skills/linear-direct/linear-activity-pull.mjs";

test("normalizes viewer-assigned open Linear issues into admin activity revisions", () => {
  const records = normalizeLinearIssues({
    viewer: {
      assignedIssues: {
        nodes: [
          {
            id: "issue-631",
            identifier: "AIO-631",
            title: "Confirm Q3 travel expense policy with finance",
            updatedAt: "2026-07-29T09:15:00.000Z",
            state: { name: "Backlog" },
          },
        ],
      },
    },
  });

  assert.deepEqual(records, [
    {
      source: "linear",
      tier: "admin",
      occurredAt: "2026-07-29T09:15:00.000Z",
      ref: "linear:issue-631:2026-07-29T09:15:00.000Z",
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
    ref: "linear:issue-631:2026-07-29T09:15:00.000Z",
    summary: "Linear AIO-631 · Backlog: Confirm policy",
    waitingOn: "me",
  };
  const revised = {
    ...first,
    occurredAt: "2026-07-29T10:15:00.000Z",
    ref: "linear:issue-631:2026-07-29T10:15:00.000Z",
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

test("pulls through the existing Linear query connector before writing activity", async () => {
  assert.equal(typeof linearActivity.pullLinearActivity, "function");
  const repo = mkdtempSync(path.join(tmpdir(), "aios-linear-pull-"));
  const activityPath = path.join(repo, "1-inbox", "comms", "activity.jsonl");
  let queriedRepo = null;
  const result = await linearActivity.pullLinearActivity({
    repo,
    activityPath,
    query(queryRepo) {
      queriedRepo = queryRepo;
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

  assert.equal(queriedRepo, repo);
  assert.equal(result.records.length, 1);
  assert.equal(result.written, 1);
  assert.match(readFileSync(activityPath, "utf8"), /"source":"linear"/);
});

test("exposes the manual Linear activity command used by the daily orchestrator", () => {
  assert.equal(typeof linearActivity.main, "function");
});
