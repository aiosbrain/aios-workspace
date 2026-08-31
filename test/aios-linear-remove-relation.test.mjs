import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scripts/aios.mjs");

function runRemove(mode, type = "blocks") {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-remove-relation-"));
  const preload = path.join(dir, "mock-fetch.mjs");
  const log = path.join(dir, "mutations.log");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const issues = [
  { id: "issue-a", identifier: "AIO-73", title: "A", state: { name: "Backlog" } },
  { id: "issue-b", identifier: "AIO-75", title: "B", state: { name: "Backlog" } },
];
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("issue(id:$id){ id identifier")) {
    data = { issue: issues.find((item) => item.identifier === variables.id) ?? null };
  } else if (query.includes("Relations(first:250") || query.includes("relations(first:250")) {
    const inverse = query.includes("inverseRelations(first:250");
    const relation = {
      id: "relation-1",
      type: process.env.MOCK_RELATION_MODE === "related-inverse" ? "related" : "blocks",
      issue: process.env.MOCK_RELATION_MODE === "related-inverse" ? issues[1] : issues[0],
      relatedIssue: process.env.MOCK_RELATION_MODE === "related-inverse" ? issues[0] : issues[1],
    };
    const secondPage = variables.after === "relations-page-2";
    const paged = process.env.MOCK_RELATION_MODE === "blocks-page-2";
    data = {
      issue: {
        identifier: "AIO-73",
        [inverse ? "inverseRelations" : "relations"]: inverse
          ? {
              nodes: process.env.MOCK_RELATION_MODE === "related-inverse" ? [relation] : [],
              pageInfo: { hasNextPage: false, endCursor: null },
            }
          : {
              nodes: (process.env.MOCK_RELATION_MODE === "blocks" || (paged && secondPage)) ? [relation] : [],
              pageInfo: { hasNextPage: paged && !secondPage, endCursor: paged && !secondPage ? "relations-page-2" : null },
            },
      },
    };
  } else if (query.includes("issueRelationDelete")) {
    appendFileSync(process.env.MOCK_LOG, variables.id + "\\n");
    data = { issueRelationDelete: { success: true } };
  } else {
    throw new Error("unexpected query: " + query);
  }
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
    "utf8"
  );
  const result = spawnSync(
    process.execPath,
    ["--import", preload, CLI, "linear", "remove-relation", "AIO-73", "AIO-75", type],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, LINEAR_API_KEY: "test", MOCK_RELATION_MODE: mode, MOCK_LOG: log },
    }
  );
  const mutations = readFileSync(log, { encoding: "utf8", flag: "a+" })
    .trim()
    .split("\n")
    .filter(Boolean);
  rmSync(dir, { recursive: true, force: true });
  return { ...result, mutations };
}

test("remove-relation deletes the exact directional blocks relation", () => {
  const result = runRemove("blocks");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed blocks relation: AIO-73 -> AIO-75/);
  assert.deepEqual(result.mutations, ["relation-1"]);
});

test("remove-relation accepts either storage direction for related issues", () => {
  const result = runRemove("related-inverse", "related");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /removed related relation: AIO-73 -> AIO-75/);
  assert.deepEqual(result.mutations, ["relation-1"]);
});

test("remove-relation finds the exact relation on a later page", () => {
  const result = runRemove("blocks-page-2");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.mutations, ["relation-1"]);
});

test("remove-relation is an idempotent no-op when the exact relation is absent", () => {
  const result = runRemove("none");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AIO-73 has no blocks relation to AIO-75/);
  assert.deepEqual(result.mutations, []);
});
