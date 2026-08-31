// test/linear-list-filter.test.mjs — list-side label/state filtering (AIO-999)

import { test } from "node:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import {
  filterIssues,
  hasListFilters,
  parseListArgs,
} from "../scaffold/.claude/skills/aios-linear/linear-core.mjs";
import { parseCreateArgs } from "../scaffold/.claude/skills/aios-linear/linear-create.mjs";
import { formatListRow } from "../scaffold/.claude/skills/aios-linear/linear-list.mjs";

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

// ── review hardening (PR #635): parse traps must fail loudly, not return zero rows ──

const CLI = path.resolve(import.meta.dirname, "../scaffold/.claude/skills/aios-linear/linear.mjs");

function runList(args) {
  return spawnSync(process.execPath, [CLI, "list", "AIO", ...args], {
    encoding: "utf8",
    env: { ...process.env, LINEAR_API_KEY: "test-key-never-used" },
  });
}

test("list --label followed by another flag fails instead of eating it", () => {
  const result = runList(["--label", "--open"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--label requires a value/);
});

test("list --missing-label followed by another flag fails", () => {
  const result = runList(["--missing-label", "--open"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--missing-label requires a value/);
});

test("list --label with an all-comma group fails instead of matching nothing", () => {
  const result = runList(["--label", ","]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /contains no label names/);
});

test("list --label with a prefix-shaped value points at --missing-label", () => {
  const result = runList(["--label", "sev:"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /did you mean --missing-label sev:/);
});

test("formatListRow keeps ident/state/title stable and appends labels as a trailing column", () => {
  const row = {
    identifier: "AIO-7",
    title: "A title",
    state: { name: "Backlog", type: "backlog" },
    labels: { nodes: [{ name: "finding" }, { name: "sev:high" }] },
  };
  assert.equal(formatListRow(row, false), "AIO-7\t[Backlog]\tA title");
  assert.equal(formatListRow(row, true), "AIO-7\t[Backlog]\tA title\t{finding,sev:high}");
  assert.equal(
    formatListRow({ identifier: "AIO-8", title: "t", state: { name: "Todo" } }, true),
    "AIO-8\t[Todo]\tt\t{}"
  );
});

test("parseCreateArgs does not expand replacement patterns in the title", () => {
  const { description } = parseCreateArgs(["Costs $$ and $& breaks", "--template", "finding"]);
  assert.match(description, /^# Costs \$\$ and \$& breaks$/m);
});
