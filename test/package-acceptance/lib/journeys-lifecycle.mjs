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
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "./context.mjs";

export const UPGRADE_BASELINE = "@aiosbrain/aios@0.12.0";

const INTERRUPTIBLE_STATES = ["discovered", "snapshotted", "staged", "validated"];

async function importInstalled(install, rel) {
  return import(pathToFileURL(path.join(install.pkgDir, rel)).href);
}

/** Interrupt the journal at each state, resume to committed, prove byte-stable repeat. */
export async function migrationJourney(ctx, install) {
  const { runMigration, MIGRATION_STATES } = await importInstalled(
    install,
    "scripts/cli/migration.mjs"
  );
  assert.deepEqual(
    MIGRATION_STATES,
    ["discovered", "snapshotted", "staged", "validated", "committed"],
    "the AIO-1066 journal states are the contract this journey walks"
  );
  const root = path.join(ctx.base, "migration");
  mkdirSync(root, { recursive: true });
  const results = [];
  for (const interruptAt of INTERRUPTIBLE_STATES) {
    const configPath = path.join(root, `config-${interruptAt}.json`);
    await fs.writeFile(configPath, "legacy-config-bytes\n", { mode: 0o600 });
    const options = {
      configPath,
      packageRecord: { name: ctx.manifest.packageName, version: "0.12.0" },
      stage: async (source) => Buffer.concat([source, Buffer.from("migrated\n")]),
      validate: async () => {},
    };
    let interrupted = false;
    try {
      await runMigration({
        ...options,
        interrupt: (state) => {
          if (state === interruptAt) throw new Error(`interrupt at ${state}`);
        },
      });
    } catch (error) {
      assert.equal(error.code, "AIOS_E_MIGRATION", `interruption surfaces as AIOS_E_MIGRATION`);
      interrupted = true;
    }
    assert.equal(interrupted, true, `journal must be interruptible at '${interruptAt}'`);
    const resumed = await runMigration(options);
    assert.equal(resumed.journal.state, "committed", `resume from '${interruptAt}' commits`);
    assert.equal(resumed.resumed, true, "resume must report it continued a journal");
    const afterFirst = await fs.readFile(configPath);
    assert.equal(afterFirst.toString(), "legacy-config-bytes\nmigrated\n", "staged bytes commit");
    const repeat = await runMigration(options);
    const afterSecond = await fs.readFile(configPath);
    assert.equal(repeat.journal.state, "committed", "repeat run stays committed");
    assert.ok(afterFirst.equals(afterSecond), "repeat migration is a byte-stable no-op");
    results.push({ interruptAt, resumed: true, committed: true, byteStable: true });
  }
  ctx.record("migration-journey", { states: results });
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
  ctx.run("npm", ["install", UPGRADE_BASELINE, "--omit=optional", "--no-audit", "--no-fund"], {
    cwd: livePrefix,
    label: "install-0.12.0",
  });
  const livePkg = path.join(livePrefix, "node_modules", "@aiosbrain", "aios", "package.json");
  assert.equal(JSON.parse(readFileSync(livePkg, "utf8")).version, "0.12.0");

  // Recorded rollback snapshot: exact package identity + exact config bytes.
  const configPath = path.join(upgradeRoot, "user-config.json");
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
  ctx.run("npm", ["install", ctx.tarball, "--omit=optional", "--no-audit", "--no-fund"], {
    cwd: stagingPrefix,
    label: "stage-candidate",
  });
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

  // Only after staged verification does the live install get replaced — with the exact
  // digest-verified tarball, not a registry range.
  ctx.run("npm", ["install", ctx.tarball, "--omit=optional", "--no-audit", "--no-fund"], {
    cwd: livePrefix,
    label: "upgrade-live",
  });
  const upgraded = JSON.parse(readFileSync(livePkg, "utf8"));
  assert.equal(upgraded.version, ctx.manifest.packageVersion, "live install runs the candidate");
  const liveBin = path.join(livePrefix, "node_modules", ".bin", "aios");
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
    stagedVerification: "version semantics verified in staging prefix before replacement",
    upgradedVersion: upgraded.version,
    postUpgradeDoctorOk: liveDoctor.ok,
  });
  return { livePrefix, livePkg, snapshot };
}

/** Roll the live install back to the recorded 0.12.0 package + config snapshot. */
export async function rollbackJourney(ctx, install, upgrade) {
  const { rollbackMigration } = await importInstalled(install, "scripts/cli/migration.mjs");
  // Simulate post-upgrade config drift the user wants to abandon.
  writeFileSync(upgrade.snapshot.configPath, '{"schemaVersion":2,"drifted":true}\n');
  const result = await rollbackMigration(upgrade.snapshot, {
    installPackage: async (spec) => {
      ctx.run("npm", ["install", spec, "--omit=optional", "--no-audit", "--no-fund"], {
        cwd: upgrade.livePrefix,
        label: "rollback-install",
      });
    },
  });
  assert.equal(result.package, UPGRADE_BASELINE, "rollback reinstalls the exact recorded package");
  assert.equal(result.configSha256, upgrade.snapshot.configSha256, "exact config bytes restored");
  const rolledBack = JSON.parse(readFileSync(upgrade.livePkg, "utf8"));
  assert.equal(rolledBack.version, "0.12.0", "live install is 0.12.0 again");
  assert.equal(
    sha256Hex(readFileSync(upgrade.snapshot.configPath)),
    upgrade.snapshot.configSha256,
    "live config matches the snapshot digest"
  );
  ctx.record("rollback-journey", {
    restoredPackage: result.package,
    restoredConfigSha256: result.configSha256,
  });
}
