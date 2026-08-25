import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AiosError } from "./errors.mjs";

const bytes = (value) => (Buffer.isBuffer(value) ? value : Buffer.from(String(value)));

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
  await assertNotSymlink(directory, { fs: io });
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
    await io.rename(temporary, target);
    const directorySync = await syncDirectory(directory, io);
    return { target, directorySync };
  } catch (error) {
    await handle?.close().catch(() => {});
    await io.rm(temporary, { force: true }).catch(() => {});
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
