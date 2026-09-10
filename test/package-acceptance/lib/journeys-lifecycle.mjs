/**
 * AIO-1071 lifecycle journeys, exercised through the INSTALLED candidate's own
 * migration machinery (the AIO-1066 journal):
 *  - interruption at EVERY journal state, then resume to committed;
 *  - repeat migration as a byte-stable no-op;
 *  - exact upgrade from registry @aiosbrain/aios@0.12.0 with stage-and-verify BEFORE
 *    the working install is replaced;
 *  - user rollback to the recorded 0.12.0 package/config snapshot.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "./context.mjs";

export const UPGRADE_BASELINE = "@aiosbrain/aios@0.12.0";

// A permanent fact of the registry: published 0.12.0 pins @aiosbrain/aios-devtools
// EXACTLY 0.3.0, whose engines are ">=22 <23" — so 0.12.0 was never installable
// engine-strict on Node 24/26. The legacy-baseline installs (and only those) relax
// engine-strict for that one npm invocation; every candidate install stays strict.
export const LEGACY_ENGINE_RELAXATION =
  "legacy 0.12.0 installed with engine-strict relaxed: published 0.3.0 devtools pin " +
  '(engines ">=22 <23") predates the Node 24/26 support matrix';

/**
 * The single npm-install chokepoint of the lifecycle journeys, so the engine-strict
 * scope is auditable and unit-testable: `legacy: true` (the published 0.12.0 baseline
 * only) is the ONE path allowed to relax `npm_config_engine_strict`.
 */
export function runNpmInstall(ctx, { spec, cwd, label, legacy = false }) {
  ctx.runWithAmbientEnv("npm", ["install", spec, "--omit=optional", "--no-audit", "--no-fund"], {
    cwd,
    label,
    envExtra: legacy ? { npm_config_engine_strict: "false" } : {},
  });
}

const INTERRUPTIBLE_STATES = ["discovered", "snapshotted", "staged", "validated"];

/** Drive the real installed update command through abrupt process termination and re-entry. */
function interruptedUpdateJourney(ctx, { workspace, stagedBin, stagingPrefix, workspaceEnv }) {
  const results = [];
  const moduleUrl = pathToFileURL(
    realpathSync(
      path.join(stagingPrefix, "node_modules", "@aiosbrain", "aios", "scripts/cli/migration.mjs")
    )
  ).href;
  for (const interruptAt of [...INTERRUPTIBLE_STATES, "committed"]) {
    const fixture = `${workspace}-interrupt-${interruptAt}`;
    cpSync(workspace, fixture, { recursive: true, verbatimSymlinks: true });
    const marker = path.join(ctx.base, `interrupt-${interruptAt}.json`);
    const args = ["update", "--repo", fixture];
    const interrupted = ctx.run(stagedBin, args, {
      cwd: fixture,
      env: {
        ...workspaceEnv,
        NODE_OPTIONS: `--import=${pathToFileURL(path.join(ctx.artifactDir, "helpers", "interrupt-migration.mjs")).href}`,
        AIOS_ACCEPTANCE_MIGRATION_MODULE: moduleUrl,
        AIOS_ACCEPTANCE_INTERRUPT_STATE: interruptAt,
        AIOS_ACCEPTANCE_INTERRUPT_MARKER: marker,
      },
      expectFailure: true,
      label: `interrupt-cli-${interruptAt}`,
    });
    assert.equal(interrupted.status, 86, "the actual CLI must reach the intended crash boundary");
    assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { loaded: moduleUrl, interruptAt });
    const stamp = path.join(fixture, ".aios-toolkit-version");
    assert.equal(JSON.parse(readFileSync(`${stamp}.migration.json`, "utf8")).state, interruptAt);
    ctx.run(stagedBin, args, {
      cwd: fixture,
      env: workspaceEnv,
      label: `resume-cli-${interruptAt}`,
    });
    assert.match(readFileSync(stamp, "utf8"), /^stamp-format 2$/m);
    assert.equal(existsSync(`${stamp}.migration.json`), false);
    const stableStamp = () =>
      readFileSync(stamp, "utf8").replace(/^synced-at .+$/m, "synced-at MASKED");
    const before = stableStamp();
    ctx.run(stagedBin, args, {
      cwd: fixture,
      env: workspaceEnv,
      label: `repeat-cli-${interruptAt}`,
    });
    assert.equal(stableStamp(), before);
    assert.match(
      readFileSync(path.join(fixture, ".claude/rules/acceptance-custom.md"), "utf8"),
      /acceptance customization/
    );
    results.push({
      interruptAt,
      actualCli: true,
      exitCode: 86,
      resumed: true,
      committed: true,
      byteStable: true,
    });
  }
  ctx.record("migration-journey", {
    mechanism: "installed CLI process exit after durable journal write; unmodified CLI re-entry",
    states: results,
  });
}

