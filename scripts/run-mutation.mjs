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
 *
 * Nightly scope contract (AIO-539, docs/v1-operator-loop/domains/mutation-denominator.md):
 * each group's `nightly` is its declared SAFETY UNIT, `nightlyExcludes` records
 * every regex-matched file deliberately left out (the completeness test forces a
 * new file in a critical directory to be classified), and `nightlyTests` — when
 * present — is the nightly kill command (the unit's own tests). The changed-code
 * lane always uses the umbrella `tests`. With coverageAnalysis "off", per-mutant
 * cost is the WHOLE kill command, so nightly feasibility depends on both fields.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MEASURED_EMPTY_MESSAGE,
  mutationBaseSkipMessage,
  resolveMutationBase,
} from "./mutation-push-base.mjs";

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
    // All three files ARE the safety unit (sync-plan.mjs extracted by AIO-540);
    // nothing is deliberately dropped.
    nightlyExcludes: [],
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
    nightly: ["hooks/local-bugbot-gate.mjs"],
    nightlyExcludes: [
      // CLI wrapper around the gate; the hook itself is the safety unit.
      "scripts/review-bugbot.mjs",
    ],
    // No nightlyTests: the unit's own test spawns the real hook per case
    // (~15s/mutant), so this leg stays deliberately red until AIO-554 makes
    // the oracle in-process fast. Do not silence the red by widening timeouts.
    tests: ["test/local-bugbot-gate.test.mjs", "test/review-bugbot.test.mjs"],
  },
  {
    name: "update-safety",
    match: /^scripts\/(?:update|toolkit-(?:merge|pull|manifest|meta))\.mjs$/,
    // The declared safety unit: decideMerge — "a local edit is never silently
    // overwritten". The siblings below are orchestration around it.
    nightly: ["scripts/toolkit-merge.mjs"],
    nightlyExcludes: [
      // Update orchestration; exercised end-to-end, unit is decideMerge.
      "scripts/update.mjs",
      // Fetch/transport layer around the merge decision.
      "scripts/toolkit-pull.mjs",
      // Bucket classification; guarded by the manifest-parity test instead.
      "scripts/toolkit-manifest.mjs",
      // Version stamping only.
      "scripts/toolkit-meta.mjs",
    ],
    nightlyTests: ["test/toolkit-merge.test.mjs"],
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
    // The declared safety unit: the capability broker (the authorization
    // boundary). Narrowing onto it activates the calibrated 90% break floor.
    nightly: ["src/operator-loop/inbox/capability.ts"],
    nightlyExcludes: [
      // CLI surface over the broker; not the authorization decision itself.
      "scripts/inbox.mjs",
      // Inbox infrastructure around the broker (~9,700 lines). Mutating it
      // nightly costs hours per night for a score about files this group's
      // claim is not about; any widening back in is a separate, measured
      // decision recorded here (AIO-539).
      "src/operator-loop/inbox/audit.ts",
      "src/operator-loop/inbox/cli.ts",
      "src/operator-loop/inbox/credential-broker.ts",
      "src/operator-loop/inbox/device-identity.ts",
      "src/operator-loop/inbox/host-health.ts",
      "src/operator-loop/inbox/host-supervisor.ts",
      "src/operator-loop/inbox/journal.ts",
      "src/operator-loop/inbox/m365-verify.ts",
      "src/operator-loop/inbox/notify-telegram.ts",
      "src/operator-loop/inbox/observations.ts",
      "src/operator-loop/inbox/outbox-credential.ts",
      "src/operator-loop/inbox/outbox.ts",
      "src/operator-loop/inbox/ranker-adapter.ts",
      "src/operator-loop/inbox/ranker.ts",
      "src/operator-loop/inbox/read-model.ts",
      "src/operator-loop/inbox/recovery.ts",
      "src/operator-loop/inbox/reply-policy.ts",
      "src/operator-loop/inbox/retention.ts",
      "src/operator-loop/inbox/seeding.ts",
      "src/operator-loop/inbox/state-machines.ts",
    ],
    // ORACLE (AIO-994): test/operator-loop/inbox-capability.test.mjs is THE mutation oracle
    // for the calibrated capability floor — it imports dist/operator-loop/inbox/capability.js
    // directly, so it can distinguish a mutated broker from an intact one. The previous oracle
    // travelled to aiosbrain/aios-workspace-gui with the AIO-612 cut, and its substitute (the
    // operator-loop umbrella) never imported the module: all 26 mutants survived by
    // construction (score 0.00 vs the 90% floor, main red nightly 2026-08-13..20). If the
    // oracle file is cut or renamed again, the tracked-file assertions in
    // test/mutation-config.test.mjs fail loudly. Never point this group at a suite that does
    // not import the mutate target, and never lower or remove the 90% floor to green the lane.
    nightlyTests: ["test/operator-loop/inbox-capability.test.mjs"],
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

function nodeCommand(group, nightly) {
  // No build step here: compiled-output groups build dist once (unmutated)
  // before the campaign, so the per-mutant command is pure test execution and
  // a compile-breaking mutant cannot be scored as "killed" by the compiler.
  // `chmod +x` only repairs execute bits Stryker's sandbox copy drops; it
  // always succeeds on tracked files and cannot kill a mutant.
  const chmod = group.executableBits ? `chmod +x ${group.executableBits.join(" ")} && ` : "";
  // Nightly campaigns kill with the unit's own tests (per-mutant cost is the
  // whole command); the changed-code lane keeps the widest available oracle.
  // `?.length` guards the empty-array footgun: `[]` is truthy, and node --test
  // with no file args would run full default test discovery per mutant.
  const tests = nightly && group.nightlyTests?.length ? group.nightlyTests : group.tests;
  return `${chmod}node --test --test-concurrency=2 ${tests.join(" ")}`;
}

/**
 * Split a group's selected mutate set into per-campaign sets so every
 * calibrated target always runs as its own SOLE-denominator campaign.
 *
 * Stryker reports one aggregate score per campaign, so a floor calibrated on
 * one file is enforceable only when that file is the whole denominator.
 * Pre-AIO-534 the changed-code lane built a single campaign from every
 * matched file, so a PR touching a calibrated target PLUS any sibling in the
 * group collapsed the threshold to 0 — the "shotgun bypass": adding a second
 * inbox file dodged the only enforced floor. Splitting here removes the
 * bypass structurally: the calibrated target's floor is armed no matter what
 * else changed, and the remaining files run as their own advisory campaign.
 *
 * Returns `[{ mutate, label }]`. Labels stay the plain group name when no
 * split happens (stable report/artifact paths); a split calibrated campaign
 * gets `<group>--<basename>` so the two campaigns cannot clobber each
 * other's config or report files.
 */
export function splitCampaigns(group, mutate) {
  const calibrated = mutate.filter((file) => (group.breakThresholdByTarget?.[file] ?? 0) > 0);
  const rest = mutate.filter((file) => !calibrated.includes(file));
  const campaigns = calibrated.map((file) => ({
    mutate: [file],
    label: `${group.name}--${path.basename(file).replace(/\.[cm]?js$/, "")}`,
  }));
  if (rest.length) campaigns.push({ mutate: rest, label: group.name });
  if (campaigns.length === 1) campaigns[0].label = group.name;
  // Labels name config + report files; two calibrated targets sharing a
  // basename would silently clobber each other's — fail loudly instead.
  if (new Set(campaigns.map((campaign) => campaign.label)).size !== campaigns.length) {
    throw new Error(
      `${group.name}: duplicate campaign labels from same-basename calibrated targets — ` +
        `disambiguate breakThresholdByTarget or the label scheme in splitCampaigns()`
    );
  }
  return campaigns;
}

/**
 * Delete stale split-campaign reports (label `<group>--<basename>.json`) for
 * the groups about to run. A stale one left by an earlier diff (whose
 * selection produced a split this run does not) would double-count the group
 * in codebase-health's checkMutationScore, which sums every
 * reports/mutation/*.json. Live split reports are rewritten by the campaigns
 * that follow.
 */
export function clearStaleSplitReports(groupNames, reportsDir) {
  for (const name of new Set(groupNames)) {
    for (const file of readdirSync(reportsDir)) {
      if (file.startsWith(`${name}--`) && file.endsWith(".json")) {
        unlinkSync(path.join(reportsDir, file));
      }
    }
  }
}

export function configFor(group, mutate, nightly, label = group.name) {
  // A threshold calibrated on one file is valid only when that file is the
  // complete campaign denominator. splitCampaigns() upstream guarantees a
  // calibrated target is always its own sole-denominator campaign; this
  // guard stays as defense in depth (e.g. an explicit --mutate list). Mixed
  // and whole-group campaigns remain advisory until measured directly.
  const breakThreshold = mutate.length === 1 ? (group.breakThresholdByTarget?.[mutate[0]] ?? 0) : 0;
  const common = {
    $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    mutate,
    concurrency: 2,
    timeoutMS: 60_000,
    reporters: ["clear-text", "progress", "json"],
    jsonReporter: { fileName: `reports/mutation/${label}.json` },
    thresholds: { high: 80, low: 60, break: breakThreshold },
    // Incremental is UNSOUND with the command runner: it reports no per-test information, so
    // Stryker cannot see test changes and reuses stale verdicts — measured on the AIO-539
    // calibration, where a strengthened oracle kept "losing" to cached Survived results. The one
    // group that could safely keep incremental state was the Vitest (perTest) client group, and
    // that left with gui/client in the AIO-612 cut. Every remaining group uses the command
    // runner, so this is now unconditionally off.
    incremental: false,
    incrementalFile: `.stryker-tmp/${label}.json`,
  };
  return {
    ...common,
    testRunner: "command",
    coverageAnalysis: "off",
    commandRunner: { command: nodeCommand(group, nightly) },
  };
}

export function runAllCampaigns(selected, runCampaign) {
  const failures = [];
  for (const entry of selected) {
    try {
      runCampaign(entry);
    } catch (error) {
      failures.push({ group: entry.label ?? entry.group.name, error });
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
    // null = no explicit --base; main() resolves the real base from the CI
    // environment via resolveMutationBase (push sha > PR base ref > origin/main).
    base: null,
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

function isCommit(sha) {
  try {
    git(["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the diff base from CLI/CI inputs and enumerate changed files.
 * Returns null after reporting an explicit skip when the base cannot be
 * determined for this push (never a silent measured-empty green, AIO-1016).
 */
function resolveChangedFiles(options) {
  const resolution = resolveMutationBase({
    baseFlag: options.base,
    mutationBaseSha: process.env.MUTATION_BASE_SHA ?? "",
    githubBaseRef: process.env.GITHUB_BASE_REF ?? "",
    isCommit,
  });
  if (resolution.skip) {
    // Advisory lane (AIO-630): exit 0, but never green as if measured.
    const message = mutationBaseSkipMessage(resolution.skip);
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    }
    return null;
  }
  return changedFiles(resolution.base);
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.mutate && !options.group) {
    throw new Error("--mutate requires --group so a file cannot run against unrelated tests");
  }
  if (options.group && !MUTATION_GROUPS.some((group) => group.name === options.group)) {
    throw new Error(`unknown mutation group: ${options.group}`);
  }
  let changed = [];
  if (!options.nightly && !options.mutate) {
    const resolved = resolveChangedFiles(options);
    if (resolved === null) return;
    changed = resolved;
  }
  const selected = MUTATION_GROUPS.filter((group) => !options.group || group.name === options.group)
    .flatMap((group) => {
      const mutate = (
        options.mutate
          ? [options.mutate]
          : options.nightly
            ? group.nightly
            : changed.filter((file) => group.match.test(file))
      ).map((file) => toMutateTarget(group, file));
      // Calibrated targets split into sole-denominator campaigns so their
      // floors are enforced regardless of what else the diff touched (AIO-534).
      return splitCampaigns(group, mutate).map((campaign) => ({ group, ...campaign }));
    })
    .filter(({ mutate }) => mutate.length);

  if (!selected.length) {
    console.log(MEASURED_EMPTY_MESSAGE);
    return;
  }
  mkdirSync(path.join(ROOT, ".stryker-tmp"), { recursive: true });
  const reportsDir = path.join(ROOT, "reports", "mutation");
  mkdirSync(reportsDir, { recursive: true });

  // Not in --list mode: a dry run must not delete real reports.
  if (!options.list) {
    clearStaleSplitReports(
      selected.map(({ group }) => group.name),
      reportsDir
    );
  }

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

  runAllCampaigns(selected, ({ group, mutate, label }) => {
    const config = configFor(group, mutate, options.nightly, label);
    const configFile = path.join(ROOT, ".stryker-tmp", `${label}.conf.json`);
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`mutation: ${label} (${mutate.join(", ")})`);
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
