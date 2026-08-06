import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scaffold/.claude/skills/aios-linear/linear.mjs");

function runCli(args, mode, cwd = ROOT) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-cli-"));
  const preload = path.join(dir, "mock-fetch.mjs");
  const log = path.join(dir, "mutations.log");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const issue = (id, identifier) => ({ id, identifier, title: identifier, state: { name: "Backlog" } });
const a = issue("issue-a", "AIO-73");
const b = issue("issue-b", "AIO-75");
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const mode = process.env.MOCK_MODE;
  let data;
  if (query.includes("issue(id:$id){ id identifier")) {
    if (query.includes("issues(first:250")) throw new Error("paginated lookup used");
    const found = variables.id === "AIO-73" ? a : variables.id === "AIO-75" ? b : issue("issue-old", variables.id);
    data = { issue: found };
  } else if (query.includes("issues(first:250, after:$after")) {
    data = variables.after
      ? { issues: { nodes: [issue("issue-251", "AIO-251")], pageInfo: { hasNextPage: false, endCursor: null } } }
      : { issues: { nodes: [issue("issue-1", "AIO-1")], pageInfo: { hasNextPage: true, endCursor: "page-2" } } };
  } else if (query.includes("inverseRelations(first:250")) {
    const relation = { id: "relation-1", type: "related", issue: b, relatedIssue: a };
    const secondPage = variables.inverseAfter === "inverse-page-2";
    const paged = mode === "related-page-2";
    data = { issue: { identifier: "AIO-73",
      relations: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      inverseRelations: {
        nodes: !paged || secondPage ? [relation] : [],
        pageInfo: { hasNextPage: paged && !secondPage, endCursor: paged && !secondPage ? "inverse-page-2" : null }
      }
    } };
  } else if (query.includes("members(first:250")) {
    if (variables.key !== "AIO") throw new Error("unexpected team key: " + variables.key);
    data = { team: { members: { nodes: [
      { id: "u1", name: "Alice Smith", displayName: "Alice", email: "alice@example.test", active: true },
      { id: "u2", name: "Alison Jones", displayName: "Alison", email: "alison@example.test", active: true }
    ], pageInfo: { hasNextPage: false, endCursor: null } } } };
  } else if (query.includes("issueRelationCreate") || query.includes("issueUpdate")) {
    appendFileSync(process.env.MOCK_LOG, query + "\\n");
    data = { issueRelationCreate: { success: true }, issueUpdate: { success: true } };
  } else {
    throw new Error("unexpected query: " + query);
  }
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
};
`,
    "utf8"
  );
  const result = spawnSync(process.execPath, ["--import", preload, CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test", MOCK_MODE: mode, MOCK_LOG: log },
  });
  const mutations = readFileSync(log, { encoding: "utf8", flag: "a+" });
  rmSync(dir, { recursive: true, force: true });
  return { ...result, mutations };
}

test("get resolves old issue identifiers directly", () => {
  const result = runCli(["get", "AIO-1"], "get-old");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AIO-1/);
});

test("list follows every issue page", () => {
  const result = runCli(["list", "AIO"], "list-pages");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AIO-1/);
  assert.match(result.stdout, /AIO-251/);
});

test("relations displays inverse related links", () => {
  const result = runCli(["relations", "AIO-73"], "related-inverse");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /related\s+AIO-75/);
});

test("related is idempotent for inverse storage direction", () => {
  const result = runCli(["related", "AIO-73", "AIO-75"], "related-inverse");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already related/);
  assert.equal(result.mutations, "");
});

test("related checks every relation page before creating", () => {
  const result = runCli(["related", "AIO-73", "AIO-75"], "related-page-2");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already related/);
  assert.equal(result.mutations, "");
});

test("assign rejects ambiguous partial member matches before mutation", () => {
  const result = runCli(["assign", "AIO-73", "ali"], "ambiguous-user");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no unique exact match/);
  assert.match(result.stderr, /Alice Smith/);
  assert.match(result.stderr, /Alison Jones/);
  assert.equal(result.mutations, "");
});

test("assign derives the canonical team key from a lowercase identifier", () => {
  const result = runCli(["assign", "aio-73", "alice@example.test"], "lowercase-team");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /assigned AIO-73/);
  assert.match(result.mutations, /issueUpdate/);
});

test("set-priority rejects inherited object property names before mutation", () => {
  const result = runCli(["set-priority", "AIO-73", "constructor"], "invalid-priority");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /priority must be one of/);
  assert.equal(result.mutations, "");
});

test("template resolves from outside the repository", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "aios-linear-sibling-"));
  const result = spawnSync(process.execPath, [CLI, "template", "aios"], { cwd, encoding: "utf8" });
  rmSync(cwd, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## What \/ why/);
});
