import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  changedFiles,
  configFor,
  MUTATION_GROUPS,
  parseArgs,
  runAllCampaigns,
  toMutateTarget,
} from "../scripts/run-mutation.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRACKED = execFileSync("git", ["ls-files"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .trim()
  .split("\n")
  .filter(Boolean);
const TRACKED_SET = new Set(TRACKED);

/** Minimal glob support for the patterns MUTATION_GROUPS uses: **, *, {a,b}. */
function globToRegExp(pattern) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") {
          i += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "{") {
      const end = pattern.indexOf("}", i);
      assert.notEqual(end, -1, `unbalanced brace in glob: ${pattern}`);
      source += `(?:${pattern
        .slice(i + 1, end)
        .split(",")
        .join("|")})`;
      i = end;
    } else {
      source += char.replace(/[.+^$()|[\]\\?]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesTrackedFile(entry) {
  if (!/[*{]/.test(entry)) return TRACKED_SET.has(entry);
  const regexp = globToRegExp(entry);
  return TRACKED.some((file) => regexp.test(file));
}

test("every mutation group has a unique name and a nightly scope", () => {
  assert.equal(new Set(MUTATION_GROUPS.map((group) => group.name)).size, MUTATION_GROUPS.length);
  for (const group of MUTATION_GROUPS) assert.ok(group.nightly.length > 0, group.name);
});

test("every nightly entry matches at least one tracked file", () => {
  // A move/rename must fail here loudly instead of silently exempting a
  // subsystem from mutation (the scripts/sync-plan.mjs lesson: a stale entry
  // meant the changed-code lane matched nothing and nightly got a dead glob).
  for (const group of MUTATION_GROUPS) {
    for (const entry of group.nightly) {
      assert.ok(
        matchesTrackedFile(entry),
        `${group.name}: nightly entry "${entry}" matches no tracked file — update MUTATION_GROUPS (and its match regex) for the move/rename`
      );
    }
  }
});

test("every test entry matches at least one tracked file", () => {
  for (const group of MUTATION_GROUPS) {
    for (const entry of group.tests ?? []) {
      assert.ok(
        matchesTrackedFile(entry),
        `${group.name}: tests entry "${entry}" matches no tracked file — update MUTATION_GROUPS for the move/rename`
      );
    }
  }
});

test("every executableBits entry matches at least one tracked file", () => {
  // The chmod sandbox repair must chmod real files; a dead glob would make
  // /bin/sh pass the literal pattern to chmod, fail every run, and spuriously
  // "kill" every mutant.
  for (const group of MUTATION_GROUPS) {
    for (const entry of group.executableBits ?? []) {
      assert.ok(
        matchesTrackedFile(entry),
        `${group.name}: executableBits entry "${entry}" matches no tracked file`
      );
    }
  }
});

test("group match regexes agree with their nightly scope", () => {
  // Every concrete (non-glob) nightly file must be caught by the group's
  // changed-code regex, so a PR touching a nightly-covered file cannot skip
  // the changed-code mutation lane.
  for (const group of MUTATION_GROUPS) {
    for (const entry of group.nightly) {
      if (/[*{]/.test(entry)) continue;
      assert.ok(
        group.match.test(entry),
        `${group.name}: nightly file "${entry}" is not matched by the group's changed-code regex`
      );
    }
  }
});

test("the sync-plan safety gate lives in scripts/sync-plan.mjs and is mutation-covered", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.name === "access-governance");
  assert.ok(
    group.match.test("scripts/sync-plan.mjs"),
    "changed-code lane must cover scripts/sync-plan.mjs"
  );
  assert.ok(group.nightly.includes("scripts/sync-plan.mjs"));
  assert.ok(
    !group.nightly.includes("scripts/aios.mjs"),
    "the gate moved out of scripts/aios.mjs (AIO-540); mutating the whole CLI is the timeout the move fixed"
  );
  assert.ok(
    !group.match.test("scripts/aios.mjs"),
    "scripts/aios.mjs left the group entirely — the module boundary, not a list, scopes the campaign"
  );
  assert.ok(group.tests.includes("test/sync-plan.test.mjs"));
});

test("TypeScript groups mutate compiled dist output with no build step in the kill command", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.name === "inbox-authorization");
  assert.ok(group.mutateDist, "inbox-authorization must mutate compiled output");
  assert.equal(
    toMutateTarget(group, "src/operator-loop/inbox/capability.ts"),
    "dist/operator-loop/inbox/capability.js"
  );
  assert.equal(
    toMutateTarget(group, "src/operator-loop/inbox/**/*.ts"),
    "dist/operator-loop/inbox/**/*.js"
  );
  assert.equal(toMutateTarget(group, "scripts/inbox.mjs"), "scripts/inbox.mjs");
  const config = configFor(group, ["dist/operator-loop/inbox/capability.js"], false);
  // A compile-breaking mutant must not be scored as killed-by-tsc: the
  // command runner scores on exit code alone, so the per-mutant command must
  // contain no build step — only the sandbox exec-bit repair (chmod, which
  // always exits 0 on tracked files) and real test execution.
  assert.doesNotMatch(config.commandRunner.command, /build/);
  assert.match(
    config.commandRunner.command,
    /^(?:chmod \+x [^&]+ && )?node --test /,
    "kill command must be chmod-repair (optional) + test execution only"
  );
});

