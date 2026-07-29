import test from "node:test";
import assert from "node:assert/strict";

import { queryAssignedOpenIssues } from "../scaffold/.claude/descriptors/skills/linear-direct/linear-query-client.mjs";

test("paginates every open issue assigned to the authenticated Linear viewer", async () => {
  const calls = [];
  const pages = [
    {
      data: {
        viewer: {
          name: "John",
          assignedIssues: {
            nodes: [{ id: "one" }, { id: "two" }],
            pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
          },
        },
      },
    },
    {
      data: {
        viewer: {
          name: "John",
          assignedIssues: {
            nodes: [{ id: "three" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    },
  ];
  const fetchImpl = async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => pages.shift() };
  };

  const result = await queryAssignedOpenIssues({
    apiKey: "fixture-key",
    fetchImpl,
    pageSize: 2,
  });

  assert.deepEqual(
    result.viewer.assignedIssues.nodes.map((issue) => issue.id),
    ["one", "two", "three"]
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.after, "cursor-2");
});

test("the assigned-open query excludes every resolved Linear state type", async () => {
  let request;
  const fetchImpl = async (_url, init) => {
    request = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        data: {
          viewer: {
            name: "John",
            assignedIssues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }),
    };
  };

  await queryAssignedOpenIssues({ apiKey: "fixture-key", fetchImpl });

  assert.match(request.query, /nin:\s*\["completed",\s*"canceled"\]/);
});
