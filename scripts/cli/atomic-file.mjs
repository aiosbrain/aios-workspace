import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AiosError } from "./errors.mjs";

const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value)));
const PARENT_CONFLICT = Symbol("parentConflict");

function conflict(message, target) {
  return new AiosError(
    "AIOS_E_CONFLICT",
    `${message}: ${target}`,
    "Restore the expected directory and regular config file, then retry."
  );
}

function parentConflict(message, target) {
  const error = conflict(message, target);
  error[PARENT_CONFLICT] = true;
  return error;
}

function statIdentity(stat) {
  const supported = (value) => typeof value === "number" || typeof value === "bigint";
  return supported(stat.dev) && supported(stat.ino) ? `${stat.dev}:${stat.ino}` : null;
}

async function captureDirectory(directory, io) {
  let stat;
  try {
    stat = await io.lstat(directory, { bigint: true });
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) {
      throw parentConflict("Parent directory became unavailable", directory);
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw parentConflict("Refusing to use symlink parent directory", directory);
  }
  if (!stat.isDirectory()) throw parentConflict("Parent path is not a directory", directory);
  return { identity: statIdentity(stat) };
}

async function reassertDirectory(directory, initial, io) {
  const current = await captureDirectory(directory, io);
  if (
    initial.identity !== null &&
    (current.identity === null || current.identity !== initial.identity)
  ) {
    throw parentConflict("Parent directory changed during atomic write", directory);
  }
}

async function removeTemporaryIfDirectoryIsUnchanged(temporary, directory, initial, io) {
  try {
    await reassertDirectory(directory, initial, io);
    await io.rm(temporary, { force: true });
  } catch {
    // Best effort only: portable Node has no unlinkat-style API, and a parent swap can still occur
    // between this recheck and the pathname-based removal. Known parent conflicts bypass this path.
  }
}

export async function assertNotSymlink(target, options = {}) {
  const io = options.fs ?? fs;
  let stat;
  try {
    stat = await io.lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    throw new AiosError(
      "AIOS_E_CONFLICT",
      `Refusing to replace symlink: ${target}`,
      "Replace the symlink with a regular config file and retry."
    );
  }
}

async function syncDirectory(directory, io) {
  let handle;
  try {
    handle = await io.open(directory, constants.O_RDONLY);
    await handle.sync();
    return { supported: true };
  } catch (error) {
    if (["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) {
      return { supported: false, reason: error.code };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Restrictive same-directory write followed by an atomic rename. */
export async function atomicWrite(target, content, options = {}) {
  const io = options.fs ?? fs;
  const directory = path.dirname(target);
  await io.mkdir(directory, { recursive: true, mode: 0o700 });
  const initialDirectory = await captureDirectory(directory, io);
  await assertNotSymlink(target, { fs: io });
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  const flags =
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
  let handle;
  try {
    options.failpoint?.("before-open", { target, temporary });
    handle = await io.open(temporary, flags, 0o600);
    await handle.writeFile(bytes(content));
    options.failpoint?.("after-write", { target, temporary });
    await handle.sync();
    await handle.close();
    handle = null;
    options.failpoint?.("before-rename", { target, temporary });
    // Portable Node has no fd-relative conditional rename. Rechecking immediately before rename
    // narrows the swap window, but cannot eliminate a race after these checks complete.
    await reassertDirectory(directory, initialDirectory, io);
    await assertNotSymlink(target, { fs: io });
    await io.rename(temporary, target);
    const directorySync = await syncDirectory(directory, io);
    return { target, directorySync };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!error?.[PARENT_CONFLICT]) {
      await removeTemporaryIfDirectoryIsUnchanged(temporary, directory, initialDirectory, io);
    }
    throw error;
  }
}

/** Copy exact live bytes to a restrictive snapshot without replacing an existing snapshot. */
export async function snapshotFile(source, snapshot, options = {}) {
  const io = options.fs ?? fs;
  await assertNotSymlink(source, { fs: io });
  await assertNotSymlink(snapshot, { fs: io });
  const content = await io.readFile(source);
  try {
    await io.access(snapshot);
    const existing = await io.readFile(snapshot);
    if (!existing.equals(content)) {
      throw new AiosError(
        "AIOS_E_CONFLICT",
        "The existing migration snapshot differs from the live config.",
        "Inspect the migration journal and restore the last-known-good snapshot before retrying."
      );
    }
    return { snapshot, created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await atomicWrite(snapshot, content, options);
  return { snapshot, created: true };
}
