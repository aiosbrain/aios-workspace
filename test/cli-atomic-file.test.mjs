import test from "node:test";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWrite, snapshotFile } from "../scripts/cli/atomic-file.mjs";

test("atomic writes refuse symlink targets and direct parent directories", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-atomic-symlink-"));
  const realDirectory = path.join(root, "real");
  const linkedDirectory = path.join(root, "linked");
  const realTarget = path.join(root, "real-target.json");
  const linkedTarget = path.join(root, "linked-target.json");
  try {
    await atomicWrite(path.join(realDirectory, "seed"), "seed");
    writeFileSync(realTarget, "original", { mode: 0o600 });
    symlinkSync(realTarget, linkedTarget);
    symlinkSync(realDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");

    await assert.rejects(
      atomicWrite(linkedTarget, "replacement"),
      (error) => error.code === "AIOS_E_CONFLICT"
    );
    await assert.rejects(
      atomicWrite(path.join(linkedDirectory, "config.json"), "replacement"),
      (error) => error.code === "AIOS_E_CONFLICT"
    );
    assert.equal(readFileSync(realTarget, "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot creation refuses symlink sources and destinations before reading", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-snapshot-symlink-"));
  const real = path.join(root, "real.json");
  const sourceLink = path.join(root, "source.json");
  const snapshotLink = path.join(root, "snapshot.json");
  try {
    writeFileSync(real, "fixture", { mode: 0o600 });
    symlinkSync(real, sourceLink);
    symlinkSync(real, snapshotLink);
    await assert.rejects(
      snapshotFile(sourceLink, path.join(root, "copy.json")),
      (error) => error.code === "AIOS_E_CONFLICT"
    );
    await assert.rejects(
      snapshotFile(real, snapshotLink),
      (error) => error.code === "AIOS_E_CONFLICT"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic writes recheck a target swapped to a symlink before rename", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-atomic-target-swap-"));
  const target = path.join(root, "config.json");
  const victim = path.join(root, "victim.json");
  try {
    writeFileSync(target, "original", { mode: 0o600 });
    writeFileSync(victim, "victim", { mode: 0o600 });

    await assert.rejects(
      atomicWrite(target, "replacement", {
        failpoint(name) {
          if (name !== "before-rename") return;
          unlinkSync(target);
          symlinkSync(victim, target);
        },
      }),
      (error) => error.code === "AIOS_E_CONFLICT"
    );

    assert.equal(readFileSync(victim, "utf8"), "victim");
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(
      readdirSync(root).some((entry) => entry.endsWith(".tmp")),
      false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic writes reject a parent directory replaced with a symlink before rename", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-atomic-parent-swap-"));
  const directory = path.join(root, "config");
  const displacedDirectory = path.join(root, "config-displaced");
  const victimDirectory = path.join(root, "victim");
  const target = path.join(directory, "settings.json");
  const victim = path.join(victimDirectory, "settings.json");
  let parentChecks = 0;
  let cleanupVictim;
  try {
    await atomicWrite(target, "original");
    await atomicWrite(victim, "victim");

    await assert.rejects(
      atomicWrite(target, "replacement", {
        fs: {
          ...fsPromises,
          async lstat(candidate, options) {
            if (candidate === directory) parentChecks += 1;
            return fsPromises.lstat(candidate, options);
          },
        },
        failpoint(name, { temporary }) {
          if (name !== "before-rename") return;
          renameSync(directory, displacedDirectory);
          cleanupVictim = path.join(victimDirectory, path.basename(temporary));
          writeFileSync(cleanupVictim, "cleanup victim", { mode: 0o600 });
          symlinkSync(
            victimDirectory,
            directory,
            process.platform === "win32" ? "junction" : "dir"
          );
        },
      }),
      (error) => error.code === "AIOS_E_CONFLICT"
    );

    assert.equal(readFileSync(victim, "utf8"), "victim");
    assert.equal(readFileSync(cleanupVictim, "utf8"), "cleanup victim");
    assert.equal(readFileSync(path.join(displacedDirectory, "settings.json"), "utf8"), "original");
    assert.equal(lstatSync(directory).isSymbolicLink(), true);
    assert.equal(parentChecks, 2, "a detected parent conflict must bypass pathname cleanup");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("atomic writes reject a different parent directory before rename", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "aios-atomic-parent-replacement-"));
  const directory = path.join(root, "config");
  const displacedDirectory = path.join(root, "config-displaced");
  const replacementDirectory = path.join(root, "config-replacement");
  const target = path.join(directory, "settings.json");
  const replacementTarget = path.join(replacementDirectory, "settings.json");
  try {
    await atomicWrite(target, "original");
    mkdirSync(replacementDirectory, { mode: 0o700 });
    writeFileSync(replacementTarget, "victim", { mode: 0o600 });

    await assert.rejects(
      atomicWrite(target, "replacement", {
        failpoint(name) {
          if (name !== "before-rename") return;
          renameSync(directory, displacedDirectory);
          renameSync(replacementDirectory, directory);
        },
      }),
      (error) => error.code === "AIOS_E_CONFLICT"
    );

    assert.equal(readFileSync(path.join(directory, "settings.json"), "utf8"), "victim");
    assert.equal(readFileSync(path.join(displacedDirectory, "settings.json"), "utf8"), "original");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
