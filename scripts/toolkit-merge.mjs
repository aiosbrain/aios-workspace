/**
 * toolkit-merge.mjs — 3-way merge primitives for `aios update`.
 *
 * The overlay (PR #252) overwrites toolkit-managed files wholesale, which silently
 * regresses a file the workspace improved locally (the granola 1.1.0→1.0.0 case). A
 * 3-way merge fixes that: with the toolkit content at the LAST-SYNCED sha as the merge
 * **base**, we can tell "the workspace edited this" from "the workspace is just stale"
 * and only surface genuine both-sides divergence — exactly like `git merge`.
 *
 *   base   = toolkit file at the workspace's pinned .aios-toolkit-version sha
 *   mine   = the workspace's current file
 *   theirs = the toolkit's new file
 *
 * decideMerge() is the pure decision table (no I/O — fully unit-testable). threeWayMerge()
 * shells `git merge-file` for the one case that needs a real merge. gitShow()/lsTree()
 * retrieve base content + base file lists from the toolkit checkout at the pinned sha.
 *
 * Zero dependencies beyond git + Node stdlib.
 */

import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv } from "./cli-common.mjs";

/**
 * Pure decision for a single file given the three versions (undefined = absent).
 * Deletion (theirs === undefined) is handled by the caller's deletion pass, not here.
 * Returns one of: noop | create | fallback | take-theirs | keep-mine | merge.
 */
export function decideMerge({ base, mine, theirs }) {
  if (mine === theirs) return "noop"; // already identical (covers both-absent)
  if (mine === undefined) return "create"; // new toolkit file, nothing local to protect
  if (base === undefined) return "fallback"; // no baseline — caller decides (surface, don't guess)
  if (base === mine) return "take-theirs"; // workspace didn't touch it → clean update
  if (base === theirs) return "keep-mine"; // toolkit didn't change it → keep local edit
  return "merge"; // all three differ → real 3-way merge
}

/**
 * 3-way content merge via `git merge-file -p`. Returns { clean, content } where content
 * is the merged text — with conflict markers when clean === false. Never mutates inputs.
 */
export function threeWayMerge(base, mine, theirs, labels = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "aios-merge-"));
  try {
    const b = path.join(dir, "base");
    const m = path.join(dir, "mine");
    const t = path.join(dir, "theirs");
    writeFileSync(b, base);
    writeFileSync(m, mine);
    writeFileSync(t, theirs);
    const args = [
      "merge-file",
      "-p",
      "-L",
      labels.mine || "your version",
      "-L",
      labels.base || "last synced (base)",
      "-L",
      labels.theirs || "toolkit version",
      "--",
      m,
      b,
      t,
    ];
    try {
      const out = execFileSync("git", args, { encoding: "utf8" });
      return { clean: true, content: out };
    } catch (e) {
      // Non-zero exit == number of conflicts; stdout still holds the marked-up merge.
      return { clean: false, content: typeof e.stdout === "string" ? e.stdout : "" };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Toolkit file content at a sha, or undefined if the path/sha isn't retrievable.
 *
 * A missing path/sha is the EXPECTED "no-base" case (e.g. a file added after the
 * workspace's pinned sha) — git writes a `fatal: path ... exists on disk, but not
 * in <sha>` line straight to stderr for that, which would otherwise leak past the
 * caller's try/catch onto the user's terminal. `stdio: ["pipe","pipe","pipe"]`
 * keeps that noise captured (on `e.stderr`) instead of inherited.
 */
export function gitShow(toolkitDir, sha, relPath) {
  if (!sha || sha === "unknown") return undefined;
  try {
    // gitEnv(): this is the 3-way merge's BASE content — an inherited GIT_DIR would
    // silently source the baseline from another repository.
    return execFileSync("git", ["-C", toolkitDir, "show", `${sha}:${relPath}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: gitEnv(),
    });
  } catch {
    return undefined; // sha not present (shallow clone) or path didn't exist then
  }
}

/** File paths (repo-relative) under a prefix at a sha; [] if unavailable. */
export function lsTree(toolkitDir, sha, prefix) {
  if (!sha || sha === "unknown") return [];
  try {
    const out = execFileSync(
      "git",
      ["-C", toolkitDir, "ls-tree", "-r", "--name-only", sha, "--", prefix],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env: gitEnv() }
    );
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
