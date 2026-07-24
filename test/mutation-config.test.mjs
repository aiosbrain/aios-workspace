import assert from "node:assert/strict";
import test from "node:test";
import { configFor, MUTATION_GROUPS } from "../scripts/run-mutation.mjs";

test("every mutation group has a unique name and a nightly scope", () => {
  assert.equal(new Set(MUTATION_GROUPS.map((group) => group.name)).size, MUTATION_GROUPS.length);
  for (const group of MUTATION_GROUPS) assert.ok(group.nightly.length > 0, group.name);
});

test("native Node mutation uses narrow command-runner tests", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.name === "update-safety");
  const config = configFor(group, ["scripts/update.mjs"], false);
  assert.equal(config.testRunner, "command");
  assert.match(config.commandRunner.command, /update-safety\.test\.mjs/);
  assert.doesNotMatch(config.commandRunner.command, /npm test(?:\s|$)/);
  assert.equal(config.thresholds.break, 0, "calibration must remain advisory");
});

test("GUI mutation uses Vitest per-test coverage", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.client);
  const config = configFor(group, ["gui/client/src/lib/token.ts"], true);
  assert.equal(config.testRunner, "vitest");
  assert.equal(config.coverageAnalysis, "perTest");
  assert.equal(config.incremental, true);
});
