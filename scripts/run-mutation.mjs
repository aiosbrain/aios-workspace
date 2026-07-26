#!/usr/bin/env node
/**
 * Changed-code and nightly mutation orchestration.
 *
 * Stryker's command runner cannot map native node:test cases to mutants, so
 * critical production files are paired with narrow, explicit test groups. The
 * GUI client uses Stryker's Vitest runner and per-test coverage analysis.
 *
 * TypeScript groups (`mutateDist: true`) are mutated in their compiled `dist/`
 * output, never in `src/`. The command runner scores purely on exit code, so a
 * mutant that merely breaks `tsc` would otherwise be recorded as "killed" by
 * the compiler and structurally inflate the score. dist is built once,
 * unmutated, before the campaign; the per-mutant kill command runs only tests.
 * Group `match`/`nightly` stay in tracked source terms (so existence checks in
 * test/mutation-config.test.mjs work); `toMutateTarget` maps them to dist.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MUTATION_GROUPS = [
  {
    name: "access-governance",
    // The sync-plan safety gate (buildPlan: admin never syncs, default-deny on
    // missing `access:`) lives in scripts/aios.mjs — there is no sync-plan.mjs.
    match: /^(hooks\/file-governance-guard|scripts\/aios|scripts\/brain-client)\.mjs$/,
    nightly: ["hooks/file-governance-guard.mjs", "scripts/aios.mjs", "scripts/brain-client.mjs"],
    tests: [
      "test/file-governance-guard.test.mjs",
      "test/sync-plan.test.mjs",
      "test/brain-client-auth.test.mjs",
      "test/decision-row-redaction.test.mjs",
    ],
  },
  {
    name: "bugbot-security",
    match: /^(hooks\/local-bugbot-gate|scripts\/review-bugbot)\.mjs$/,
    nightly: ["hooks/local-bugbot-gate.mjs", "scripts/review-bugbot.mjs"],
    tests: ["test/local-bugbot-gate.test.mjs", "test/review-bugbot.test.mjs"],
  },
  {
    name: "update-safety",
    match: /^scripts\/(?:update|toolkit-(?:merge|pull|manifest|meta))\.mjs$/,
    nightly: [
      "scripts/update.mjs",
      "scripts/toolkit-merge.mjs",
      "scripts/toolkit-pull.mjs",
      "scripts/toolkit-manifest.mjs",
      "scripts/toolkit-meta.mjs",
    ],
    tests: [
      "test/toolkit-update.test.mjs",
      "test/toolkit-merge.test.mjs",
      "test/toolkit-pull.test.mjs",
      "test/toolkit-manifest-parity.test.mjs",
      "test/toolkit-meta.test.mjs",
      "test/update-safety.test.mjs",
      "test/update-review-repros.test.mjs",
    ],
  },
  {
    name: "inbox-authorization",
    match: /^(?:scripts\/inbox\.mjs|src\/operator-loop\/inbox\/.+\.ts)$/,
    nightly: ["scripts/inbox.mjs", "src/operator-loop/inbox/**/*.ts"],
    tests: ["test/operator-loop/*.test.mjs"],
    // This floor is calibrated for the exact compiled target only. Do not
    // project a single-file score onto the much larger mutation group.
    breakThresholdByTarget: { "dist/operator-loop/inbox/capability.js": 90 },
    mutateDist: true,
    // Stryker's sandbox copy drops POSIX execute bits, and the hook tests in
    // this scope assert them (statSync(HOOK).mode & 0o111). Restore the bits
    // before the tests run; chmod on tracked files always exits 0, so it can
    // never kill a mutant — scoring stays purely test-driven.
    executableBits: ["hooks/*.mjs"],
  },
  {
    name: "runtime-capabilities",
    match: /^gui\/server\/runtime-adapters\/(?:capability-store|guard|index)\.mjs$/,
    nightly: [
      "gui/server/runtime-adapters/capability-store.mjs",
      "gui/server/runtime-adapters/guard.mjs",
      "gui/server/runtime-adapters/index.mjs",
    ],
    tests: [
      "gui/server/runtime-adapters/*.test.mjs",
      "gui/server/approval-mode-governance.test.mjs",
    ],
  },
  {
    name: "client-auth-permissions",
    client: true,
    match:
      /^gui\/client\/src\/(?:lib\/(?:api|token)|components\/(?:chat|integrations)\/.+)\.(?:ts|tsx)$/,
    nightly: [
      "gui/client/src/lib/api.ts",
      "gui/client/src/lib/token.ts",
      "gui/client/src/components/chat/**/*.{ts,tsx}",
      "gui/client/src/components/integrations/**/*.{ts,tsx}",
    ],
  },
];

