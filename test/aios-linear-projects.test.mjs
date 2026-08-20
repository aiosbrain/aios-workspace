// Coverage for the project commands (AIO-942): `projects`, `create-project`, and the
// `--project` / `--priority` options on `create`. The duplicate guard is the important
// one — Linear will happily create two projects with the same name, and a duplicate makes
// every later `set-project` resolve ambiguously.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scaffold/.claude/skills/aios-linear/linear.mjs");

// `existing` is the project list the mocked Linear returns for any ProjectFilter query.
function runCli(args, existing = [], extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-projects-"));
  const preload = path.join(dir, "mock-fetch.mjs");
  const log = path.join(dir, "mutations.log");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const existing = ${JSON.stringify(existing)};
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("projects(first:100")) {
    const needle = (variables.f?.name?.containsIgnoreCase ?? "").toLowerCase();
    data = { projects: { nodes: existing.filter((p) => p.name.toLowerCase().includes(needle)) } };
  } else if (query.includes("team(id:$key){ id }")) {
    data = { team: { id: "team-1" } };
  } else if (query.includes("states")) {
    data = { team: { states: { nodes: [{ id: "state-1", name: "Backlog" }] } } };
  } else if (query.includes("projectCreate")) {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(variables) + "\\n");
    data = { projectCreate: { success: true, project: { id: "p-new", name: variables.input.name, url: "https://linear.app/x/project/new" } } };
  } else if (query.includes("issueCreate")) {
    appendFileSync(${JSON.stringify(log)}, JSON.stringify(variables) + "\\n");
    data = { issueCreate: { success: true, issue: { identifier: "AIO-1", title: "t", url: "u", branchName: "b" } } };
  } else {
    throw new Error("unexpected query: " + query);
  }
  return { ok: true, json: async () => ({ data }) };
};
`
  );
  const result = spawnSync(process.execPath, ["--import", preload, CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test-key", AIOS_LINEAR_TEAM_KEY: "AIO", ...extraEnv },
  });
  let mutations = [];
  try {
    mutations = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    mutations = [];
  }
  rmSync(dir, { recursive: true, force: true });
  return { ...result, mutations };
}

const P = (name) => ({
  id: "p-" + name,
  name,
  state: "backlog",
  url: "https://linear.app/x/" + name,
});

test("projects lists every project when given no filter", () => {
  const r = runCli(["projects"], [P("Ultraharden"), P("Demo Sandbox")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Ultraharden/);
  assert.match(r.stdout, /Demo Sandbox/);
});

test("projects filters by case-insensitive substring", () => {
  const r = runCli(["projects", "ultra"], [P("Ultraharden"), P("Demo Sandbox")]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Ultraharden/);
  assert.doesNotMatch(r.stdout, /Demo Sandbox/);
});

test("create-project creates a project scoped to the team", () => {
  const r = runCli(["create-project", "Ultraharden"], []);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /created project "Ultraharden"/);
  assert.deepEqual(r.mutations[0].input, { name: "Ultraharden", teamIds: ["team-1"] });
});

test("create-project refuses an existing exact name rather than creating a duplicate", () => {
  const r = runCli(["create-project", "Ultraharden"], [P("Ultraharden")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.equal(r.mutations.length, 0, "no projectCreate mutation may be sent");
});

test("create-project's duplicate guard is case-insensitive but not substring-greedy", () => {
  // "Ultraharden v2" must NOT block creating "Ultraharden" — only an exact name match does.
  const r = runCli(["create-project", "Ultraharden"], [P("Ultraharden v2")]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations.length, 1);
});

test("create --project resolves the project and sets it at creation", () => {
  const r = runCli(["create", "t", "--project", "Ultraharden"], [P("Ultraharden")]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].input.projectId, "p-Ultraharden");
});

test("create --project fails closed on an ambiguous match", () => {
  const r = runCli(["create", "t", "--project", "Ultra"], [P("Ultraharden"), P("Ultraviolet")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ambiguous/);
  assert.equal(r.mutations.length, 0, "no issue may be created against an unresolved project");
});

test("create --project fails closed when nothing matches", () => {
  const r = runCli(["create", "t", "--project", "Nope"], [P("Ultraharden")]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no project matching/);
  assert.equal(r.mutations.length, 0);
});

test("create --priority sets priority at creation", () => {
  const r = runCli(["create", "t", "--priority", "urgent"], []);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].input.priority, 1);
});

test("create rejects an unknown priority", () => {
  const r = runCli(["create", "t", "--priority", "spicy"], []);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /priority must be one of/);
});
