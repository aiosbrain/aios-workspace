import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { rollbackMigration, runMigration } from "../scripts/cli/migration.mjs";

const original = Buffer.from('{"schemaVersion":1,"future":"keep"}\n');
const migrated = Buffer.from('{"schemaVersion":2,"future":"keep"}\n');

test("migration converges byte-for-byte and successful re-entry is idempotent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-migration-"));
  const configPath = path.join(root, "config.json");
  try {
    writeFileSync(configPath, original, { mode: 0o600 });
    const options = {
      configPath,
      packageRecord: { name: "@aiosbrain/aios", version: "0.12.0" },
      stage: async () => migrated,
      validate: async (value) => assert.equal(JSON.parse(value).schemaVersion, 2),
    };
    const first = await runMigration(options);
    assert.equal(first.journal.state, "committed");
    assert.deepEqual(readFileSync(configPath), migrated);
    const second = await runMigration(options);
    assert.equal(second.journal.committedSha256, first.journal.committedSha256);
    assert.deepEqual(readFileSync(configPath), migrated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an interruption at every non-committed state resumes safely", async () => {
  for (const state of ["discovered", "snapshotted", "staged", "validated"]) {
    const root = mkdtempSync(path.join(tmpdir(), `aios-migration-${state}-`));
    const configPath = path.join(root, "config.json");
    writeFileSync(configPath, original);
    const base = {
      configPath,
      packageRecord: { name: "@aiosbrain/aios", version: "0.12.0" },
      stage: async () => migrated,
      validate: async () => {},
    };
    try {
      await assert.rejects(
        runMigration({
          ...base,
          interrupt: (current) => {
            if (current === state) throw new Error("interrupt");
          },
        })
      );
      await runMigration(base);
      assert.deepEqual(readFileSync(configPath), migrated, state);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("rollback installs the exact recorded package and restores exact snapshot bytes", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-rollback-"));
  const configPath = path.join(root, "config.json");
  const snapshotPath = path.join(root, "snapshot.json");
  const installs = [];
  try {
    writeFileSync(configPath, migrated);
    writeFileSync(snapshotPath, original);
    await rollbackMigration(
      {
        configPath,
        snapshotPath,
        package: { name: "@aiosbrain/aios", version: "0.12.0", integrity: "fixture" },
      },
      { installPackage: async (...args) => installs.push(args) }
    );
    assert.equal(installs[0][0], "@aiosbrain/aios@0.12.0");
    assert.deepEqual(readFileSync(configPath), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tampered journal paths and concurrent live-config changes fail closed", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-migration-conflict-"));
  const configPath = path.join(root, "config.json");
  const journalPath = `${configPath}.migration.json`;
  const options = {
    configPath,
    packageRecord: { name: "@aiosbrain/aios", version: "fixture" },
    stage: async (source) => Buffer.concat([source, Buffer.from("migrated\n")]),
    validate: async () => {},
  };
  try {
    writeFileSync(configPath, "original\n", { mode: 0o600 });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        state: "snapshotted",
        configPath,
        snapshotPath: path.join(root, "..", "outside"),
        stagedPath: `${configPath}.staged`,
      })}\n`,
      { mode: 0o600 }
    );
    await assert.rejects(runMigration(options), (error) => error.code === "AIOS_E_MIGRATION");
    assert.equal(readFileSync(configPath, "utf8"), "original\n");

    rmSync(journalPath);
    await assert.rejects(
      runMigration({
        ...options,
        interrupt: (state) => {
          if (state === "validated") throw new Error("fixture interruption");
        },
      }),
      (error) => error.code === "AIOS_E_MIGRATION"
    );
    writeFileSync(configPath, "concurrent edit\n", { mode: 0o600 });
    await assert.rejects(runMigration(options), (error) => error.code === "AIOS_E_MIGRATION");
    assert.equal(readFileSync(configPath, "utf8"), "concurrent edit\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a committed journal never masks later live-config drift", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-migration-committed-drift-"));
  const configPath = path.join(root, "config.json");
  const options = {
    configPath,
    packageRecord: { name: "@aiosbrain/aios", version: "fixture" },
    stage: async (source) => Buffer.concat([source, Buffer.from("migrated\n")]),
    validate: async () => {},
  };
  try {
    writeFileSync(configPath, "original\n", { mode: 0o600 });
    await runMigration(options);
    writeFileSync(configPath, "post-commit drift\n", { mode: 0o600 });
    await assert.rejects(runMigration(options), (error) => error.code === "AIOS_E_MIGRATION");
    assert.equal(readFileSync(configPath, "utf8"), "post-commit drift\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
