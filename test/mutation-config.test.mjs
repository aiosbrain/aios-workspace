import assert from "node:assert/strict";
import test from "node:test";
import { changedFiles, configFor, MUTATION_GROUPS, parseArgs } from "../scripts/run-mutation.mjs";

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

test("mutation CLI validates value-taking flags", () => {
  for (const flag of ["--base", "--group", "--mutate"]) {
    assert.throws(() => parseArgs([flag]), new RegExp(`${flag} requires a value`));
    assert.throws(() => parseArgs([`${flag}=`]), new RegExp(`${flag} requires a value`));
  }
  assert.deepEqual(
    {
      ...parseArgs(["--base", "upstream/main", "--group=client-auth-permissions", "--list"]),
      nightly: false,
    },
    {
      nightly: false,
      list: true,
      base: "upstream/main",
      group: "client-auth-permissions",
      mutate: null,
    }
  );
});

test("mutation changed-file discovery fails closed when git cannot resolve the base", () => {
  assert.throws(
    () =>
      changedFiles("origin/main", () => {
        throw new Error("missing ref");
      }),
    /cannot resolve mutation diff base.*fetch it/
  );
});
