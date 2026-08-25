// Pagination coverage for the shared `paginate` helper's call sites (AIO-1012):
// findLabel (previously unpaginated — a label beyond the server's first page could never
// match, or a substring matched the wrong label) and listTeamMembers (previously guarded
// only against a repeat of the PREVIOUS cursor, so an A→B→A cursor cycle looped forever).
//
// The mock serves BOTH the paginated and the legacy unpaginated label query shapes: an
// unpaginated query simply gets page 0 and no way to ask for more — exactly what the real
// server does — so a regression to the unpaginated form fails these tests for the real
// reason, not because the mock refused the query.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
// The primary copy is exercised directly; the scaffold copy is proven byte-identical by
// the parity test in linear-dotenvx-scope.test.mjs.
const CLI = path.join(ROOT, ".claude/skills/aios-linear/linear.mjs");

const PRELOAD = `import { appendFileSync } from "node:fs";
const pageFor = (after, prefix) => (after ? Number(after.replace(prefix, "")) : 0);
const pageInfoFor = (index, length, prefix) => {
  const cycle = process.env.MOCK_CYCLE === "1";
  const hasNextPage = index + 1 < length || cycle;
  const endCursor = !hasNextPage ? null : index + 1 < length ? prefix + (index + 1) : prefix + "0";
  return { hasNextPage, endCursor };
};
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  const compactQuery = query.replace(/\\s+/g, " ");
  let data;
  if (query.includes("issue(id:$id){ id identifier")) {
    data = { issue: { id: "issue-1", identifier: "AIO-73", title: "t", state: { name: "Backlog" } } };
  } else if (compactQuery.includes("issue(id:$id){ labels")) {
    const pages = JSON.parse(process.env.MOCK_ISSUE_LABEL_PAGES ?? '[[{"id":"existing-1"}]]');
    const index = query.includes("labels(first:250") ? pageFor(variables.after, "issue-label-cursor-") : 0;
    data = { issue: { labels: {
      nodes: pages[index] ?? [],
      ...(query.includes("labels(first:250")
        ? { pageInfo: pageInfoFor(index, pages.length, "issue-label-cursor-") }
        : {})
    } } };
  } else if (compactQuery.includes("issue(id:$id){ comments")) {
    const pages = JSON.parse(process.env.MOCK_COMMENT_PAGES ?? "[[]]");
    const index = query.includes("comments(first:250") ? pageFor(variables.after, "comment-cursor-") : 0;
    data = { issue: { comments: {
      nodes: pages[index] ?? [],
      ...(query.includes("comments(first:250")
        ? { pageInfo: pageInfoFor(index, pages.length, "comment-cursor-") }
        : {})
    } } };
  } else if (compactQuery.includes("team(id:$id){ states")) {
    const pages = JSON.parse(process.env.MOCK_TEAM_STATE_PAGES ?? "[[]]");
    const index = query.includes("states(first:250") ? pageFor(variables.after, "team-state-cursor-") : 0;
    data = { team: { states: {
      nodes: pages[index] ?? [],
      ...(query.includes("states(first:250")
        ? { pageInfo: pageInfoFor(index, pages.length, "team-state-cursor-") }
        : {})
    } } };
  } else if (query.includes("workflowStates(")) {
    const pages = JSON.parse(process.env.MOCK_WORKFLOW_STATE_PAGES ?? "[[]]");
    const index = query.includes("first:250") ? pageFor(variables.after, "workflow-state-cursor-") : 0;
    data = { workflowStates: {
      nodes: pages[index] ?? [],
      ...(query.includes("first:250")
        ? { pageInfo: pageInfoFor(index, pages.length, "workflow-state-cursor-") }
        : {})
    } };
  } else if (query.includes("team(id:$id){ labels")) {
    const pages = JSON.parse(process.env.MOCK_LABEL_PAGES ?? "[[]]");
    const index = pageFor(variables.after, "label-cursor-");
    data = { team: { labels: { nodes: pages[index] ?? [], pageInfo: pageInfoFor(index, pages.length, "label-cursor-") } } };
  } else if (query.includes("members(first:250")) {
    const pages = JSON.parse(process.env.MOCK_MEMBER_PAGES ?? "[[]]");
    const index = pageFor(variables.after, "member-cursor-");
    data = { team: { members: { nodes: pages[index] ?? [], pageInfo: pageInfoFor(index, pages.length, "member-cursor-") } } };
  } else if (query.includes("team(id:$key){ id }")) {
    data = { team: { id: "team-1" } };
  } else if (query.includes("issueUpdate")) {
    appendFileSync(process.env.MOCK_LOG, JSON.stringify(variables) + "\\n");
    data = { issueUpdate: { success: true } };
  } else if (query.includes("issueCreate")) {
    appendFileSync(process.env.MOCK_LOG, JSON.stringify(variables) + "\\n");
    data = { issueCreate: { success: true, issue: {
      identifier: "AIO-9999", title: variables.input.title,
      url: "https://linear.test/AIO-9999", branchName: "test/aio-9999"
    } } };
  } else {
    throw new Error("unexpected query: " + query);
  }
  return { ok: true, json: async () => ({ data }) };
};
`;

