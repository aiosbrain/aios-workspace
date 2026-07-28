/**
 * update/merge.mjs — the 3-way merge decision and apply step for the managed/seed file set,
 * plus the vendorSafety gate that must hold before any of it runs.
 *
 * Invariant this module owns: a committed local edit is MERGED with the toolkit's incoming
 * change (or surfaced as a conflict), never silently clobbered — and a genuine conflict is
 * NEVER written inline into the live file (it may be executed/parsed downstream). The
 * toolkit version lands at `<file>.aios-incoming` and the marked-up merge at
 * `<file>.aios-merge`; the live file keeps `mine` until the conflict is resolved. `force`
 * is the one deliberate escape hatch (overwrite with the toolkit version, propagate
 * deletions) and is never implied by any other flag.
 *
 * Extracted verbatim from scripts/update.mjs (AIO-557); no logic changed.
 */
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  unlinkSync,
  copyFileSync,
  constants as fsConstants,
} from "node:fs";
import path from "node:path";
import { decideMerge, threeWayMerge, gitShow } from "../toolkit-merge.mjs";
import { unmergedPaths } from "../toolkit-pull.mjs";
import { MANAGED_PATHS, SEED_IF_ABSENT } from "../toolkit-manifest.mjs";
import {
  readIf,
  pathEntryExists,
  assertDestPathSafe,
  entryFiles,
  deletionCandidates,
  conflictMarkerPaths,
} from "./manifest-walk.mjs";

/**
 * The single owner of "is `srcRoot` safe to vendor from": no unmerged git-index entries,
 * no managed/seed file containing a conflict marker, and no inspection failure anywhere
 * along the way. FAIL-CLOSED: an uninspectable git index or filesystem is exactly as
 * unsafe as a real conflict — `unmergedPaths` now THROWS on a genuine git failure
 * (toolkit-pull.mjs) instead of the old swallow-to-empty-array behavior, and
 * `conflictMarkerPaths`'s own traversal/read errors are surfaced the same way.
 *
 * Called identically by `--check`/`--preview` (against the live source — inherently
 * point-in-time, same honest scope as remote-state classification) and by
 * `cmdVendorApplyOnly` (against the pinned, immutable snapshot — the authoritative,
 * TOCTOU-immune final gate before any workspace write).
 */
export function vendorSafety(srcRoot) {
  const errors = [];
  let unmerged = [];
  try {
    unmerged = unmergedPaths(srcRoot);
  } catch (e) {
    errors.push(`couldn't inspect the git index: ${e.message}`);
  }
  const { paths: markerHits, errors: markerErrors } = conflictMarkerPaths(srcRoot);
  errors.push(...markerErrors);
  const paths = [...new Set([...unmerged, ...markerHits])];
  return { safe: paths.length === 0 && errors.length === 0, paths, errors };
}

/** One-line summary of a vendorSafety() result for a "reasons" array — never assumes
 *  the caller already knows which branch (conflict vs. inspection error) fired. */
export function vendorSafetyReason(vs) {
  if (vs.errors.length) return `couldn't fully inspect the toolkit for safety (${vs.errors[0]})`;
  return `the toolkit has ${vs.paths.length} file(s) with conflict markers (e.g. ${vs.paths[0]})`;
}

/**
 * Copy seed files only into absent destinations. Deliberately does not accept `force`
 * or a merge base: once a personal destination exists, update has no authority over it.
 */
function applySeeds(srcRoot, repo, r, { dryRun = false } = {}) {
  for (const entry of SEED_IF_ABSENT) {
    if (!existsSync(path.join(srcRoot, entry.src))) continue;
    for (const file of entryFiles(srcRoot, entry)) {
      assertDestPathSafe(repo, file.destRel, "seed");
      const destAbs = path.join(repo, file.destRel);
      if (pathEntryExists(destAbs)) continue;
      if (dryRun) {
        r.seeded.push(file.destRel);
        continue;
      }
      mkdirSync(path.dirname(destAbs), { recursive: true });
      // COPYFILE_EXCL closes the check/copy race: a concurrently-created personal
      // file makes update fail safely instead of being overwritten.
      try {
        copyFileSync(path.join(srcRoot, file.srcRel), destAbs, fsConstants.COPYFILE_EXCL);
      } catch (error) {
        if (error?.code === "EEXIST") continue;
        throw error;
      }
      if (entry.exec) chmodSync(destAbs, 0o755);
      r.seeded.push(file.destRel);
    }
  }
}

