import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { assertNotSymlink, atomicWrite, snapshotFile } from "./atomic-file.mjs";
import { AiosError } from "./errors.mjs";

export const MIGRATION_STATES = Object.freeze([
  "discovered",
  "snapshotted",
  "staged",
  "validated",
  "committed",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function readJson(file, io) {
  try {
    return JSON.parse(await io.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertJournal(journal, expected) {
  if (
    !journal ||
    !MIGRATION_STATES.includes(journal.state) ||
    journal.configPath !== expected.configPath ||
    journal.snapshotPath !== expected.snapshotPath ||
    journal.stagedPath !== expected.stagedPath
  ) {
    throw new AiosError(
      "AIOS_E_MIGRATION",
      "The migration journal is invalid or belongs to another config path.",
      "Restore the last-known-good snapshot and remove the invalid journal before retrying."
    );
  }
}

async function persist(journalPath, journal, options) {
  await atomicWrite(journalPath, json(journal), options);
  options.interrupt?.(journal.state, Object.freeze({ ...journal }));
}

/**
 * Run or resume one byte-stable config transition. `stage` and `validate` are pure/injected;
 * committed state is the only point at which the live config bytes change.
 */
export async function runMigration(options) {
  const io = options.fs ?? fs;
  const configPath = path.resolve(options.configPath);
  const journalPath = options.journalPath ?? `${configPath}.migration.json`;
  const snapshotPath = options.snapshotPath ?? `${configPath}.last-known-good`;
  const stagedPath = options.stagedPath ?? `${configPath}.staged`;
  const expected = { configPath, snapshotPath, stagedPath };
  let journal = null;
  let resumed = false;
  try {
    await assertNotSymlink(journalPath, { fs: io });
    journal = await readJson(journalPath, io);
    resumed = Boolean(journal);
    if (journal?.state === "committed") {
      assertJournal(journal, expected);
      await assertNotSymlink(configPath, { fs: io });
      const live = await io.readFile(configPath);
      if (sha256(live) !== journal.committedSha256) throw new Error("committed digest mismatch");
      await assertNotSymlink(stagedPath, { fs: io });
      try {
        const staged = await io.readFile(stagedPath);
        if (sha256(staged) !== journal.stagedSha256) throw new Error("staged digest mismatch");
        await io.rm(stagedPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      return { journal, resumed: true };
    }
    if (!journal) {
      const source = await io.readFile(configPath);
      journal = {
        schemaVersion: 1,
        state: "discovered",
        configPath,
        snapshotPath,
        stagedPath,
        sourceSha256: sha256(source),
        package: options.packageRecord,
      };
      await persist(journalPath, journal, options);
    } else {
      assertJournal(journal, expected);
    }
    if (journal.state === "discovered") {
      await snapshotFile(configPath, snapshotPath, options);
      journal.state = "snapshotted";
      await persist(journalPath, journal, options);
    }
    if (journal.state === "snapshotted") {
      await assertNotSymlink(snapshotPath, { fs: io });
      const source = await io.readFile(snapshotPath);
      if (sha256(source) !== journal.sourceSha256) throw new Error("snapshot digest mismatch");
      const staged = Buffer.from(await options.stage(source));
      await atomicWrite(stagedPath, staged, options);
      journal.stagedSha256 = sha256(staged);
      journal.state = "staged";
      await persist(journalPath, journal, options);
    }
    if (journal.state === "staged") {
      await assertNotSymlink(stagedPath, { fs: io });
      const staged = await io.readFile(stagedPath);
      if (sha256(staged) !== journal.stagedSha256) throw new Error("staged digest mismatch");
      await options.validate(staged);
      journal.state = "validated";
      await persist(journalPath, journal, options);
    }
    if (journal.state === "validated") {
      await assertNotSymlink(stagedPath, { fs: io });
      await assertNotSymlink(configPath, { fs: io });
      const staged = await io.readFile(stagedPath);
      if (sha256(staged) !== journal.stagedSha256) throw new Error("staged digest mismatch");
      const live = await io.readFile(configPath);
      const liveSha256 = sha256(live);
      if (liveSha256 === journal.sourceSha256) {
        await atomicWrite(configPath, staged, options);
      } else if (liveSha256 !== journal.stagedSha256) {
        throw new Error("live config changed after snapshot");
      }
      journal.state = "committed";
      journal.committedSha256 = journal.stagedSha256;
      await persist(journalPath, journal, options);
      await io.rm(stagedPath, { force: true });
    }
    return { journal, resumed };
  } catch (cause) {
    throw new AiosError(
      "AIOS_E_MIGRATION",
      `Config migration stopped in state '${journal?.state ?? "discovered"}'.`,
      `Re-run to resume, or restore the exact snapshot at ${snapshotPath}.`,
      { cause }
    );
  }
}

/** Restore exact config bytes and reinstall the exact recorded package through an injected seam. */
export async function rollbackMigration(record, options) {
  if (
    !record?.package?.name ||
    !record.package.version ||
    !record.snapshotPath ||
    !record.configPath
  ) {
    throw new AiosError(
      "AIOS_E_MIGRATION",
      "The rollback record is incomplete.",
      "Recover the exact package/version and last-known-good snapshot before rollback."
    );
  }
  const io = options.fs ?? fs;
  await assertNotSymlink(record.snapshotPath, { fs: io });
  await assertNotSymlink(record.configPath, { fs: io });
  const snapshot = await io.readFile(record.snapshotPath);
  await options.installPackage(`${record.package.name}@${record.package.version}`, record.package);
  await atomicWrite(record.configPath, snapshot, options);
  return {
    package: `${record.package.name}@${record.package.version}`,
    configSha256: sha256(snapshot),
  };
}
