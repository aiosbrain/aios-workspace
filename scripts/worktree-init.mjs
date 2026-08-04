#!/usr/bin/env node
/**
 * Prepare the primary checkout's shared dependencies before a worktree links
 * node_modules. A partial primary install otherwise makes every worktree look
 * hydrated while local tools such as prettier and tsc are still unavailable.
 */

import path from "node:path";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is unreadable: ${detail}`);
  }
}

const LOCK_WAIT_MS = 120_000;
const LOCK_POLL_MS = 100;
const RECLAIM_GUARD_STALE_MS = 5_000;
const RECLAIM_GUARD_ATTEMPTS = 8;
const EMPTY_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

/** Required packages npm must install, sourced from package-lock.json. */
export function lockedDependencies(primary) {
  const lockPath = path.join(primary, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  const lock = readJson(lockPath, lockPath);
  if (!lock.packages?.[""]) throw new Error(`${lockPath} has no root packages entry`);
  return Object.entries(lock.packages)
    .filter(
      ([key, entry]) =>
        key.startsWith("node_modules/") && (!entry?.optional || optionalPackageApplies(entry))
    )
    .sort(([left], [right]) => left.localeCompare(right));
}

function constraintMatches(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true;
  const positives = values.filter((value) => !String(value).startsWith("!"));
  return !values.includes(`!${current}`) && (positives.length === 0 || positives.includes(current));
}

function currentLibc() {
  if (process.platform !== "linux") return null;
  try {
    return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    return null;
  }
}

function optionalPackageApplies(entry) {
  const constrained = entry.os || entry.cpu || entry.libc;
  if (!constrained) return false;
  const libc = currentLibc();
  return (
    constraintMatches(entry.os, process.platform) &&
    constraintMatches(entry.cpu, process.arch) &&
    (!entry.libc || (libc !== null && constraintMatches(entry.libc, libc)))
  );
}

function binNames(lockEntry, manifest) {
  if (typeof lockEntry.bin === "string") {
    return [
      [
        String(manifest.name ?? "")
          .split("/")
          .pop(),
        lockEntry.bin,
      ],
    ];
  }
  return Object.entries(lockEntry.bin ?? {});
}

function binDirectory(primary, lockKey) {
  const marker = "node_modules/";
  const index = lockKey.lastIndexOf(marker);
  return path.join(primary, lockKey.slice(0, index + marker.length - 1), ".bin");
}

function installedPackageProblem(primary, lockKey, lockEntry) {
  const packageDir = path.join(primary, lockKey);
  if (!existsSync(packageDir)) return `${lockKey} (missing)`;
  if (lockEntry.link) return null;
  const manifestPath = path.join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return `${lockKey}/package.json (missing)`;
  try {
    const manifest = readJson(manifestPath, manifestPath);
    if (manifest.version !== lockEntry.version) return `${lockKey} (wrong version)`;
    for (const [name, target] of binNames(lockEntry, manifest)) {
      if (!name || !existsSync(path.resolve(packageDir, target))) {
        return `${lockKey} (missing binary target ${name || "unnamed"})`;
      }
      const binDir = binDirectory(primary, lockKey);
      const shims = process.platform === "win32" ? [`${name}.cmd`, `${name}.ps1`] : [name];
      const shimExists = shims.some((candidate) => existsSync(path.join(binDir, candidate)));
      if (!shimExists) return `${lockKey} (missing .bin/${name})`;
    }
    return null;
  } catch {
    return `${lockKey}/package.json (invalid)`;
  }
}

export function missingLockedDependencies(primary) {
  const packages = lockedDependencies(primary);
  if (packages === null) return null;
  return packages
    .map(([lockKey, entry]) => installedPackageProblem(primary, lockKey, entry))
    .filter(Boolean);
}

function runNpmCi(primary) {
  return spawnSync(
    "npm",
    ["ci", "--include=dev", "--include=optional", "--no-audit", "--no-fund"],
    {
      cwd: primary,
      stdio: "inherit",
      shell: process.platform === "win32",
    }
  );
}

function restoreSharedDependencies(primary, missing, install) {
  const nodeModules = path.join(primary, "node_modules");
  try {
    if (lstatSync(nodeModules).isSymbolicLink()) {
      throw new Error("the primary checkout's node_modules is itself a symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  console.log(
    `[aios] shared node_modules is incomplete (${summarizeMissing(missing)}); restoring with npm ci …`
  );
  const result = install(primary);
  if (result?.error || result?.status !== 0) {
    const detail = result?.error?.message ?? `exit ${result?.status ?? "unknown"}`;
    throw new Error(
      `npm ci could not restore shared dependencies (${detail}). ` +
        `Run \`npm ci --include=dev --include=optional\` in ${primary}, then retry worktree hydration.`
    );
  }
  const stillMissing = missingLockedDependencies(primary) ?? [];
  if (stillMissing.length > 0) {
    throw new Error(
      `npm ci completed but shared dependencies are still incomplete: ${summarizeMissing(stillMissing)}. ` +
        `Run \`npm ci --include=dev --include=optional\` in ${primary}, then retry worktree hydration.`
    );
  }
}

