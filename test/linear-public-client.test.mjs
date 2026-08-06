import assert from "node:assert/strict";
import test from "node:test";

import { createLinearClient } from "../scripts/linear-client.mjs";

const key = "fixture-linear-key";
const response = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  async text() {
    return JSON.stringify(body);
  },
});

const issueNode = (identifier = "ENG-42", overrides = {}) => ({
  identifier,
  title: "Portable CLI",
  description: "",
  priority: 2,
  createdAt: "2026-08-05T00:00:00Z",
  state: { name: "Todo", type: "unstarted" },
  assignee: null,
  labels: { nodes: [] },
  parent: null,
  children: { nodes: [] },
  relations: { nodes: [] },
  inverseRelations: { nodes: [] },
  comments: { nodes: [] },
  attachments: { nodes: [] },
  ...overrides,
});

test("public create resolves team, performs one mutation, and verifies by readback", async () => {
  const calls = [];
  const fetchFn = async (_url, init) => {
    const request = JSON.parse(init.body);
    calls.push(request);
    if (/AiosLinearIdentity/.test(request.query)) {
      return response({ data: { viewer: { id: "u1" }, teams: { nodes: [{ id: "t1", key: "ENG", name: "Engineering" }] } } });
    }
    if (/AiosLinearCreate/.test(request.query)) {
      return response({ data: { issueCreate: { success: true, issue: { identifier: "ENG-42" } } } });
    }
    if (/GetIssue/.test(request.query)) {
      return response({ data: { issues: { nodes: [issueNode()] } } });
    }
    throw new Error("unexpected query");
  };
  const client = createLinearClient({ apiKey: key, fetchFn, retryDelayMs: 0 });
  const issue = await client.createWorkspaceIssue({ team: "ENG", title: "Portable CLI", priority: 2 });
  assert.equal(issue.identifier, "ENG-42");
  assert.equal(calls.filter((call) => /AiosLinearCreate/.test(call.query)).length, 1);
  assert.deepEqual(calls.find((call) => /AiosLinearCreate/.test(call.query)).variables.input, {
    teamId: "t1",
    title: "Portable CLI",
    description: "",
    priority: 2,
  });
});

test("GraphQL RATELIMITED in an HTTP 400 retries reads but never mutations", async () => {
  let readCalls = 0;
  const rateLimited = response(
    { errors: [{ message: "slow down", extensions: { code: "RATELIMITED" } }] },
    400
  );
  const readClient = createLinearClient({
    apiKey: key,
    retryDelayMs: 0,
    fetchFn: async () => {
      readCalls++;
      if (readCalls === 1) return rateLimited;
      return response({ data: { viewer: { id: "u1" }, teams: { nodes: [] } } });
    },
  });
  assert.equal((await readClient.getIdentity()).viewer.id, "u1");
  assert.equal(readCalls, 2);

  let mutationCalls = 0;
  const mutationClient = createLinearClient({
    apiKey: key,
    retryDelayMs: 0,
    fetchFn: async (_url, init) => {
      const request = JSON.parse(init.body);
      if (/IssueMeta/.test(request.query)) {
        return response({ data: { issues: { nodes: [{ id: "i1", identifier: "ENG-1", team: { id: "t1", key: "ENG" } }] } } });
      }
      mutationCalls++;
      return rateLimited;
    },
  });
  await assert.rejects(() => mutationClient.addComment("ENG-1", "note"), /Linear HTTP 400/);
  assert.equal(mutationCalls, 1);
});

test("relation create is directional and verified by relation id", async () => {
  let readbacks = 0;
  const fetchFn = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (/IssueMeta/.test(request.query)) {
      const identifier = request.variables.key === "ENG" && request.variables.num === 1 ? "ENG-1" : "ENG-2";
      return response({ data: { issues: { nodes: [{ id: identifier === "ENG-1" ? "i1" : "i2", identifier, team: { id: "t1", key: "ENG" } }] } } });
    }
    if (/AiosLinearRelationCreate/.test(request.query)) {
      assert.deepEqual(request.variables.input, { issueId: "i1", relatedIssueId: "i2", type: "blocks" });
      return response({ data: { issueRelationCreate: { success: true, issueRelation: { id: "r1", type: "blocks" } } } });
    }
    if (/GetIssue/.test(request.query)) {
      readbacks++;
      return response({ data: { issues: { nodes: [issueNode("ENG-1", { relations: { nodes: [{ id: "r1", type: "blocks", relatedIssue: { identifier: "ENG-2", state: { name: "Todo", type: "unstarted" } } }] } })] } } });
    }
    throw new Error("unexpected query");
  };
  const client = createLinearClient({ apiKey: key, fetchFn, retryDelayMs: 0 });
  const result = await client.addRelation("ENG-1", "ENG-2", "blocks");
  assert.equal(result.id, "r1");
  assert.equal(readbacks, 1);
});
