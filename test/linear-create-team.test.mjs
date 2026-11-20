// test/linear-create-team.test.mjs — which team `linear create` files into.
//
// Before this fix `create` always used AIOS_LINEAR_TEAM_KEY (default AIO), so
// `create --parent VIB-527 --project "Peridot Shore"` reached issueCreate in team AIO and
// Linear rejected it ("project not in same team as issue"). Resolution order is now:
// --team, then the --parent's team, then the --project's single team, then the default.
// Conflicts fail before any mutation is sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scripts/aios.mjs");
const CORE = path.join(ROOT, "scripts/connectors/linear/create.mjs");

// fail() in core.mjs exits the process, so the pure resolver is exercised in a child.
function resolveInChild(args, env = {}) {
  const code = `
    import { resolveCreateTeamKey } from ${JSON.stringify(CORE)};
    console.log(resolveCreateTeamKey(${JSON.stringify(args)}));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test", AIOS_LINEAR_TEAM_KEY: "", ...env },
  });
}

function resolved(args, env) {
  const r = resolveInChild(args, env);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function failsWith(args, pattern) {
  const r = resolveInChild(args);
  assert.notEqual(r.status, 0, `expected failure, got ${r.stdout}`);
  assert.match(r.stderr, pattern);
}

test("explicit --team wins", () => {
  assert.equal(resolved({ team: "VIB" }), "VIB");
});

test("--parent sets the team when --team is absent", () => {
  assert.equal(resolved({ parent: "VIB-527" }), "VIB");
  assert.equal(resolved({ parent: "vib-527" }), "VIB");
});

test("--parent beats a project default and must match the project's team", () => {
  assert.equal(
    resolved({ parent: "VIB-527", project: "Peridot Shore", projectTeamKeys: ["VIB"] }),
    "VIB"
  );
  failsWith(
    { parent: "AIO-1", project: "Peridot Shore", projectTeamKeys: ["VIB"] },
    /not in team AIO/
  );
});

test("a single-team project sets the team", () => {
  assert.equal(resolved({ project: "Peridot Shore", projectTeamKeys: ["VIB"] }), "VIB");
});

test("a multi-team project without --team or --parent fails and asks for --team", () => {
  failsWith({ project: "Shared", projectTeamKeys: ["AIO", "VIB"] }, /several teams.*--team/);
});

test("a multi-team project accepts a --team that is one of its teams", () => {
  assert.equal(
    resolved({ team: "VIB", project: "Shared", projectTeamKeys: ["AIO", "VIB"] }),
    "VIB"
  );
});

test("--team conflicting with --parent fails before any mutation", () => {
  failsWith({ team: "AIO", parent: "VIB-527" }, /conflicts with --parent VIB-527/);
});

test("with no hints the configured default applies, then AIO", () => {
  assert.equal(resolved({}, { AIOS_LINEAR_TEAM_KEY: "VIB" }), "VIB");
  assert.equal(resolved({}), "AIO");
});

// End to end through the CLI with a mocked fetch: the parent's team is the one looked up
// and sent in issueCreate, and a conflict sends no mutation at all.
const PRELOAD = `import { appendFileSync } from "node:fs";
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  appendFileSync(process.env.QUERY_LOG, JSON.stringify({ query, variables }) + "\\n");
  let data;
  if (query.includes("team(id:$key){ id }")) data = { team: { id: "team-" + variables.key } };
  else if (query.includes("states(first:250")) data = { team: { states: {
    nodes: [{ id: "state-1", name: "Backlog" }], pageInfo: { hasNextPage: false, endCursor: null } } } };
  else if (query.includes("projects(first:100")) data = { projects: {
    nodes: [{ id: "proj-1", name: "Peridot Shore", url: "u", status: { name: "Planned", type: "planned" } }],
    pageInfo: { hasNextPage: false, endCursor: null } } };
  else if (query.includes("project(id:$id){ teams")) data = { project: { teams: { nodes: [{ key: "VIB" }] } } };
  else if (query.includes("issue(id:$id){ id identifier")) data = { issue: { id: "parent-1", identifier: variables.id, title: "p", state: { name: "Backlog" } } };
  else if (query.includes("issueCreate")) data = { issueCreate: { success: true, issue: {
    id: "i-1", identifier: "VIB-999", title: variables.input.title, url: "u", branchName: "b" } } };
  else throw new Error("unexpected query: " + query);
  return new Response(JSON.stringify({ data }), { status: 200 });
};
`;

function runCreate(args) {
  const dir = mkdtempSync(path.join(tmpdir(), "linear-create-team-"));
  const preload = path.join(dir, "preload.mjs");
  const log = path.join(dir, "queries.log");
  writeFileSync(preload, PRELOAD);
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, ["--import", preload, CLI, "linear", "create", ...args], {
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test", AIOS_LINEAR_TEAM_KEY: "", QUERY_LOG: log },
  });
  const queries = readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  rmSync(dir, { recursive: true, force: true });
  return { r, queries };
}

test("create --parent VIB-527 --project 'Peridot Shore' files into VIB", () => {
  const { r, queries } = runCreate(["Slice", "--parent", "VIB-527", "--project", "Peridot Shore"]);
  assert.equal(r.status, 0, r.stderr);
  const teamLookup = queries.find((q) => q.query.includes("team(id:$key){ id }"));
  assert.equal(teamLookup.variables.key, "VIB");
  const create = queries.find((q) => q.query.includes("issueCreate"));
  assert.equal(create.variables.input.teamId, "team-VIB");
  assert.equal(create.variables.input.projectId, "proj-1");
});

test("create --team AIO --parent VIB-527 sends no mutation", () => {
  const { r, queries } = runCreate(["Slice", "--team", "AIO", "--parent", "VIB-527"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /conflicts with --parent/);
  assert.equal(queries.filter((q) => q.query.includes("issueCreate")).length, 0);
});