function git(args) {
  // 64 MiB: execFileSync's default 1 MiB maxBuffer makes a large diff crash
  // the changed-code lane with ENOBUFS (same pattern as check-coverage.mjs).
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Map a source path (or glob) to the file Stryker should actually mutate.
 * For `mutateDist` groups, TypeScript under src/ maps to its compiled dist/
 * JavaScript so only real test execution — never a tsc failure — kills mutants.
 */
export function toMutateTarget(group, file) {
  if (!group.mutateDist) return file;
  return file.replace(/^src\//, "dist/").replace(/\.tsx?$/, ".js");
}

export function changedFiles(base, gitCommand = git) {
  let diffBase;
  try {
    diffBase = gitCommand(["merge-base", base, "HEAD"]).trim();
  } catch (error) {
    throw new Error(
      `cannot resolve mutation diff base ${JSON.stringify(base)}; fetch it or pass --base <ref>`,
      { cause: error }
    );
  }
  if (!diffBase) throw new Error(`git returned an empty merge base for ${JSON.stringify(base)}`);

  let changed;
  let untracked;
  try {
    changed = gitCommand(["diff", "--name-only", "--diff-filter=ACMR", diffBase, "--"])
      .trim()
      .split("\n")
      .filter(Boolean);
    untracked = gitCommand(["ls-files", "--others", "--exclude-standard"])
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch (error) {
    throw new Error(`cannot enumerate files for mutation analysis: ${error.message}`, {
      cause: error,
    });
  }
  return [...new Set([...changed, ...untracked])];
}

function nodeCommand(group) {
  // No build step here: compiled-output groups build dist once (unmutated)
  // before the campaign, so the per-mutant command is pure test execution and
  // a compile-breaking mutant cannot be scored as "killed" by the compiler.
  // `chmod +x` only repairs execute bits Stryker's sandbox copy drops; it
  // always succeeds on tracked files and cannot kill a mutant.
  const chmod = group.executableBits ? `chmod +x ${group.executableBits.join(" ")} && ` : "";
  return `${chmod}node --test --test-concurrency=2 ${group.tests.join(" ")}`;
}

export function configFor(group, mutate, nightly) {
  // A threshold calibrated on one file is valid only when that file is the
  // complete campaign denominator. Mixed and whole-group campaigns remain
  // advisory until their own scores have been observed.
  const breakThreshold = mutate.length === 1 ? (group.breakThresholdByTarget?.[mutate[0]] ?? 0) : 0;
  const common = {
    $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    mutate,
    concurrency: 2,
    timeoutMS: 60_000,
    reporters: ["clear-text", "progress", "json"],
    jsonReporter: { fileName: `reports/mutation/${group.name}.json` },
    thresholds: { high: 80, low: 60, break: breakThreshold },
    incremental: nightly,
    incrementalFile: `.stryker-tmp/${group.name}.json`,
  };
  if (group.client) {
    return {
      ...common,
      testRunner: "vitest",
      coverageAnalysis: "perTest",
      vitest: { configFile: "gui/client/vite.config.ts" },
    };
  }
  return {
    ...common,
    testRunner: "command",
    coverageAnalysis: "off",
    commandRunner: { command: nodeCommand(group) },
  };
}

export function runAllCampaigns(selected, runCampaign) {
  const failures = [];
  for (const entry of selected) {
    try {
      runCampaign(entry);
    } catch (error) {
      failures.push({ group: entry.group.name, error });
    }
  }
  if (failures.length) {
    const summary = failures
      .map(
        ({ group, error }) => `${group} (${error instanceof Error ? error.message : String(error)})`
      )
      .join("; ");
    throw new AggregateError(
      failures.map(
        ({ group, error }) =>
          new Error(`${group}: ${error instanceof Error ? error.message : String(error)}`, {
            cause: error,
          })
      ),
      `mutation campaigns failed: ${summary}`
    );
  }
}

function requiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function inlineValue(arg, flag) {
  const value = arg.slice(`${flag}=`.length);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseArgs(argv) {
  const options = {
    nightly: false,
    list: process.env.AIOS_MUTATION_DRY_RUN === "1",
    base: process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/main",
    group: null,
    mutate: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--nightly") options.nightly = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--base") options.base = requiredValue(argv, i++, "--base");
    else if (arg.startsWith("--base=")) options.base = inlineValue(arg, "--base");
    else if (arg === "--group") options.group = requiredValue(argv, i++, "--group");
    else if (arg.startsWith("--group=")) options.group = inlineValue(arg, "--group");
    else if (arg === "--mutate") options.mutate = requiredValue(argv, i++, "--mutate");
    else if (arg.startsWith("--mutate=")) options.mutate = inlineValue(arg, "--mutate");
    else throw new Error(`unknown mutation option: ${arg}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.mutate && !options.group) {
    throw new Error("--mutate requires --group so a file cannot run against unrelated tests");
  }
  if (options.group && !MUTATION_GROUPS.some((group) => group.name === options.group)) {
    throw new Error(`unknown mutation group: ${options.group}`);
  }
  const changed = options.nightly || options.mutate ? [] : changedFiles(options.base);
  const selected = MUTATION_GROUPS.filter((group) => !options.group || group.name === options.group)
    .map((group) => ({
      group,
      mutate: (options.mutate
        ? [options.mutate]
        : options.nightly
          ? group.nightly
          : changed.filter((file) => group.match.test(file))
      ).map((file) => toMutateTarget(group, file)),
    }))
    .filter(({ mutate }) => mutate.length);

  if (!selected.length) {
    console.log("mutation: no changed critical production files");
    return;
  }
  mkdirSync(path.join(ROOT, ".stryker-tmp"), { recursive: true });
  mkdirSync(path.join(ROOT, "reports", "mutation"), { recursive: true });

  if (!options.list && selected.some(({ group }) => group.mutateDist)) {
    console.log("mutation: building unmutated dist once for compiled-output groups");
    const build = spawnSync("npm", ["run", "build:loop"], {
      cwd: ROOT,
      stdio: "inherit",
      env: process.env,
    });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error("build:loop failed before the mutation campaign");
  }

  runAllCampaigns(selected, ({ group, mutate }) => {
    const config = configFor(group, mutate, options.nightly);
    const configFile = path.join(ROOT, ".stryker-tmp", `${group.name}.conf.json`);
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`mutation: ${group.name} (${mutate.join(", ")})`);
    if (options.list) return;
    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, "node_modules", "@stryker-mutator", "core", "bin", "stryker.js"),
        "run",
        configFile,
      ],
      { cwd: ROOT, stdio: "inherit", env: process.env }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Stryker exited ${result.status ?? "without a status"}`);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`mutation: ${error.message}`);
    process.exitCode = 1;
  }
}