/** Apply one file's merge decision. Mutates the workspace; records into `r`. */
function applyFile(
  { toolkitDir, srcRoot, repo, baseSha, entry, srcRel, destRel, force, dryRun },
  r
) {
  // destRel is only as trustworthy as the manifest that produced it — see
  // assertDestPathSafe's doc comment. Validated before any read/write, not just for the
  // final write, so a malicious entry can't even probe `mine`'s existence outside the repo.
  assertDestPathSafe(repo, destRel);
  const destAbs = path.join(repo, destRel);
  const theirs = readIf(path.join(srcRoot, srcRel));
  const mine = readIf(destAbs);
  const write = (content) => {
    if (dryRun) return;
    mkdirSync(path.dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, content);
    if (entry.exec) chmodSync(destAbs, 0o755);
  };
  const writeSidecar = (suffix, content) => {
    const sidecarRel = `${destRel}${suffix}`;
    assertDestPathSafe(repo, sidecarRel, "write conflict sidecar");
    if (!dryRun) writeFileSync(path.join(repo, sidecarRel), content);
  };

  if (force) {
    if (theirs !== undefined && theirs !== mine) {
      write(theirs);
      r.updated.push(destRel);
    }
    return;
  }

  const base = gitShow(toolkitDir, baseSha, srcRel);
  const action = decideMerge({ base, mine, theirs });
  switch (action) {
    case "noop":
    case "keep-mine":
      return;
    case "create":
      write(theirs);
      r.created.push(destRel);
      return;
    case "take-theirs":
      write(theirs);
      r.updated.push(destRel);
      return;
    case "fallback":
      // No baseline to reason from — surface rather than silently overwrite.
      writeSidecar(".aios-incoming", theirs);
      r.conflicts.push({ path: destRel, kind: "no-base" });
      return;
    case "merge": {
      const { clean, content } = threeWayMerge(base, mine, theirs, {
        mine: `${destRel} (your version)`,
        base: "last synced (base)",
        theirs: `${destRel} (toolkit)`,
      });
      if (clean) {
        write(content);
        r.merged.push(destRel);
      } else {
        // Never write markers into the live file — it may be executed/parsed. Leave
        // `mine` in place; drop the toolkit version + the marked-up merge beside it.
        writeSidecar(".aios-incoming", theirs);
        writeSidecar(".aios-merge", content);
        r.conflicts.push({ path: destRel, kind: "merge" });
      }
      return;
    }
  }
}

/** Propagate upstream deletions/renames for a dir entry (files gone since baseSha). */
function applyDeletions({ toolkitDir, srcRoot, repo, baseSha, entry, force, dryRun }, r) {
  for (const { srcRel, destRel } of deletionCandidates(toolkitDir, srcRoot, entry, baseSha)) {
    assertDestPathSafe(repo, destRel, "delete");
    const destAbs = path.join(repo, destRel);
    const mine = readIf(destAbs);
    if (mine === undefined) continue; // already gone locally
    const base = gitShow(toolkitDir, baseSha, srcRel);
    if (force || mine === base) {
      if (!dryRun) unlinkSync(destAbs); // untouched locally → propagate the removal
      r.deleted.push(destRel);
    } else {
      r.conflicts.push({ path: destRel, kind: "deleted-upstream" }); // modified + removed
    }
  }
}

/**
 * 3-way merge every managed path from `srcRoot` (a toolkit checkout at `toolkitDir`, whose
 * pinned base is `baseSha`) into `repo`. Committed local edits are merged, not clobbered;
 * genuine conflicts are surfaced (never written inline). Dirty (uncommitted) files are
 * skipped up front. `force` overwrites with the toolkit version and propagates deletions.
 * Returns per-category path lists. Exported for tests.
 */
export function mergeManaged(toolkitDir, srcRoot, repo, baseSha, opts = {}) {
  const dirty = opts.dirty || new Set();
  const force = !!opts.force;
  const dryRun = !!opts.dryRun;
  const r = {
    created: [],
    seeded: [],
    updated: [],
    merged: [],
    deleted: [],
    conflicts: [],
    skippedDirty: [],
  };
  for (const entry of MANAGED_PATHS) {
    if (!existsSync(path.join(srcRoot, entry.src))) continue;
    for (const f of entryFiles(srcRoot, entry)) {
      if (dirty.has(f.destRel)) {
        r.skippedDirty.push(f.destRel);
        continue;
      }
      applyFile({ toolkitDir, srcRoot, repo, baseSha, entry, ...f, force, dryRun }, r);
    }
    if (entry.kind === "dir")
      applyDeletions({ toolkitDir, srcRoot, repo, baseSha, entry, force, dryRun }, r);
  }
  applySeeds(srcRoot, repo, r, { dryRun });
  return r;
}
