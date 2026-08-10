/**
 * update/manifest-walk.mjs — walking MANAGED_PATHS/SEED_IF_ABSENT manifest entries into
 * concrete file lists, and the containment safety every destination the vendor step could
 * touch must pass BEFORE it is read, written, or deleted.
 *
 * Invariant this module owns: every destRel this file's functions hand back has already been
 * checked against `assertDestPathSafe` (or is about to be, at the caller's write site) — a
 * `../` traversal, a symlinked parent directory, or a symlinked destination itself can never
 * silently redirect a managed read/write/delete outside the workspace root. The enumeration
 * helpers (`entryFiles`, `deletionCandidates`, `plannedDestRels`, `missingSeedPaths`,
 * `conflictMarkerPaths`) are the SAME enumeration the write loop in `update/merge.mjs` uses,
 * so a pre-flight scan can never cover a different set than what actually gets touched.
 *
 * Extracted verbatim from scripts/update.mjs (AIO-557); no logic changed.
 */
import path from "node:path";
import { existsSync, readFileSync, statSync, readdirSync, lstatSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { gitEnv, UpdateError } from "../cli-common.mjs";
import { MANAGED_PATHS, SEED_IF_ABSENT } from "../toolkit-manifest.mjs";
import { lsTree } from "../toolkit-merge.mjs";

/**
 * Managed dest paths (repo-relative, forward-slash) that have UNCOMMITTED changes in the
 * workspace. Overwriting these would destroy local work that has no git object to recover
 * from — so the sync skips them and tells the owner to commit or `git checkout --` first.
 * (Committed local edits are reconciled by the 3-way merge in toolkit-merge.mjs.)
 */
export function dirtyManagedPaths(repo, managedPaths = MANAGED_PATHS) {
  try {
    const out = execFileSync(
      "git",
      ["-C", repo, "status", "--porcelain", "--", ...managedPaths.map((e) => e.dest)],
      { encoding: "utf8", env: gitEnv() }
    );
    const set = new Set();
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      // porcelain: "XY <path>"; renames show "XY old -> new" — take the destination.
      const p = line.slice(3).trim();
      set.add(p.includes(" -> ") ? p.split(" -> ").pop() : p);
    }
    return set;
  } catch {
    return new Set(); // not a git repo (or git absent) — no guard available
  }
}

export const readIf = (p) =>
  existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : undefined;

/** Like `existsSync`, but a dangling symlink still counts as an occupied personal path. */
export function pathEntryExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Refuse a destination path that escapes the workspace root (a `../` traversal, a
 * symlinked parent directory, or a final destination that is itself a symlink). Applies
 * to every managed write/delete AND seed, not just seeds.
 *
 * SCOPE — accident prevention, not a security boundary. The toolkit source
 * (`--from`/`$AIOS_TOOLKIT_DIR`) is TRUSTED CODE: apply mode executes the pinned
 * snapshot's own `scripts/aios.mjs`, so a genuinely malicious source runs arbitrary code
 * before any containment check could matter — no check here can defend against that, and
 * none claims to. What this DOES protect against is real: a mistaken manifest entry
 * (`dest: "../something"` from a bad edit or merge) and workspace-side symlinks
 * (`.claude/rules -> ~/dotfiles/...`) silently redirecting managed writes outside the
 * repo the update believes it is operating on.
 *
 * Throws `UpdateError` — these refusals are EXPECTED failures (a workspace-side symlink is
 * a diagnosable local condition, not a bug), so they must flow through cmdUpdate's
 * structured-result contract (`applyAllowed: false` + a reason) instead of escaping as a
 * raw crash from `--check` or killing the vendor child without a result file.
 */
export function assertDestPathSafe(repo, destRel, verb = "vendor") {
  const root = path.resolve(repo);
  const destAbs = path.resolve(root, destRel);
  if (destAbs !== root && !destAbs.startsWith(root + path.sep)) {
    throw new UpdateError(`refusing to ${verb} path outside the workspace: ${destRel}`);
  }
  const parentRel = path.relative(root, path.dirname(destAbs));
  let current = root;
  for (const part of parentRel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new UpdateError(
        `refusing to ${verb} ${destRel}: parent path is not a real workspace directory (${path.relative(root, current)})`
      );
    }
  }

  // writeFileSync/unlinkSync follow a final-component symlink even when every parent is a
  // real directory. Reject the destination entry itself before any managed read/write so
  // `scripts/aios.mjs -> /tmp/shared` cannot redirect an update outside the workspace.
  try {
    if (lstatSync(destAbs).isSymbolicLink()) {
      throw new UpdateError(`refusing to ${verb} ${destRel}: destination is a symlink`);
    }
  } catch (error) {
    if (error instanceof UpdateError || error?.code !== "ENOENT") throw error;
  }
}

