// test/linear-list-filter.test.mjs — list-side label/state filtering (AIO-999)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterIssues,
  hasListFilters,
  parseCreateArgs,
  parseListArgs,
} from "../scaffold/.claude/skills/aios-linear/linear-core.mjs";

const issue = (identifier, stateType, labels) => ({
  identifier,
  title: identifier,
  state: { name: stateType, type: stateType },
  labels: { nodes: labels.map((name) => ({ name })) },
});

const PILE = [
  issue("AIO-1", "started", ["finding", "repo:workspace", "det:deterministic", "fence:none"]),
  issue("AIO-2", "backlog", ["finding", "repo:devtools", "det:deterministic", "fence:none"]),
  issue("AIO-3", "backlog", ["finding", "repo:team-brain", "det:deterministic", "fence:none"]),
  issue("AIO-4", "completed", ["finding", "repo:workspace", "det:deterministic", "fence:none"]),
  issue("AIO-5", "backlog", ["finding"]),
  issue("AIO-6", "backlog", []),
];

test("parseListArgs reads --open, repeatable --label (comma = OR) and --missing-label", () => {
  const { teamKey, filters } = parseListArgs([
    "AIO",
    "--open",
    "--label",
    "finding",
    "--label",
    "repo:workspace,repo:devtools",
    "--missing-label",
    "sev:",
  ]);
  assert.equal(teamKey, "AIO");
  assert.equal(filters.open, true);
  assert.deepEqual(filters.labels, [["finding"], ["repo:workspace", "repo:devtools"]]);
  assert.deepEqual(filters.missingLabels, ["sev:"]);
  assert.equal(hasListFilters(filters), true);
});

test("parseListArgs with no flags leaves filtering off", () => {
  const { filters } = parseListArgs(["AIO"]);
  assert.equal(hasListFilters(filters), false);
  assert.deepEqual(filterIssues(PILE, filters), PILE);
});

test("filterIssues ANDs repeated --label and ORs within a comma group", () => {
  const { filters } = parseListArgs([
    "AIO",
    "--open",
    "--label",
    "finding",
    "--label",
    "det:deterministic",
    "--label",
    "fence:none",
    "--label",
    "repo:workspace,repo:devtools",
  ]);
  assert.deepEqual(
    filterIssues(PILE, filters).map((n) => n.identifier),
    ["AIO-1", "AIO-2"]
  );
});

test("filterIssues --open drops completed/canceled states", () => {
  const { filters } = parseListArgs(["AIO", "--open", "--label", "repo:workspace"]);
  assert.deepEqual(
    filterIssues(PILE, filters).map((n) => n.identifier),
    ["AIO-1"]
  );
});

test("filterIssues --missing-label keeps issues lacking any listed prefix", () => {
  const { filters } = parseListArgs([
    "AIO",
    "--open",
    "--label",
    "finding",
    "--missing-label",
    "repo:",
    "--missing-label",
    "det:",
  ]);
  assert.deepEqual(
    filterIssues(PILE, filters).map((n) => n.identifier),
    ["AIO-5"]
  );
});

test("filterIssues matches labels case-insensitively and tolerates missing label nodes", () => {
  const bare = [{ identifier: "AIO-9", title: "t", state: { name: "Backlog", type: "backlog" } }];
  const { filters } = parseListArgs(["AIO", "--label", "FINDING"]);
  assert.deepEqual(
    filterIssues(PILE, filters).map((n) => n.identifier),
    ["AIO-1", "AIO-2", "AIO-3", "AIO-4", "AIO-5"]
  );
  assert.deepEqual(filterIssues(bare, filters), []);
});

test("parseCreateArgs stamps the title into the finding template heading", () => {
  const { description } = parseCreateArgs(["My finding", "--template", "finding"]);
  assert.match(description, /^# My finding$/m);
  assert.doesNotMatch(description, /^# TITLE — /m);
  assert.match(description, /## Classification/);
});

test("parseCreateArgs still stamps the aios template heading", () => {
  const { description } = parseCreateArgs(["My slice", "--template", "aios"]);
  assert.match(description, /^# My slice$/m);
  assert.doesNotMatch(description, /^# TITLE — /m);
});
