import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

function entryMatches(entry, file) {
  return /[*{]/.test(entry) ? globToRegExp(entry).test(file) : entry === file;
}

test("every tracked file matching a group's regex is explicitly in or out of nightly scope", () => {
  // The anti-silent-scope-extension contract (AIO-539): narrowing a group's
  // nightly denominator is only honest if every dropped file is recorded. A
  // new file in a critical directory must fail here until someone states
  // which side of the line it is on.
  for (const group of MUTATION_GROUPS) {
    assert.ok(
      Array.isArray(group.nightlyExcludes),
      `${group.name}: nightlyExcludes must be declared (empty array when nothing is dropped)`
    );
    for (const file of TRACKED) {
      if (!group.match.test(file)) continue;
      assert.ok(
        group.nightly.some((entry) => entryMatches(entry, file)) ||
          group.nightlyExcludes.includes(file),
        `${group.name}: "${file}" matches the group's regex but appears in neither nightly nor nightlyExcludes — declare it in scope or record why it is out`
      );
    }
  }
});

test("nightlyExcludes entries are tracked, regex-matched, and disjoint from nightly", () => {
  for (const group of MUTATION_GROUPS) {
    for (const entry of group.nightlyExcludes ?? []) {
      assert.ok(
        TRACKED_SET.has(entry),
        `${group.name}: nightlyExcludes entry "${entry}" matches no tracked file — dead entry`
      );
      assert.ok(
        group.match.test(entry),
        `${group.name}: nightlyExcludes entry "${entry}" is not matched by the group's regex — it was never in scope`
      );
      assert.ok(
        !group.nightly.some((nightlyEntry) => entryMatches(nightlyEntry, entry)),
        `${group.name}: "${entry}" is covered by nightly and listed in nightlyExcludes — pick one`
      );
    }
  }
});

test("nightlyTests are tracked subsets of the group's umbrella tests", () => {
  for (const group of MUTATION_GROUPS) {
    assert.notEqual(
      group.nightlyTests?.length,
      0,
      `${group.name}: nightlyTests must not be an empty array — omit the field to keep the umbrella tests (an empty node --test arg list runs full default discovery per mutant)`
    );
    for (const entry of group.nightlyTests ?? []) {
      assert.ok(
        matchesTrackedFile(entry),
        `${group.name}: nightlyTests entry "${entry}" matches no tracked file`
      );
      assert.ok(
        (group.tests ?? []).some((testEntry) => entryMatches(testEntry, entry)),
        `${group.name}: nightlyTests entry "${entry}" is not covered by the group's umbrella tests — the nightly oracle cannot drift from the reviewed test set`
      );
    }
  }
});

test("nightly kill commands use the unit's own tests; the changed-code lane keeps the umbrella", () => {
  // With coverageAnalysis "off" every mutant re-runs the whole command, so the
  // nightly per-mutant cost is the kill command's runtime — the umbrella
  // operator-loop suite (73 files) costs hours/night, the unit oracle minutes.
  const inbox = MUTATION_GROUPS.find((entry) => entry.name === "inbox-authorization");
  const nightlyCommand = configFor(inbox, ["dist/operator-loop/inbox/capability.js"], true)
    .commandRunner.command;
  const changedCommand = configFor(inbox, ["dist/operator-loop/inbox/capability.js"], false)
    .commandRunner.command;
  assert.match(nightlyCommand, /test\/operator-loop\/inbox-capability\.test\.mjs/);
  assert.doesNotMatch(nightlyCommand, /test\/operator-loop\/\*\.test\.mjs/);
  assert.match(changedCommand, /test\/operator-loop\/\*\.test\.mjs/);

  const updateSafety = MUTATION_GROUPS.find((entry) => entry.name === "update-safety");
  const updateNightly = configFor(updateSafety, ["scripts/toolkit-merge.mjs"], true).commandRunner
    .command;
  assert.match(updateNightly, /test\/toolkit-merge\.test\.mjs/);
  assert.doesNotMatch(updateNightly, /toolkit-update\.test\.mjs/);
  // A group without nightlyTests keeps its umbrella tests in both lanes.
  const bugbot = MUTATION_GROUPS.find((entry) => entry.name === "bugbot-security");
  for (const nightly of [false, true]) {
    assert.match(
      configFor(bugbot, ["hooks/local-bugbot-gate.mjs"], nightly).commandRunner.command,
      /test\/local-bugbot-gate\.test\.mjs test\/review-bugbot\.test\.mjs/
    );
  }
});

test("the nightly workflow matrix lists exactly the mutation groups", () => {
  // The matrix in mutation.yml is a hand-written list; a group added or
  // renamed in MUTATION_GROUPS without a matching leg would silently never
  // run nightly (or a ghost leg would fail on --group validation).
  const workflow = readFileSync(path.join(ROOT, ".github", "workflows", "mutation.yml"), "utf8");
  const matrixBlock = /matrix:\s*\n(?:\s*#[^\n]*\n)*\s*group:\s*\n((?:\s*-\s*\S+\n)+)/.exec(
    workflow
  );
  assert.ok(matrixBlock, "mutation.yml must declare a matrix group list");
  const legs = matrixBlock[1]
    .trim()
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim());
  assert.deepEqual(
    legs,
    MUTATION_GROUPS.map((group) => group.name),
    "mutation.yml matrix legs must match MUTATION_GROUPS exactly (same names, same order)"
  );
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

test("command-runner groups never use incremental mode", () => {
  // The command runner reports no per-test information, so Stryker cannot see
  // test changes and incremental mode reuses stale verdicts — measured on the
  // AIO-539 calibration: a strengthened oracle could not flip cached Survived
  // results until incremental was disabled. Only the Vitest (perTest) client
  // group may keep incremental state.
  for (const group of MUTATION_GROUPS) {
    if (group.client) continue;
    const config = configFor(group, [toMutateTarget(group, group.nightly[0])], true);
    assert.equal(
      config.incremental,
      false,
      `${group.name}: incremental must stay off for command-runner groups (stale-verdict hazard)`
    );
  }
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