/**
 * Every toolkit file under an entry, as { srcRel, destRel } (files only). Traversal
 * failures (permission-denied subdirectory, a file disappearing mid-scan) are NOT caught
 * here — they propagate to the caller. `conflictMarkerPathsChecked` below is the one place
 * that must treat any such failure as an inspection error, not a silent skip; every other
 * caller (mergeManaged's own entryFiles use) is fine letting a genuine filesystem error
 * throw, since those already run inside `cmdVendorApplyOnly`'s single outer error boundary.
 */
export function entryFiles(srcRoot, entry) {
  const absSrc = path.join(srcRoot, entry.src);
  if (!existsSync(absSrc)) return [];
  if (entry.kind !== "dir") return [{ srcRel: entry.src, destRel: entry.dest }];
  const exclude = new Set(entry.exclude || []);
  const out = [];
  const walk = (dir, sub) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = sub ? `${sub}/${name}` : name;
      // An excluded name prunes the whole subtree, not just a file of that name. Listing a
      // DIRECTORY in `exclude` (AIO-844 needs `.claude/skills/aios-linear`) only works if the
      // check happens BEFORE recursing — the alternative, naming that skill's four files
      // one by one, silently leaks a fifth file added to it later.
      if (exclude.has(rel)) continue;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else out.push({ srcRel: `${entry.src}/${rel}`, destRel: `${entry.dest}/${rel}` });
    }
  };
  walk(absSrc, "");
  return out;
}

// A git conflict OPENER/divider/closer at line start — labelled (as git writes them,
// "<<<<<<< HEAD") or bare (label-less, as some tools / manual edits produce). Requires ALL
// THREE markers present in the file, not just an opener — an isolated `<<<<<<<` (e.g. a doc
// example) must never flag, but every REAL conflict (including diff3, which adds `|||||||`
// but keeps the standard three) always has all three.
const OPENER = /^<{7}(?: |\t|\r?$)/m;
const DIVIDER = /^={7}\r?$/m;
const CLOSER = /^>{7}(?: |\t|\r?$)/m;
function hasConflictMarkers(content) {
  return OPENER.test(content) && DIVIDER.test(content) && CLOSER.test(content);
}

/** Every entry bucket `conflictMarkerPathsChecked` scans — both MANAGED_PATHS (what apply
 *  actually vendors) and SEED_IF_ABSENT (what applySeeds copies) need the same protection;
 *  a marker in a seed-only source file was previously invisible to any conflict check. */
function markerScanEntries(managedPaths) {
  return [...managedPaths, ...SEED_IF_ABSENT];
}

/**
 * Managed/seed SOURCE files (relative paths) that contain conflict markers in their
 * CONTENT. The unmerged-index check (toolkit-pull `unmergedPaths`) only sees UNMERGED
 * entries; a staged or hand-authored marker leaves the index clean, so this reads the
 * bytes about to be vendored. Governance files are executed/parsed downstream — a marker
 * must never reach them.
 *
 * Returns `{ paths, errors }` — NOT just paths. A traversal/stat/read failure anywhere
 * (permission-denied subdirectory, a file disappearing mid-scan) is an inspection ERROR,
 * not a silent skip: `vendorSafety` must treat "couldn't fully check" as unsafe, exactly
 * like "found a marker". Only a genuinely absent manifest-entry root (this toolkit version
 * doesn't ship that bucket at all) is a normal, non-error skip.
 */
export function conflictMarkerPaths(srcRoot, managedPaths = MANAGED_PATHS) {
  const paths = [];
  const errors = [];
  for (const entry of markerScanEntries(managedPaths)) {
    if (!existsSync(path.join(srcRoot, entry.src))) continue;
    let files;
    try {
      files = entryFiles(srcRoot, entry); // can throw: readdirSync/statSync mid-traversal
    } catch (e) {
      errors.push(`couldn't list ${entry.src}: ${e.message}`);
      continue;
    }
    for (const f of files) {
      let content;
      try {
        content = readFileSync(path.join(srcRoot, f.srcRel), "utf8");
      } catch (e) {
        errors.push(`couldn't read ${f.srcRel}: ${e.message}`);
        continue;
      }
      if (hasConflictMarkers(content)) paths.push(f.srcRel);
    }
  }
  return { paths, errors };
}

