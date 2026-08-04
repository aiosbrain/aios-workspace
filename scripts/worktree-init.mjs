#!/usr/bin/env node
/**
 * Prepare the primary checkout's shared dependencies before a worktree links
 * node_modules. A partial primary install otherwise makes every worktree look
 * hydrated while local tools such as prettier and tsc are still unavailable.
 */

import path from "node:path";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function readJson(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is unreadable: ${detail}`);
  }
}

/** Root packages npm must install, sourced from package-lock.json rather than package.json. */
export function lockedRootDependencies(primary) {
  const lockPath = path.join(primary, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  const lock = readJson(lockPath, lockPath);
  const root = lock.packages?.[""];
  if (!root) throw new Error(`${lockPath} has no root packages entry`);
  return [
    ...new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
    ]),
  ].sort();
}

function installedPackageMatches(primary, lock, name) {
  const packageDir = path.join(primary, "node_modules", ...name.split("/"));
  const lockEntry = lock.packages?.[`node_modules/${name}`];
  if (!lockEntry || !existsSync(packageDir)) return false;
  if (lockEntry.link) return true;
  const manifestPath = path.join(packageDir, "package.json");
  if (!existsSync(manifestPath)) return false;
  try {
    return readJson(manifestPath, manifestPath).version === lockEntry.version;
  } catch {
    return false;
  }
}

export function missingLockedRootDependencies(primary) {
  const names = lockedRootDependencies(primary);
  if (names === null) return null;
  const lock = readJson(path.join(primary, "package-lock.json"), "package-lock.json");
  return names.filter((name) => !installedPackageMatches(primary, lock, name));
}

function runNpmCi(primary) {
  return spawnSync("npm", ["ci", "--include=dev", "--no-audit", "--no-fund"], {
    cwd: primary,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
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
    `[aios] shared node_modules is incomplete (${missing.join(", ")}); restoring with npm ci …`
  );
  const result = install(primary);
  if (result?.error || result?.status !== 0) {
    const detail = result?.error?.message ?? `exit ${result?.status ?? "unknown"}`;
    throw new Error(
      `npm ci could not restore shared dependencies (${detail}). ` +
        `Run \`npm ci --include=dev\` in ${primary}, then retry worktree hydration.`
    );
  }
  const stillMissing = missingLockedRootDependencies(primary) ?? [];
  if (stillMissing.length > 0) {
    throw new Error(
      `npm ci completed but shared dependencies are still incomplete: ${stillMissing.join(", ")}. ` +
        `Run \`npm ci --include=dev\` in ${primary}, then retry worktree hydration.`
    );
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
  const missing = missingLockedRootDependencies(resolvedPrimary);
  if (missing?.length) restoreSharedDependencies(resolvedPrimary, missing, install);
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