function runCli(args, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-pagination-"));
  const preload = path.join(dir, "mock-fetch.mjs");
  const log = path.join(dir, "mutations.log");
  writeFileSync(preload, PRELOAD, "utf8");
  const result = spawnSync(process.execPath, ["--import", preload, CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test-key", MOCK_LOG: log, ...extraEnv },
    // Bounds an uncaught cursor cycle to a test failure instead of a hung suite.
    timeout: 15_000,
  });
  let mutations = [];
  try {
    mutations = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    mutations = [];
  }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, mutations };
}

const LABEL_PAGES = JSON.stringify([
  [{ id: "l-0", name: "alpha" }],
  [{ id: "l-1", name: "needs-triage" }],
]);

// Destructive first-page-only defect: add-label rewrites the full label id set, so omitting
// a later page silently deletes those labels from the issue.
test("add-label preserves current issue labels from every page", () => {
  const r = runCli(["add-label", "AIO-73", "needs-triage"], {
    MOCK_LABEL_PAGES: JSON.stringify([[{ id: "l-1", name: "needs-triage" }]]),
    MOCK_ISSUE_LABEL_PAGES: JSON.stringify([[{ id: "existing-1" }], [{ id: "existing-2" }]]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(
    r.mutations[0].labels.toSorted(),
    ["existing-1", "existing-2", "l-1"],
    "the mutation must preserve labels from later pages"
  );
});

// The first-page-only defect: >1 page of team labels made every label beyond page one
// unmatchable, so add-label failed (and create --label silently dropped the label).
test("add-label finds a team label beyond the first page", () => {
  const r = runCli(["add-label", "AIO-73", "needs-triage"], { MOCK_LABEL_PAGES: LABEL_PAGES });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\+ label "needs-triage"/);
  assert.deepEqual(
    r.mutations[0].labels.toSorted(),
    ["existing-1", "l-1"],
    "the mutation must carry the page-two label id alongside the existing labels"
  );
});

const STATE_PAGES = JSON.stringify([
  [{ id: "state-0", name: "Backlog" }],
  [{ id: "state-1", name: "In Progress" }],
]);

test("create resolves a team state beyond the first page", () => {
  const r = runCli(["create", "Paginated state", "--state", "In Progress"], {
    MOCK_TEAM_STATE_PAGES: STATE_PAGES,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].input.stateId, "state-1");
});

test("set-state resolves a workflow state beyond the first page", () => {
  const r = runCli(["set-state", "AIO-73", "In Progress"], {
    MOCK_WORKFLOW_STATE_PAGES: STATE_PAGES,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].s, "state-1");
});

const COMMENT = (id, body, createdAt) => ({
  id,
  body,
  createdAt,
  updatedAt: createdAt,
  user: { name: "Agent" },
});

test("comments prints comments from every page", () => {
  const r = runCli(["comments", "AIO-73"], {
    MOCK_COMMENT_PAGES: JSON.stringify([
      [COMMENT("comment-1", "first page", "2026-01-01T00:00:00.000Z")],
      [COMMENT("comment-2", "second page", "2026-01-02T00:00:00.000Z")],
    ]),
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /comment-1[\s\S]*first page/);
  assert.match(r.stdout, /comment-2[\s\S]*second page/);
});

test("add-label fails closed on a label cursor cycle instead of looping", () => {
  const r = runCli(["add-label", "AIO-73", "no-such-label"], {
    MOCK_LABEL_PAGES: LABEL_PAGES,
    MOCK_CYCLE: "1",
  });
  assert.equal(r.status, 1, "a label cursor cycle must abort, not loop or succeed");
  assert.match(r.stderr, /label pagination stalled/);
  assert.equal(r.mutations.length, 0);
});

const MEMBER = (id, name) => ({
  id,
  name,
  displayName: name,
  email: `${id}@example.test`,
  active: true,
});
const MEMBER_PAGES = JSON.stringify([[MEMBER("u1", "Alice")], [MEMBER("u2", "Bob")]]);

test("users lists members from every page", () => {
  const r = runCli(["users", "AIO"], { MOCK_MEMBER_PAGES: MEMBER_PAGES });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Alice/);
  assert.match(r.stdout, /Bob/, "a member on the last page must still be listed");
});

// An A→B→A cursor cycle evades a guard that only remembers the PREVIOUS cursor (the old
// listTeamMembers guard) — the shared seen-cursor set must fail closed instead.
test("users fails closed on a member cursor cycle instead of looping", () => {
  const r = runCli(["users", "AIO"], { MOCK_MEMBER_PAGES: MEMBER_PAGES, MOCK_CYCLE: "1" });
  assert.equal(r.status, 1, "a member cursor cycle must abort, not loop or succeed");
  assert.match(r.stderr, /member pagination stalled/);
});