/** Install registry 0.12.0, record a snapshot, stage-and-verify the candidate, upgrade. */
export function upgradeJourney(ctx) {
  const upgradeRoot = path.join(ctx.base, "upgrade");
  const livePrefix = path.join(upgradeRoot, "live");
  mkdirSync(livePrefix, { recursive: true });
  writeFileSync(
    path.join(livePrefix, "package.json"),
    `${JSON.stringify({ name: "aios-upgrade-fixture", private: true }, null, 2)}\n`
  );
  runNpmInstall(ctx, {
    spec: UPGRADE_BASELINE,
    cwd: livePrefix,
    label: "install-0.12.0-legacy-relaxed",
    legacy: true,
  });
  const livePkg = path.join(livePrefix, "node_modules", "@aiosbrain", "aios", "package.json");
  assert.equal(JSON.parse(readFileSync(livePkg, "utf8")).version, "0.12.0");

  // Recorded rollback snapshot: exact package identity + exact config bytes.
  const configDir = path.join(upgradeRoot, "config");
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.json");
  const configBytes = '{"schemaVersion":2,"defaultWorkspace":"/fixture/workspace"}\n';
  writeFileSync(configPath, configBytes, { mode: 0o600 });
  const snapshotDir = path.join(upgradeRoot, "snapshot-0.12.0");
  mkdirSync(snapshotDir, { recursive: true });
  cpSync(configPath, path.join(snapshotDir, "user-config.json"));
  const snapshot = {
    package: { name: ctx.manifest.packageName, version: "0.12.0" },
    configSha256: sha256Hex(Buffer.from(configBytes)),
    snapshotPath: path.join(snapshotDir, "user-config.json"),
    configPath,
  };

  // Stage-and-verify BEFORE touching the working install: the candidate goes into a
  // staging prefix and must pass semantic verification there first.
  const stagingPrefix = path.join(upgradeRoot, "staging");
  mkdirSync(stagingPrefix, { recursive: true });
  writeFileSync(
    path.join(stagingPrefix, "package.json"),
    `${JSON.stringify({ name: "aios-staging-fixture", private: true }, null, 2)}\n`
  );
  runNpmInstall(ctx, { spec: ctx.tarball, cwd: stagingPrefix, label: "stage-candidate" });
  const stagedBin = path.join(stagingPrefix, "node_modules", ".bin", "aios");
  const stagedVersion = JSON.parse(
    ctx.run(stagedBin, ["version", "--json"], {
      cwd: stagingPrefix,
      env: ctx.cliEnv(),
      label: "verify-staged",
    }).stdout
  );
  assert.equal(stagedVersion.command, "version");
  assert.ok(stagedVersion.label.startsWith(`v${ctx.manifest.packageVersion} `));

  // Exercise the real workspace migration while the recorded 0.12.0 package still
  // exists. Replacing npm first would destroy the v1 source-content merge bases.
  const workspace = path.join(upgradeRoot, "workspace");
  ctx.runWithAmbientEnv(
    "bash",
    [
      path.join(path.dirname(livePkg), "scripts", "scaffold-project.sh"),
      "--context",
      "consultant",
      "--slug",
      "upgrade-sample",
      "--owner",
      "alex",
      "--stakeholder",
      "Sample Co",
      "--team",
      "alex,sam",
      "--org",
      "your-github-org",
      "--currency",
      "USD",
      "--output",
      workspace,
    ],
    { label: "scaffold-legacy-workspace" }
  );
  const stampPath = path.join(workspace, ".aios-toolkit-version");
  const legacyStamp = readFileSync(stampPath, "utf8");
  assert.doesNotMatch(legacyStamp, /stamp-format 2/);
  // A user-owned rule must survive migration. Do not customize frontmatter.md here:
  // that template legitimately changes with the membership contract, causing a preflight
  // merge conflict before any durable-journal interruption boundary is reached.
  const customPath = path.join(workspace, ".claude", "rules", "acceptance-custom.md");
  writeFileSync(
    customPath,
    "# Local acceptance rule\n\nPreserve this acceptance customization.\n"
  );
  ctx.runWithAmbientEnv("git", ["add", "-A"], { cwd: workspace, label: "record-customization" });
  ctx.runWithAmbientEnv(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "customize workspace",
    ],
    { cwd: workspace, label: "commit-customization" }
  );
  const workspaceEnv = ctx.cliEnv({ AIOS_UPDATE_OFFLINE: "1", AIOS_CONFIG_DIR: configDir });
  interruptedUpdateJourney(ctx, { workspace, stagedBin, stagingPrefix, workspaceEnv });
  ctx.run(stagedBin, ["update", "--repo", workspace], {
    cwd: workspace,
    env: workspaceEnv,
    label: "migrate-workspace-before-replacement",
  });
  assert.match(readFileSync(stampPath, "utf8"), /^stamp-format 2$/m);
  assert.match(readFileSync(customPath, "utf8"), /acceptance customization/);
  const rollbackRecord = JSON.parse(
    readFileSync(path.join(workspace, ".aios", "rollback.json"), "utf8")
  );
  assert.equal(rollbackRecord.stampSnapshot, legacyStamp);
  assert.equal(rollbackRecord.previousPackage, UPGRADE_BASELINE);

  // Only after staged verification does the live install get replaced — with the exact
  // digest-verified tarball, not a registry range.
  runNpmInstall(ctx, { spec: ctx.tarball, cwd: livePrefix, label: "upgrade-live" });
  const upgraded = JSON.parse(readFileSync(livePkg, "utf8"));
  assert.equal(upgraded.version, ctx.manifest.packageVersion, "live install runs the candidate");
  const liveBin = path.join(livePrefix, "node_modules", ".bin", "aios");
  const rubricPath = path.join(workspace, ".claude/rubrics/spec-readiness.md");
  const rubricBefore = readFileSync(rubricPath, "utf8");
  const beforeRepeat = readFileSync(stampPath, "utf8").replace(
    /^synced-at .+$/m,
    "synced-at MASKED"
  );
  ctx.run(liveBin, ["update", "--repo", workspace], {
    cwd: workspace,
    env: workspaceEnv,
    label: "repeat-workspace-after-replacement",
  });
  assert.equal(
    readFileSync(stampPath, "utf8").replace(/^synced-at .+$/m, "synced-at MASKED"),
    beforeRepeat
  );
  assert.equal(
    readFileSync(rubricPath, "utf8"),
    rubricBefore,
    "repeat update retains required exact-file rubric"
  );
  assert.match(readFileSync(customPath, "utf8"), /acceptance customization/);
  const liveDoctor = JSON.parse(
    ctx.run(liveBin, ["doctor", "--json"], {
      cwd: livePrefix,
      env: ctx.cliEnv({ AIOS_CONFIG_DIR: upgradeRoot }),
      label: "post-upgrade-doctor",
    }).stdout
  );
  assert.equal(liveDoctor.command, "doctor");
  assert.equal(liveDoctor.ok, true, "upgraded install must be doctor-ok");

  ctx.record("upgrade-journey", {
    baseline: UPGRADE_BASELINE,
    legacyInstall: LEGACY_ENGINE_RELAXATION,
    candidateEngineStrict: true,
    stagedVerification: "version semantics verified in staging prefix before replacement",
    upgradedVersion: upgraded.version,
    postUpgradeDoctorOk: liveDoctor.ok,
    workspaceMigration:
      "v1 to v2 before in-place replacement; customization preserved; repeat stamp stable",
  });
  return { livePrefix, livePkg, snapshot, workspace, legacyStamp, workspaceEnv };
}

