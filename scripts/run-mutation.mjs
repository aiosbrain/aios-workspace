#!/usr/bin/env node
/**
 * Changed-code and nightly mutation orchestration.
 *
 * Stryker's command runner cannot map native node:test cases to mutants, so
 * critical production files are paired with narrow, explicit test groups. The
 * GUI client uses Stryker's Vitest runner and per-test coverage analysis.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MUTATION_GROUPS = [
  {
    name: "access-governance",
    match: /^(hooks\/file-governance-guard|scripts\/sync-plan|scripts\/brain-client)\.mjs$/,
    nightly: [
      "hooks/file-governance-guard.mjs",
      "scripts/sync-plan.mjs",
      "scripts/brain-client.mjs",
    ],
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
    build: true,
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
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function changedFiles(base) {
  try {
    let diffBase = base;
    try {
      diffBase = git(["merge-base", base, "HEAD"]).trim();
    } catch {
      // A shallow/manual checkout may not have the target ref; use the supplied
      // base and let git report an empty changed set if it is also unavailable.
    }
    const changed = git(["diff", "--name-only", "--diff-filter=ACMR", diffBase, "--"])
      .trim()
      .split("\n")
      .filter(Boolean);
    const untracked = git(["ls-files", "--others", "--exclude-standard"])
      .trim()
      .split("\n")
      .filter(Boolean);
    return [...new Set([...changed, ...untracked])];
  } catch {
    return [];
  }
}

function nodeCommand(group) {
  const prefix = group.build ? "npm run build:loop && " : "";
  return `${prefix}node --test --test-concurrency=2 ${group.tests.join(" ")}`;
}

export function configFor(group, mutate, nightly) {
  const common = {
    $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    mutate,
    concurrency: 2,
    timeoutMS: 60_000,
    reporters: ["clear-text", "progress", "json"],
    jsonReporter: { fileName: `reports/mutation/${group.name}.json` },
    thresholds: { high: 80, low: 60, break: 0 },
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

function main(argv) {
  const nightly = argv.includes("--nightly");
  const listOnly = argv.includes("--list") || process.env.AIOS_MUTATION_DRY_RUN === "1";
  const groupArg = argv.find((arg) => arg.startsWith("--group="))?.slice("--group=".length);
  const mutateArg = argv.find((arg) => arg.startsWith("--mutate="))?.slice("--mutate=".length);
  if (mutateArg && !groupArg) {
    throw new Error("--mutate requires --group so a file cannot run against unrelated tests");
  }
  const explicitBaseIndex = argv.indexOf("--base");
  const base =
    explicitBaseIndex === -1
      ? process.env.GITHUB_BASE_REF
        ? `origin/${process.env.GITHUB_BASE_REF}`
        : "origin/main"
      : argv[explicitBaseIndex + 1];
  const changed = nightly ? [] : changedFiles(base);
  const selected = MUTATION_GROUPS.filter((group) => !groupArg || group.name === groupArg)
    .map((group) => ({
      group,
      mutate: mutateArg
        ? [mutateArg]
        : nightly
          ? group.nightly
          : changed.filter((file) => group.match.test(file)),
    }))
    .filter(({ mutate }) => mutate.length);

  if (groupArg && !MUTATION_GROUPS.some((group) => group.name === groupArg)) {
    throw new Error(`unknown mutation group: ${groupArg}`);
  }

  if (!selected.length) {
    console.log("mutation: no changed critical production files");
    return;
  }
  mkdirSync(path.join(ROOT, ".stryker-tmp"), { recursive: true });
  mkdirSync(path.join(ROOT, "reports", "mutation"), { recursive: true });

  for (const { group, mutate } of selected) {
    const config = configFor(group, mutate, nightly);
    const configFile = path.join(ROOT, ".stryker-tmp", `${group.name}.conf.json`);
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`mutation: ${group.name} (${mutate.join(", ")})`);
    if (listOnly) continue;
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
    if (result.status !== 0) throw new Error(`${group.name} mutation campaign failed`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`mutation: ${error.message}`);
    process.exitCode = 1;
  }
}
