// AIO-1072 — `aios linear query`, the built-in port of the retired linear-direct
// descriptor client. Unit layer: pagination/caps through an injected request seam.
// Spawn layer: the canonical route against the in-process mock provider — no network,
// no live credentials (LINEAR_API_KEY is synthetic).
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  ASSIGNED_OPEN_QUERY,
  queryAssignedOpenIssues,
} from "../scripts/connectors/linear/query.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const AIOS = path.join(ROOT, "scripts", "aios.mjs");
const MOCK = path.join(ROOT, "test", "helpers", "mock-linear-provider.mjs");

test("paginates every open issue assigned to the authenticated Linear viewer", async () => {
  const calls = [];
  const pages = [
    {
      viewer: {
        name: "John",
        assignedIssues: {
          nodes: [{ id: "one" }, { id: "two" }],
          pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
        },
      },
    },
    {
      viewer: {
        name: "John",
        assignedIssues: {
          nodes: [{ id: "three" }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
  ];
  const request = async (query, variables) => {
    calls.push({ query, variables });
    return pages.shift();
  };

  const result = await queryAssignedOpenIssues({ request, pageSize: 2 });

  assert.deepEqual(
    result.viewer.assignedIssues.nodes.map((issue) => issue.id),
    ["one", "two", "three"]
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[1].variables.after, "cursor-2");
});

test("the assigned-open query excludes every resolved Linear state type", () => {
  assert.match(ASSIGNED_OPEN_QUERY, /nin:\s*\["completed",\s*"canceled"\]/);
});

test("the pagination safety cap fails loudly instead of walking forever", async () => {
  const request = async () => ({
    viewer: {
      name: "John",
      assignedIssues: {
        nodes: [{ id: "a" }, { id: "b" }],
        pageInfo: { hasNextPage: true, endCursor: "again" },
      },
    },
  });
  await assert.rejects(
    () => queryAssignedOpenIssues({ request, pageSize: 2, maxIssues: 3 }),
    /safety cap/
  );
});

function runQuery(args) {
  return spawnSync(process.execPath, ["--import", MOCK, AIOS, "linear", "query", ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "synthetic-parity-key-not-real" },
  });
}

test("`aios linear query` defaults to the viewer's open assigned issues as JSON", () => {
  const result = runQuery([]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.viewer.assignedIssues.nodes[0].identifier, "AIO-73");
  assert.doesNotMatch(result.stdout, /synthetic-parity-key/, "credential leaked");
});

test("`aios linear query '<graphql>'` is a raw passthrough printing the data payload", () => {
  const result = runQuery(["{ teams { nodes { name key } } }"]);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.teams.nodes[0].key, "AIO");
});

test("an unknown flag is a loud usage failure, not a silent default query", () => {
  const result = runQuery(["--nope"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown option --nope/);
});
