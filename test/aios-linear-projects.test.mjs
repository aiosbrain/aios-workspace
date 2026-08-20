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
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
// The primary copy is exercised directly; the scaffold copy is proven byte-identical to it
// by the parity test in linear-dotenvx-scope.test.mjs, so it is covered transitively.
const CLI = path.join(ROOT, ".claude/skills/aios-linear/linear.mjs");

// `existing` is the project list the mocked Linear returns for any ProjectFilter query.
//
// The mock VALIDATES before it fabricates. A real GraphQL server rejects an unknown field
// or an undeclared variable at validation time; a substring-matching mock does not, which
// lets a broken production query pass a green test. So this mock checks the selection set
// and the variable definitions against the real Project/connection surface and throws on
// anything it does not recognise — the same way the server would.
const PROJECT_FIELDS = new Set(["id", "name", "state", "url"]);
const PAGE_INFO_FIELDS = new Set(["hasNextPage", "endCursor"]);

function validateProjectsQuery(query) {
  const declared = [...query.matchAll(/\$(\w+)\s*:/g)].map((m) => m[1]);
  for (const v of declared) {
    if (!["f", "after"].includes(v)) throw new Error("undeclared variable: $" + v);
  }
  const nodes = /nodes\s*\{([^}]*)\}/.exec(query);
  if (!nodes) throw new Error("projects query selects no nodes");
  for (const field of nodes[1].trim().split(/\s+/).filter(Boolean)) {
    if (!PROJECT_FIELDS.has(field)) {
      throw new Error(`Cannot query field "${field}" on type "Project"`);
    }
  }
  const pi = /pageInfo\s*\{([^}]*)\}/.exec(query);
  if (!pi) throw new Error("projects query selects no pageInfo — it cannot paginate");
  for (const field of pi[1].trim().split(/\s+/).filter(Boolean)) {
    if (!PAGE_INFO_FIELDS.has(field)) {
      throw new Error(`Cannot query field "${field}" on type "PageInfo"`);
    }
  }
  if (!/projects\([^)]*after:\s*\$after/.test(query)) {
    throw new Error("projects query does not pass $after — it cannot paginate");
  }
}

