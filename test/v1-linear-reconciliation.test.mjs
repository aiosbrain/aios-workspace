import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedByIdentifiers,
  fetchAllTeamIssues,
  normalizeStatus,
} from "../scripts/v1-linear-reconciliation.mjs";

test("blockedByIdentifiers follows Linear's inverse blocks direction", () => {
  const issue = {
    inverseRelations: {
      nodes: [
        { type: "blocks", issue: { identifier: "AIO-130" } },
        { type: "related", issue: { identifier: "AIO-999" } },
      ],
    },
  };
  assert.deepEqual(blockedByIdentifiers(issue), ["AIO-130"]);
  assert.deepEqual(blockedByIdentifiers({}), []);
});

test("fetchAllTeamIssues follows every Linear cursor", async () => {
  const calls = [];
  const pages = new Map([
    [
      null,
      { pageInfo: { hasNextPage: true, endCursor: "page-2" }, nodes: [{ identifier: "AIO-425" }] },
    ],
    [
      "page-2",
      { pageInfo: { hasNextPage: true, endCursor: "page-3" }, nodes: [{ identifier: "AIO-250" }] },
    ],
    [
      "page-3",
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ identifier: "AIO-123" }] },
    ],
  ]);
  const request = async (_query, variables) => {
    calls.push(variables);
    return { issues: pages.get(variables.after) };
  };

  const issues = await fetchAllTeamIssues(request, "AIO");

  assert.deepEqual(
    issues.map((issue) => issue.identifier),
    ["AIO-425", "AIO-250", "AIO-123"]
  );
  assert.deepEqual(calls, [
    { key: "AIO", after: null },
    { key: "AIO", after: "page-2" },
    { key: "AIO", after: "page-3" },
  ]);
});

test("fetchAllTeamIssues rejects a missing continuation cursor", async () => {
  await assert.rejects(
    fetchAllTeamIssues(
      async () => ({ issues: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [] } }),
      "AIO"
    ),
    /without an end cursor/
  );
});

test("normalizeStatus matches README status tokens", () => {
  assert.equal(normalizeStatus("In Progress"), "in_progress");
  assert.equal(normalizeStatus("Done"), "done");
});