/** Seed destinations that the toolkit can supply and the workspace does not have. */
export function missingSeedPaths(srcRoot, repo) {
  const missing = [];
  for (const entry of SEED_IF_ABSENT) {
    if (!existsSync(path.join(srcRoot, entry.src))) continue;
    for (const file of entryFiles(srcRoot, entry)) {
      assertDestPathSafe(repo, file.destRel, "seed");
      if (!pathEntryExists(path.join(repo, file.destRel))) missing.push(file.destRel);
    }
  }
  return missing;
}

/**
 * Files a dir entry would DELETE from the workspace: present at baseSha, gone from the
 * current source, and not excluded. THE one enumeration of deletion targets — shared by
 * applyDeletions (the write loop) and plannedDestRels (the pre-flight containment scan),
 * so the scan can never cover a different deletion set than the loop actually touches.
 * Returns [{ srcRel, destRel }].
 */
export function deletionCandidates(toolkitDir, srcRoot, entry, baseSha) {
  const baseFiles = lsTree(toolkitDir, baseSha, entry.src); // srcRel paths at base
  if (!baseFiles.length) return [];
  // Exact-or-prefix, mirroring entryFiles: an `exclude` naming a DIRECTORY covers everything
  // beneath it, so a file removed from an excluded subtree is never reported as an upstream
  // deletion for a workspace that was never supposed to receive it.
  const exclude = (entry.exclude || []).map((rel) => `${entry.src}/${rel}`);
  const isExcluded = (srcRel) => exclude.some((x) => srcRel === x || srcRel.startsWith(`${x}/`));
  const present = new Set(entryFiles(srcRoot, entry).map((f) => f.srcRel));
  const out = [];
  for (const srcRel of baseFiles) {
    if (isExcluded(srcRel)) continue; // excluded files are never synced — never "deleted" either
    if (present.has(srcRel)) continue; // still shipped — not a deletion
    out.push({ srcRel, destRel: entry.dest + srcRel.slice(entry.src.length) });
  }
  return out;
}

/**
 * EVERY workspace-relative destination a vendor apply could possibly touch — the complete
 * write+delete set, enumerated as data BEFORE anything executes:
 *   - each managed/seed file's destRel (writes);
 *   - each managed file's two conflict sidecars (`.aios-incoming`/`.aios-merge` — written
 *     on merge conflicts and no-base fallbacks);
 *   - each dir entry's upstream-deletion targets (present at baseSha, gone from src —
 *     via the same `deletionCandidates` enumeration applyDeletions itself iterates);
 *   - each `prunablePaths` entry's files (config-gated removals — the pmTool prune pass).
 * This is what makes the pre-flight containment scan genuinely all-or-nothing: it derives
 * from the same helpers the write loop calls (`entryFiles`, `deletionCandidates`), so the
 * scanned set and the touched set cannot drift. Exported for tests.
 */
export function plannedDestRels(srcDir, baseSha, managedPaths = MANAGED_PATHS, prunablePaths = []) {
  const out = [];
  // Prune targets are deletes, so they need no sidecars — but they DO have to be in the scan:
  // applyPrune calls assertDestPathSafe, and the pre-flight must cover every path the write
  // loop can touch, in both directions.
  for (const entry of prunablePaths) {
    if (!existsSync(path.join(srcDir, entry.src))) continue;
    for (const file of entryFiles(srcDir, entry)) out.push(file.destRel);
  }
  for (const entry of managedPaths) {
    // Mirror mergeManaged's own entry guard EXACTLY: when an entry's src is absent from
    // the snapshot, the write loop skips the whole entry — writes AND deletions. Without
    // this guard the scan would enumerate baseSha "deletions" for an entry the loop never
    // touches, and a stale symlink under a dir the toolkit dropped entirely would refuse
    // an apply that was never going to go near it. The scanned set must equal the touched
    // set in BOTH directions.
    if (!existsSync(path.join(srcDir, entry.src))) continue;
    for (const file of entryFiles(srcDir, entry)) {
      out.push(file.destRel, `${file.destRel}.aios-incoming`, `${file.destRel}.aios-merge`);
    }
    if (entry.kind === "dir") {
      // In cmdVendorApplyOnly the snapshot IS the toolkit checkout (toolkitDir === srcRoot),
      // so the snapshot's own history serves the baseSha lsTree.
      for (const { destRel } of deletionCandidates(srcDir, srcDir, entry, baseSha)) {
        out.push(destRel);
      }
    }
  }
  for (const entry of SEED_IF_ABSENT) {
    for (const file of entryFiles(srcDir, entry)) out.push(file.destRel);
  }
  return out;
}
