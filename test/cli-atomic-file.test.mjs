import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
