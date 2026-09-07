import path from "node:path";
import { randomUUID } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { UpdateError } from "../cli-common.mjs";
import { assertDestPathSafe } from "./manifest-walk.mjs";

function alive(owner) {
  const pid = Number(String(owner).split("\n")[0]);
  if (!Number.isInteger(pid) || pid < 1) return true; // unknown owner: fail closed
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}
const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

/** Single workspace writer; stale owners are reclaimed under a separate exclusive guard. */
export async function withUpdateLock(repo, action) {
  const lock = path.join(repo, ".aios/update.lock");
  const guard = `${lock}.reclaim`;
  const owner = `${process.pid}\n${randomUUID()}\n`;
  for (const file of [lock, guard])
    assertDestPathSafe(repo, path.relative(repo, file), "lock workspace update");
  mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const scratch = `${lock}.${randomUUID()}.tmp`;
  writeFileSync(scratch, owner, { flag: "wx", mode: 0o600 });
  const claim = (file) => {
    try {
      linkSync(scratch, file);
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  };
  let held = false;
  try {
    for (let attempt = 0; attempt < 3 && !held; attempt++) {
      if (claim(lock)) {
        held = true;
        break;
      }
      const previous = read(lock);
      if (previous === null) continue;
      if (alive(previous))
        throw new UpdateError("Another workspace update is active; retry after it finishes.");
      if (!claim(guard))
        throw new UpdateError(
          "Update lock recovery is already active. If its recorded owner has exited, remove .aios/update.lock.reclaim and re-run."
        );
      try {
        const current = read(lock);
        if (current !== null && !alive(current)) rmSync(lock);
      } finally {
        if (read(guard) === owner) rmSync(guard);
      }
    }
    if (!held)
      throw new UpdateError(
        "Could not acquire the workspace update lock; retry after the other update finishes."
      );
    return await action();
  } finally {
    if (held && read(lock) === owner) rmSync(lock);
    rmSync(scratch, { force: true });
  }
}