// `pages` is an array of arrays: one entry per Relay page the server will hand back.
function runCli(args, pages = [[]], extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-linear-projects-"));
  const preload = path.join(dir, "mock-fetch.mjs");
  const log = path.join(dir, "mutations.log");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const pages = ${JSON.stringify("__PAGES__")};
const PROJECT_FIELDS = new Set(${JSON.stringify([...PROJECT_FIELDS])});
const PAGE_INFO_FIELDS = new Set(${JSON.stringify([...PAGE_INFO_FIELDS])});
const validate = ${validateProjectsQuery.toString()};
globalThis.fetch = async (_url, init) => {
  const { query, variables } = JSON.parse(init.body);
  let data;
  if (query.includes("projects(")) {
    validate(query);
    const all = JSON.parse(pages);
    const index = variables.after ? Number(variables.after.replace("cursor-", "")) : 0;
    const needle = (variables.f?.name?.containsIgnoreCase ?? "").toLowerCase();
    const nodes = (all[index] ?? []).filter((p) => p.name.toLowerCase().includes(needle));
    const cycle = process.env.MOCK_CYCLE === "1";
    const hasNextPage = index + 1 < all.length || cycle;
    const endCursor = !hasNextPage ? null : index + 1 < all.length ? "cursor-" + (index + 1) : "cursor-0";
    data = { projects: { nodes, pageInfo: { hasNextPage, endCursor } } };
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
`.replace('"__PAGES__"', JSON.stringify(JSON.stringify(pages)))
  );
  const result = spawnSync(process.execPath, ["--import", preload, CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test-key", AIOS_LINEAR_TEAM_KEY: "AIO", ...extraEnv },
    // Bounds a pagination regression (e.g. an uncaught cursor cycle) to a test failure
    // instead of a hung suite.
    timeout: 15_000,
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
  url: "https://linear.app/x/" + encodeURIComponent(name),
});

test("projects lists every project when given no filter", () => {
  const r = runCli(["projects"], [[P("Ultraharden"), P("Demo Sandbox")]]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ultraharden/);
  assert.match(r.stdout, /Demo Sandbox/);
});

test("projects filters by case-insensitive substring", () => {
  const r = runCli(["projects", "ultra"], [[P("Ultraharden"), P("Demo Sandbox")]]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ultraharden/);
  assert.doesNotMatch(r.stdout, /Demo Sandbox/);
});

test("projects follows the cursor and lists projects from every page", () => {
  const r = runCli(["projects"], [[P("Page One")], [P("Page Two")], [P("Page Three")]]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Page One/);
  assert.match(r.stdout, /Page Two/);
  assert.match(r.stdout, /Page Three/, "a project on the last page must still be listed");
});

test("create-project creates a project scoped to the team", () => {
  const r = runCli(["create-project", "Ultraharden"], [[]]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /created project "Ultraharden"/);
  assert.deepEqual(r.mutations[0].input, { name: "Ultraharden", teamIds: ["team-1"] });
});

test("create-project refuses an existing exact name rather than creating a duplicate", () => {
  const r = runCli(["create-project", "Ultraharden"], [[P("Ultraharden")]]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
  assert.equal(r.mutations.length, 0, "no projectCreate mutation may be sent");
});

// The defect Sol reproduced: the existing project sat on page two, so the first-page-only
// guard created a duplicate.
test("create-project's guard sees an existing project on a later page", () => {
  const r = runCli(["create-project", "Ultraharden"], [[P("Something Else")], [P("Ultraharden")]]);
  assert.equal(r.status, 1, "a page-two duplicate must still block");
  assert.match(r.stderr, /already exists/);
  assert.equal(r.mutations.length, 0);
});

test("create-project's guard is not substring-greedy", () => {
  // "Ultraharden v2" is a legitimately distinct name and must remain creatable.
  const r = runCli(["create-project", "Ultraharden"], [[P("Ultraharden v2")]]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations.length, 1);
});

// Each candidate canonicalizes to the same name as the existing project beside it, so each
// must be refused. Every one of these slipped past the raw toLowerCase() comparator.
for (const [label, existing, candidate] of [
  ["a trailing space", "Ultraharden", "Ultraharden "],
  ["a leading space", "Ultraharden", " Ultraharden"],
  ["case only", "Ultraharden", "ULTRAHARDEN"],
  ["a non-breaking space", "Ultra harden", "Ultra\u00a0harden"],
  ["a doubled inner space", "Ultra harden", "Ultra  harden"],
  ["a newline for a space", "Ultra harden", "Ultra\nharden"],
]) {
  test(`create-project refuses a duplicate differing only by ${label}`, () => {
    const r = runCli(["create-project", candidate], [[P(existing)]]);
    assert.equal(r.status, 1, `${label} must be treated as a duplicate (stderr: ${r.stderr})`);
    assert.equal(r.mutations.length, 0);
  });
}

test("create-project refuses an NFD form of an existing NFC name", () => {
  // "Café" composed vs decomposed — visually identical, different UTF-16.
  const r = runCli(["create-project", "Cafe\u0301 Project"], [[P("Caf\u00e9 Project")]]);
  assert.equal(r.status, 1, "an NFD/NFC pair must be treated as one name");
  assert.equal(r.mutations.length, 0);
});

test("create-project rejects a whitespace-only name instead of creating it", () => {
  const r = runCli(["create-project", "   "], [[]]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non-whitespace/);
  assert.equal(r.mutations.length, 0);
});

test("create --project resolves the project and sets it at creation", () => {
  const r = runCli(["create", "t", "--project", "Ultraharden"], [[P("Ultraharden")]]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].input.projectId, "p-Ultraharden");
});

test("create --project fails closed on an ambiguous match", () => {
  const r = runCli(["create", "t", "--project", "Ultra"], [[P("Ultraharden"), P("Ultraviolet")]]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ambiguous/);
  assert.equal(r.mutations.length, 0, "no issue may be created against an unresolved project");
});

// Ambiguity split across pages: page one looks unique, so the first-page-only resolver
// silently mutated against the wrong project.
test("create --project detects ambiguity split across pages", () => {
  const r = runCli(["create", "t", "--project", "Ultra"], [[P("Ultraharden")], [P("Ultraviolet")]]);
  assert.equal(r.status, 1, "a second match on page two must make this ambiguous");
  assert.match(r.stderr, /ambiguous/);
  assert.equal(r.mutations.length, 0);
});

// Resolution is canonical, not a raw server-side containsIgnoreCase: two canonical-equal
// projects (NBSP vs space) must trip the ambiguity guard rather than each hiding the other
// from the server filter and filing silently into whichever one the server happens to match.
test("create --project fails closed on two canonical-equal projects", () => {
  const r = runCli(
    ["create", "t", "--project", "Ultra harden"],
    [[P("Ultra harden"), P("Ultra\u00a0harden")]]
  );
  assert.equal(r.status, 1, "canonical-equal duplicates must be ambiguous, not a silent pick");
  assert.match(r.stderr, /ambiguous/);
  assert.equal(r.mutations.length, 0);
});

test("create --project resolves an NBSP-typed name to the space-typed project", () => {
  const r = runCli(["create", "t", "--project", "Ultra\u00a0harden"], [[P("Ultra harden")]]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].input.projectId, "p-Ultra harden");
});

// An exact canonical match must win over substring expansion: "Ultraharden" beside
// "Ultraharden v2" is a precise reference, not an ambiguous one.
test("create --project prefers an exact canonical match over substring matches", () => {
  const r = runCli(
    ["create", "t", "--project", "Ultraharden"],
    [[P("Ultraharden"), P("Ultraharden v2")]]
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].input.projectId, "p-Ultraharden");
});

// A→B→A cursor cycle: a guard that only remembers the previous cursor loops forever here;
// the seen-cursor set must fail closed instead (bounded by runCli's spawnSync timeout).
test("projects fails closed on a cursor cycle instead of looping", () => {
  const r = runCli(["projects"], [[P("One")], [P("Two")]], { MOCK_CYCLE: "1" });
  assert.equal(r.status, 1, "a cursor cycle must abort, not loop or succeed");
  assert.match(r.stderr, /pagination stalled/);
});

test("create --project fails closed when nothing matches", () => {
  const r = runCli(["create", "t", "--project", "Nope"], [[P("Ultraharden")]]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no project matching/);
  assert.equal(r.mutations.length, 0);
});

test("create --priority sets priority at creation", () => {
  const r = runCli(["create", "t", "--priority", "urgent"], [[]]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.mutations[0].input.priority, 1);
});

test("create rejects an unknown priority", () => {
  const r = runCli(["create", "t", "--priority", "spicy"], [[]]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /priority must be one of/);
});

// Canonicalization must not depend on the host locale. toLocaleLowerCase() under a Turkish
// locale maps "I" → "ı" (dotless), so the same duplicate guard would pass on one machine and
// fail on another. Run the canonicalizer in a subprocess pinned to tr_TR and assert the exact
// locale-independent output — this test fails if toLowerCase() ever regresses to
// toLocaleLowerCase().
test("canonicalization is locale-independent (Turkish dotless-I safe)", () => {
  const core = pathToFileURL(path.join(CLI, "../linear-core.mjs")).href;
  const script = [
    `import { canonicalizeProjectName as canon } from ${JSON.stringify(core)};`,
    `console.log(JSON.stringify([canon("AIOS Infra"), canon("aios infra"), canon("\\u0130stanbul")]));`,
  ].join("\n");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "tr_TR.UTF-8", LANG: "tr_TR.UTF-8" },
  });
  assert.equal(r.status, 0, r.stderr);
  const [upper, lower, dottedCapI] = JSON.parse(r.stdout.trim());
  assert.equal(upper, "aios infra", 'under a Turkish locale, "I" must still lower to "i", not "ı"');
  assert.equal(upper, lower, "case variants must canonicalize identically on every locale");
  // U+0130 (İ) lowers to "i" + U+0307 combining dot above under the locale-independent
  // Unicode default mapping; the Turkish-locale mapping would produce a bare "i".
  assert.equal(dottedCapI, "i\u0307stanbul", "U+0130 must follow the default Unicode mapping");
});

// Guards the mock itself: Sol proved the old one fabricated success for a query requesting
// a field that does not exist. If this test ever fails, the mock has stopped validating and
// every other test in this file has become unfalsifiable.
test("the mock rejects a projects query selecting a nonexistent field", () => {
  const bad = `query($f:ProjectFilter,$after:String){ projects(first:100, filter:$f, after:$after){ nodes{ id definitelyNotARealProjectField } pageInfo{ hasNextPage endCursor } } }`;
  assert.throws(() => validateProjectsQuery(bad), /Cannot query field/);
});

test("the mock rejects a projects query that cannot paginate", () => {
  const noPageInfo = `query($f:ProjectFilter,$after:String){ projects(first:100, filter:$f, after:$after){ nodes{ id name state url } } }`;
  assert.throws(() => validateProjectsQuery(noPageInfo), /no pageInfo/);
  const noAfter = `query($f:ProjectFilter,$after:String){ projects(first:100, filter:$f){ nodes{ id name state url } pageInfo{ hasNextPage endCursor } } }`;
  assert.throws(() => validateProjectsQuery(noAfter), /does not pass \$after/);
});