function summarizeMissing(missing) {
  const visible = missing.slice(0, 5).join(", ");
  return missing.length > 5 ? `${visible}, and ${missing.length - 5} more` : visible;
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(lockPath) {
  try {
    return readJson(lockPath, "dependency lock owner");
  } catch {
    return null;
  }
}

function createOwnedFile(target, token) {
  const scratch = `${target}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(scratch, `${JSON.stringify({ pid: process.pid, token })}\n`, { mode: 0o600 });
  try {
    linkSync(scratch, target);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(scratch, { force: true });
  }
}

function releaseOwnedFile(target, token) {
  if (readOwner(target)?.token === token) rmSync(target, { force: true });
}

function acquireReclaimGuard(guardPath) {
  for (let attempt = 0; attempt < RECLAIM_GUARD_ATTEMPTS; attempt += 1) {
    const token = randomUUID();
    if (createOwnedFile(guardPath, token)) return token;
    let info;
    try {
      info = statSync(guardPath);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      return null;
    }
    if (Date.now() - info.mtimeMs < RECLAIM_GUARD_STALE_MS) return null;
    const captured = `${guardPath}.dead.${process.pid}.${randomUUID()}`;
    try {
      renameSync(guardPath, captured);
      rmSync(captured, { force: true });
    } catch {
      // Another waiter won the stale-guard recovery race; retry acquisition.
    }
  }
  return null;
}

function reclaimDeadOwner(lockPath, guardPath) {
  const guardToken = acquireReclaimGuard(guardPath);
  if (!guardToken) return false;
  try {
    const owner = readOwner(lockPath);
    if (owner && !processIsAlive(owner.pid)) {
      rmSync(lockPath, { force: true });
      return true;
    }
    return false;
  } finally {
    releaseOwnedFile(guardPath, guardToken);
  }
}

function acquireInstallLock(primary) {
  const lockPath = path.join(primary, ".aios", "worktree-dependencies.lock");
  const guardPath = `${lockPath}.reclaim`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    const token = randomUUID();
    if (createOwnedFile(lockPath, token)) {
      return () => releaseOwnedFile(lockPath, token);
    }
    const owner = readOwner(lockPath);
    if (owner && !processIsAlive(owner.pid) && reclaimDeadOwner(lockPath, guardPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for the shared dependency install lock at ${lockPath}; ` +
          "retry worktree hydration after the other install finishes"
      );
    }
    Atomics.wait(EMPTY_WAIT_BUFFER, 0, 0, LOCK_POLL_MS);
  }
}

function detachIncompleteSharedLink(primary, worktree) {
  const destination = path.join(worktree, "node_modules");
  try {
    if (!lstatSync(destination).isSymbolicLink()) return;
    unlinkSync(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function linkNodeModules(primary, worktree) {
  const source = path.join(primary, "node_modules");
  const destination = path.join(worktree, "node_modules");
  if (!existsSync(source)) return { status: "skipped", reason: "primary has no node_modules" };

  try {
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink()) {
      return { status: "skipped", reason: "worktree has a real node_modules" };
    }
    const current = path.resolve(worktree, readlinkSync(destination));
    if (current === source) return { status: "present", source };
    unlinkSync(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
  return { status: "linked", source };
}

/** Verify/repair the shared install first; only then expose it through the worktree. */
export function initializeWorktreeDependencies({ primary, worktree, install = runNpmCi }) {
  const resolvedPrimary = path.resolve(primary);
  const resolvedWorktree = path.resolve(worktree);
  const missing = missingLockedDependencies(resolvedPrimary);
  if (missing?.length) {
    detachIncompleteSharedLink(resolvedPrimary, resolvedWorktree);
    const releaseLock = acquireInstallLock(resolvedPrimary);
    try {
      const missingUnderLock = missingLockedDependencies(resolvedPrimary) ?? [];
      if (missingUnderLock.length) {
        restoreSharedDependencies(resolvedPrimary, missingUnderLock, install);
      }
    } finally {
      releaseLock();
    }
  }
  return linkNodeModules(resolvedPrimary, resolvedWorktree);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const primary = argumentValue("--primary");
  const worktree = argumentValue("--worktree");
  if (!primary || !worktree) {
    console.error("usage: worktree-init.mjs --primary <path> --worktree <path>");
    process.exit(2);
  }
  try {
    const result = initializeWorktreeDependencies({ primary, worktree });
    if (result.status === "linked") console.log(`linked node_modules -> ${result.source}`);
    else if (result.status === "present") console.log("skip node_modules — already linked");
    else console.log(`skip node_modules — ${result.reason}`);
  } catch (error) {
    console.error(`[aios] worktree dependency hydration failed: ${error.message || error}`);
    process.exit(1);
  }
}