/** Roll the live install back to the recorded 0.12.0 package + config snapshot. */
export async function rollbackJourney(ctx, upgrade) {
  const liveBin = path.join(upgrade.livePrefix, "node_modules", ".bin", "aios");
  const stampPath = path.join(upgrade.workspace, ".aios-toolkit-version");
  const migratedStamp = readFileSync(stampPath, "utf8");
  const configBefore = readFileSync(upgrade.snapshot.configPath, "utf8");
  const drift = '{"schemaVersion":2,"drifted":true}\n';
  writeFileSync(upgrade.snapshot.configPath, drift);
  const refused = ctx.run(liveBin, ["update", "--rollback", "--repo", upgrade.workspace], {
    cwd: upgrade.workspace,
    env: upgrade.workspaceEnv,
    expectFailure: true,
    label: "rollback-cli-config-drift-refused",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /configuration changed after the migration snapshot/);
  assert.equal(readFileSync(stampPath, "utf8"), migratedStamp);
  assert.equal(readFileSync(upgrade.snapshot.configPath, "utf8"), drift);
  // Preserve drift before the user explicitly reconciles to the recorded snapshot.
  writeFileSync(path.join(ctx.base, "preserved-config-drift.json"), drift);
  writeFileSync(upgrade.snapshot.configPath, configBefore);
  const restored = ctx.run(liveBin, ["update", "--rollback", "--repo", upgrade.workspace], {
    cwd: upgrade.workspace,
    env: upgrade.workspaceEnv,
    label: "rollback-cli-after-reconcile",
  });
  assert.match(restored.stdout, /@aiosbrain\/aios@0\.12\.0/);
  assert.match(restored.stdout, /restored the pre-upgrade stamp\/config snapshots/);
  assert.equal(readFileSync(stampPath, "utf8"), upgrade.legacyStamp);
  assert.equal(readFileSync(upgrade.snapshot.configPath, "utf8"), configBefore);
  // Noninteractive rollback prints the exact reinstall command. Execute the recorded
  // exact package through the scoped legacy installer after verifying CLI restoration.
  runNpmInstall(ctx, {
    spec: UPGRADE_BASELINE,
    cwd: upgrade.livePrefix,
    label: "rollback-install-legacy-relaxed",
    legacy: true,
  });
  assert.equal(JSON.parse(readFileSync(upgrade.livePkg, "utf8")).version, "0.12.0");
  assert.equal(sha256Hex(readFileSync(upgrade.snapshot.configPath)), upgrade.snapshot.configSha256);
  ctx.record("rollback-journey", {
    actualCli: true,
    configDriftRefused: true,
    driftPreserved: true,
    reconciledConfigRestored: true,
    restoredPackage: UPGRADE_BASELINE,
    restoredConfigSha256: upgrade.snapshot.configSha256,
    legacyReinstall: LEGACY_ENGINE_RELAXATION,
  });
}