test("native Node mutation uses narrow command-runner tests", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.name === "update-safety");
  const config = configFor(group, ["scripts/update.mjs"], false);
  assert.equal(config.testRunner, "command");
  assert.match(config.commandRunner.command, /update-safety\.test\.mjs/);
  assert.doesNotMatch(config.commandRunner.command, /npm test(?:\s|$)/);
  assert.equal(config.thresholds.break, 0, "uncalibrated groups remain advisory");
});

test("the calibrated inbox capability target enforces its mutation floor in either lane", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.name === "inbox-authorization");
  const target = "dist/operator-loop/inbox/capability.js";
  assert.equal(group.breakThresholdByTarget[target], 90);
  for (const nightly of [false, true]) {
    assert.deepEqual(configFor(group, [target], nightly).thresholds, {
      high: 80,
      low: 60,
      break: 90,
    });
  }
});

test("uncalibrated inbox denominators remain advisory with valid reporting bands", () => {
  const group = MUTATION_GROUPS.find((entry) => entry.name === "inbox-authorization");
  for (const mutate of [
    ["dist/operator-loop/inbox/store.js"],
    ["dist/operator-loop/inbox/capability.js", "dist/operator-loop/inbox/store.js"],
  ]) {
    const { thresholds } = configFor(group, mutate, true);
    assert.deepEqual(thresholds, { high: 80, low: 60, break: 0 });
    assert.ok(thresholds.high >= thresholds.low);
  }
});

test("an explicit zero target threshold stays advisory without invalidating reporting bands", () => {
  const target = "scripts/example.mjs";
  const group = { name: "example", tests: [], breakThresholdByTarget: { [target]: 0 } };
  assert.deepEqual(configFor(group, [target], false).thresholds, {
    high: 80,
    low: 60,
    break: 0,
  });
});

test("every whole-group and single-target configuration has valid reporting bands", () => {
  for (const group of MUTATION_GROUPS) {
    const targets = group.nightly.map((entry) => toMutateTarget(group, entry));
    for (const mutate of [targets, ...targets.map((target) => [target])]) {
      const { thresholds } = configFor(group, mutate, true);
      assert.ok(
        thresholds.high >= thresholds.low,
        `${group.name} has high ${thresholds.high} below low ${thresholds.low}`
      );
    }
  }
});

test("a failed campaign does not prevent later mutation groups from running", () => {
  const selected = ["first", "threshold-miss", "last"].map((name) => ({
    group: { name },
    mutate: [`${name}.mjs`],
  }));
  const visited = [];
  assert.throws(
    () =>
      runAllCampaigns(selected, ({ group }) => {
        visited.push(group.name);
        if (group.name === "threshold-miss") throw new Error("Stryker exited 1");
      }),
    /mutation campaigns failed: threshold-miss/
  );
  assert.deepEqual(visited, ["first", "threshold-miss", "last"]);
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
