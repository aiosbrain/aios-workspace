/**
 * update.mjs — `aios update`: get the latest AIOS (the "auto-update like Claude" command).
 *
 * One command, two halves. First it brings the local toolkit checkout current and pins an
 * immutable snapshot of the result (git fetch + fast-forward + `npm ci`; see
 * toolkit-pull.mjs) — because the workspace CLI is a thin shim forwarding to that checkout,
 * a stale checkout means stale command code AND a re-vendor of stale governance. Then it
 * re-vendors FROM that pinned snapshot: a scaffolded workspace carries a COPY of the toolkit
 * (see toolkit-manifest.mjs), so update re-syncs MANAGED_PATHS, fills missing SEED_IF_ABSENT
 * starter files, and pins the version. Seeds are create-only: an existing personal file is
 * never read, merged, overwritten, or deleted, even with `--force`.
 *
 * The re-vendor is a **3-way merge**, not a blind overlay (see toolkit-merge.mjs): with the
 * toolkit at the last-synced sha as the base, a file the workspace improved locally is
 * MERGED with the toolkit's change (or surfaced as a conflict) rather than silently
 * overwritten — the granola-1.1.0 regression class. Upstream deletions/renames are
 * propagated only for files the workspace didn't touch.
 *
 *   aios update            # pull the toolkit + reinstall deps + 3-way-merge governance
 *   aios update --check    # dry-run: how far behind is the toolkit / this workspace? (no writes)
 *   aios update --preview  # classify every managed-file change (implies --no-pull; no writes/sidecars)
 *   aios update --dry-run  # alias for --preview (unless combined with --contribute, see below)
 *   aios update --no-pull  # skip the git pull + npm ci; only re-vendor governance
 *   aios update --stash    # auto-stash a dirty toolkit tree, pull, then restore it
 *   aios update --no-install  # skip `npm ci` even if the toolkit lockfile changed
 *   aios update --from DIR  # use a specific toolkit checkout as the source
 *   aios update --force    # take the toolkit version for everything (overwrite)
 *
 * Safety: a dirty toolkit tree is never clobbered (refuse, or --stash to stash+restore); a
 * non-fast-forward toolkit is refused, not auto-merged; a locally-uninspectable toolkit repo
 * (a git status/index/ref query itself failing) is refused, never treated as clean/current.
 * Managed files with UNCOMMITTED local changes in the WORKSPACE are skipped (never
 * clobbered). Conflicts are NEVER written inline (the files are executed/parsed) — the
 * toolkit version lands at <file>.aios-incoming and the marked-up merge at <file>.aios-merge;
 * the stamp stays at the old base until conflicts are resolved. Run inside the toolkit
 * checkout itself, update just pulls it (nothing to re-vendor into).
 *
 * The actual vendoring (merge + catalog generation + stamp write) never runs against the
 * live, mutable toolkit checkout — it always runs against an immutable `git worktree`
 * snapshot pinned at a specific commit (toolkit-pull.mjs's `createPinnedSnapshot`), via a
 * structurally non-recursive internal hand-off (`--vendor-apply-only`, see `cmdVendorApplyOnly`
 * below) — so nothing downstream of the pull can ever read a value that changed mid-operation,
 * and there is no recursion-guard state to get confused by (no env var, nothing ambient).
 *
 * Every expected failure (dirty tree, unresolved conflict, bad --from, unknown flag, ...)
 * throws `UpdateError` rather than exiting — caught exactly once, in `cmdUpdate` itself — so
 * `cmdUpdate`/`pullToolkitCheckout` are safely callable in-process by programmatic callers
 * (onboarding) and by tests, without ever risking `process.exit()`.
 *
 * Source resolution: --from DIR → $AIOS_TOOLKIT_DIR → the toolkit this CLI is executing from
 * (the checkout the workspace shim forwarded to — always the right one to pull/vendor) →
 * ~/Projects/aios/aios-workspace → `git clone` the canonical repo (aios.yaml `toolkit_repo`).
 *
 * Zero dependencies (git + npm + cp/rm shelled out; Node >= 18).
 */

import os from "node:os";
import path from "node:path";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  readdirSync,
  unlinkSync,
  copyFileSync,
  lstatSync,
  constants as fsConstants,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { c, UpdateError } from "./cli-common.mjs";
import { MANAGED_PATHS, SEED_IF_ABSENT, VERSION_FILE } from "./toolkit-manifest.mjs";
import { decideMerge, threeWayMerge, gitShow, lsTree } from "./toolkit-merge.mjs";
import { toolkitMeta } from "./toolkit-meta.mjs";
import { cmdContribute } from "./toolkit-contribute.mjs";
import {
  pullToolkitCheckout,
  unmergedPaths,
  sourceCleanliness,
  removePinnedSnapshot,
  remoteMessage,
} from "./toolkit-pull.mjs";

const DEFAULT_REPO = "https://github.com/aiosbrain/aios-workspace.git";

// The toolkit checkout this CLI is executing from — <toolkit>/scripts/update.mjs → <toolkit>.
// The workspace shim (scaffold/scripts/aios.mjs) may forward here via a relative path rather
// than $AIOS_TOOLKIT_DIR, so resolving from the running file guarantees update pulls/vendors
// the SAME checkout the user is actually running — not a different one on the default path.
const RUNNING_TOOLKIT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A dir is a toolkit checkout if it has the scaffold template + the CLI entrypoint. */
function looksLikeToolkit(dir) {
  return (
    !!dir &&
    existsSync(path.join(dir, "scripts", "aios.mjs")) &&
    existsSync(path.join(dir, "scaffold"))
  );
}

export function gitSha(dir) {
  try {
    // Full sha (not --short): the version stamp is a merge base for future syncs,
    // and a full sha survives shallow/ephemeral clones where short shas can collide.
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/**
 * Resolve a local toolkit checkout for read-only inspection — same candidates as
 * `resolveSource` (--from is caller-supplied, not applicable here; env var; the default
 * `~/Projects/aios/aios-workspace` path) but NEVER falls back to a network clone. Callers
 * that need a guaranteed dir (e.g. `aios update` itself) use `resolveSource`; callers that
 * just want to opportunistically compare versions (e.g. context-health) use this and treat
 * `null` as "signal unavailable" rather than triggering a clone as a side effect.
 */
export function resolveLocalToolkitDir(dir) {
  const candidates = [
    dir,
    process.env.AIOS_TOOLKIT_DIR,
    path.join(os.homedir(), "Projects", "aios", "aios-workspace"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (looksLikeToolkit(candidate)) return path.resolve(candidate);
  }
  return null;
}

/** Resolve the toolkit source dir. `stampSource` remains meaningful after the pinned worktree
 *  is removed: the live checkout path for local sources, or the clone URL for an ephemeral
 *  fallback. Throws UpdateError (never exits) on invalid input or an invalid clone. */
function resolveSource(args, cfg, warn) {
  // An explicit --from is a promise: if it isn't a toolkit, that's an error, not a
  // silent fall-through to some other source the user didn't ask for.
  const from = argValue(args, "--from");
  if (from && !looksLikeToolkit(from)) {
    throw new UpdateError(
      `--from ${from} doesn't look like an AIOS toolkit checkout ` +
        `(no scripts/aios.mjs + scaffold/). Point it at your aios-workspace clone.`
    );
  }
  const legacyCliDir = process.env.AIOS_TOOLKIT_CLI
    ? path.resolve(process.env.AIOS_TOOLKIT_CLI, "..", "..") // <dir>/scripts/aios.mjs → <dir>
    : undefined;
  const candidates = [
    from,
    process.env.AIOS_TOOLKIT_DIR,
    legacyCliDir, // deprecated alias — kept so existing custom-path configs don't break
    RUNNING_TOOLKIT, // the checkout this CLI runs from — matches whatever the shim forwarded to
    path.join(os.homedir(), "Projects", "aios", "aios-workspace"),
  ].filter(Boolean);
  for (const dir of candidates) {
    if (looksLikeToolkit(dir)) {
      const resolved = path.resolve(dir);
      return { dir: resolved, ephemeral: false, stampSource: resolved };
    }
  }
  // Fall back to cloning the canonical repo.
  const url = cfg?.toolkit_repo || DEFAULT_REPO;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aios-toolkit-"));
  warn(c.dim(`  no local toolkit found — cloning ${url} …`));
  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmp], { stdio: "ignore" });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw new UpdateError(
      `couldn't fetch the toolkit (${e.message}).\n` +
        `  Point at a local checkout: aios update --from /path/to/aios-workspace\n` +
        `  or set AIOS_TOOLKIT_DIR, or set toolkit_repo in aios.yaml.`
    );
  }
  if (!looksLikeToolkit(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
    throw new UpdateError(`cloned ${url} but it doesn't look like the AIOS toolkit`);
  }
  return { dir: tmp, ephemeral: true, stampSource: url };
}

/**
 * Managed dest paths (repo-relative, forward-slash) that have UNCOMMITTED changes in the
 * workspace. Overwriting these would destroy local work that has no git object to recover
 * from — so the sync skips them and tells the owner to commit or `git checkout --` first.
 * (Committed local edits are reconciled by the 3-way merge in toolkit-merge.mjs.)
 */
export function dirtyManagedPaths(repo) {
  try {
    const out = execFileSync(
      "git",
      ["-C", repo, "status", "--porcelain", "--", ...MANAGED_PATHS.map((e) => e.dest)],
      { encoding: "utf8" }
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

// ---------------------------------------------------------------------------
// 3-way merge — reconcile committed local edits instead of overwriting.
// (Unchanged by this refactor — always operates on a caller-supplied srcRoot, which for
// apply mode is always the pinned immutable snapshot, never the live toolkit checkout.)
// ---------------------------------------------------------------------------

const readIf = (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : undefined);

/** Like `existsSync`, but a dangling symlink still counts as an occupied personal path. */
function pathEntryExists(p) {
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
function entryFiles(srcRoot, entry) {
  const absSrc = path.join(srcRoot, entry.src);
  if (!existsSync(absSrc)) return [];
  if (entry.kind !== "dir") return [{ srcRel: entry.src, destRel: entry.dest }];
  const exclude = new Set(entry.exclude || []);
  const out = [];
  const walk = (dir, sub) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else if (!exclude.has(rel))
        out.push({ srcRel: `${entry.src}/${rel}`, destRel: `${entry.dest}/${rel}` });
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
function markerScanEntries() {
  return [...MANAGED_PATHS, ...SEED_IF_ABSENT];
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
export function conflictMarkerPaths(srcRoot) {
  const paths = [];
  const errors = [];
  for (const entry of markerScanEntries()) {
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
function vendorSafetyReason(vs) {
  if (vs.errors.length) return `couldn't fully inspect the toolkit for safety (${vs.errors[0]})`;
  return `the toolkit has ${vs.paths.length} file(s) with conflict markers (e.g. ${vs.paths[0]})`;
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
  const baseFiles = lsTree(toolkitDir, baseSha, entry.src); // srcRel paths at base
  if (!baseFiles.length) return;
  const exclude = new Set((entry.exclude || []).map((rel) => `${entry.src}/${rel}`));
  const present = new Set(entryFiles(srcRoot, entry).map((f) => f.srcRel));
  for (const srcRel of baseFiles) {
    if (exclude.has(srcRel)) continue; // excluded files are never synced — never "deleted" either
    if (present.has(srcRel)) continue; // still shipped — not a deletion
    const destRel = entry.dest + srcRel.slice(entry.src.length);
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

/** The `.aios-toolkit-version` body. Line 1 is the sha (parsed as the merge base). */
function stampBody(sha, meta, srcDir) {
  const lines = [sha, `toolkit-version ${meta.version}`];
  if (meta.brainApi) lines.push(`brain-api ${meta.brainApi}`);
  lines.push(`synced-at ${new Date().toISOString()}`, `source ${srcDir}`);
  return lines.join("\n") + "\n";
}

// Every flag `aios update` understands. Anything else is refused up front — in particular so
// the internal vendor hand-off can never silently drop a flag it doesn't recognize.
const UPDATE_BOOL_FLAGS = new Set([
  "--check",
  "--preview",
  "--no-pull",
  "--stash",
  "--no-install",
  "--force",
  "--dry-run", // alias for --preview UNLESS combined with --contribute (see cmdUpdate)
]);
// Recognized, but deliberately excluded from --help/the "supported:" error text — internal
// hand-off only, never meant to be typed by a user. See the exact allowlist check below.
const UPDATE_HIDDEN_BOOL_FLAGS = new Set(["--vendor-apply-only"]);
// --result-file: the vendor-apply-only child writes its structured result here as JSON.
// --stamp-source: the live checkout path (or clone URL for an ephemeral source) recorded in
// the workspace stamp; --from itself is the disposable pinned snapshot and must not be stamped.
// `stdio: "inherit"` gives the user live progress output (worth keeping — this can be a
// slow operation), but means the parent process can't read the child's stdout at all, so
// there is no other channel to get `changedCount`/`vendorSafety` back across the process
// boundary. Internal only, alongside --vendor-apply-only.
// --expect-src-head: refuse the apply if the resolved source's HEAD differs from the sha a
// prior --preview reported (result.srcHead) — the consent pin for two-step preview→apply
// flows (onboarding), so a source that moved between the two steps can never vendor content
// the user didn't see.
const UPDATE_HIDDEN_VALUE_FLAGS = new Set(["--result-file", "--stamp-source", "--expect-src-head"]);
const UPDATE_VALUE_FLAGS = new Set(["--from", "--repo", "--contribute"]);

function assertKnownUpdateFlags(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (UPDATE_VALUE_FLAGS.has(a) || UPDATE_HIDDEN_VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    if (a.startsWith("--") && !UPDATE_BOOL_FLAGS.has(a) && !UPDATE_HIDDEN_BOOL_FLAGS.has(a))
      throw new UpdateError(
        `aios update: unknown flag ${a} — supported: ` +
          `${[...UPDATE_BOOL_FLAGS].join("|")} ${[...UPDATE_VALUE_FLAGS].map((f) => `${f} <val>`).join(" ")}`
      );
  }
}

/**
 * Build the structured result every `cmdUpdate` mode returns (replaces the old bare
 * 0/1). `applyAllowed` is derived, not caller-supplied, so it can't drift from the
 * individual signals it's computed from: blocked by a non-fast-forward/uninspectable
 * remote, a dirty/uninspectable source, or an unsafe vendor result.
 */
function buildResult({
  mode,
  exitStatus,
  remoteState = null,
  sourceClean = null,
  vendorSafety: vs = null,
  srcHead = null,
  applied = false,
  changedCount = 0,
  reasons = [],
}) {
  // ALLOWLIST, not a blocklist: these are the only remote states apply proceeds under
  // (verified-current/behind, deliberately-untracked, or acceptable-offline where the stale
  // ref positively rules out local-only commits). Any OTHER state — including any state a
  // future acquireRemoteState change adds — blocks by construction, so a new classifier
  // state can never silently default to "allowed" the way a blocklist would let it.
  const REMOTE_ALLOW_STATES = [
    "current",
    "behind",
    "no-upstream",
    "unreachable",
    "missing-upstream-ref",
  ];
  const remoteBlocks = remoteState ? !REMOTE_ALLOW_STATES.includes(remoteState.state) : false;
  const sourceBlocks = sourceClean != null && sourceClean !== "clean";
  const vendorBlocks = vs != null && !vs.safe;
  // mode === "error" is cmdUpdate's outer catch converting a thrown UpdateError into a
  // result — none of the other three signals were ever computed, so they default to
  // non-blocking and would otherwise leave applyAllowed silently true after a failed
  // check/preview. When we couldn't even evaluate whether it's safe, never default to
  // "allowed". The same principle covers a FAILED apply: a vendor child that died without
  // writing its result file leaves vendorSafety null (non-blocking) while remoteState/
  // sourceClean are green — the pre-flight signals were fine, but the apply itself failed,
  // and `applyAllowed: true` on a failed apply would lie to every programmatic caller
  // reading the documented `.applyAllowed` contract.
  const errorBlocks = mode === "error" || (mode === "apply" && exitStatus !== 0);
  // …and the same principle one more time, generalized: an apply-capable result whose
  // safety signals were ALL never computed (remote, cleanliness, vendor safety) must not
  // read as allowed — whatever branch produced it evaluated nothing. `contribute` is not
  // an apply at all (it pushes a PR), so its result never advertises apply permission.
  const unevaluated =
    ["check", "preview", "apply"].includes(mode) &&
    remoteState == null &&
    sourceClean == null &&
    vs == null;
  const nonApplyMode = mode === "contribute";
  return {
    exitStatus,
    mode,
    remoteState,
    sourceClean,
    vendorSafety: vs,
    srcHead,
    applyAllowed:
      !remoteBlocks &&
      !sourceBlocks &&
      !vendorBlocks &&
      !errorBlocks &&
      !unevaluated &&
      !nonApplyMode,
    applied,
    changedCount,
    reasons,
  };
}

/**
 * The one renderer for a mergeManaged() result — used by the real apply
 * (cmdVendorApplyOnly) and --preview, with `preview` selecting the mode-appropriate
 * conflict hints. Returns changedCount. One implementation so report categories and
 * conflict wording can't drift between the two modes.
 */
function printMergeReport(color, r, { preview = false } = {}) {
  const report = (label, arr, tone = color.green) => {
    if (!arr.length) return;
    console.log(tone(`  ${label}: ${arr.length}`));
    for (const p of arr.slice(0, 20)) console.log(color.dim(`    ${p}`));
    if (arr.length > 20) console.log(color.dim(`    … and ${arr.length - 20} more`));
  };
  report("created", r.created);
  report("seeded (missing starter files)", r.seeded);
  report("updated", r.updated);
  report("merged (local edits + toolkit changes combined)", r.merged);
  report("removed (deleted upstream)", r.deleted);
  report("skipped — uncommitted local changes", r.skippedDirty, color.yellow);
  if (r.skippedDirty.length) {
    console.warn(
      color.dim(
        "  Commit them (then re-run), `git checkout -- <path>` to take the toolkit version, " +
          "or re-run with --force to overwrite."
      )
    );
  }

  if (r.conflicts.length) {
    console.warn(color.yellow(`  ${r.conflicts.length} conflict(s) — NOT applied:`));
    for (const cf of r.conflicts.slice(0, 20)) {
      const how =
        cf.kind === "merge"
          ? preview
            ? "both sides changed — applying would create .aios-incoming and .aios-merge sidecars"
            : `both sides changed — see ${cf.path}.aios-merge, take ${cf.path}.aios-incoming, or edit in place`
          : cf.kind === "deleted-upstream"
            ? "removed upstream but you modified it — delete it or upstream your change"
            : preview
              ? "no sync baseline — applying would create an .aios-incoming sidecar"
              : `no sync baseline — see ${cf.path}.aios-incoming, or re-run --force if you have no local edits`;
      console.warn(color.dim(`    ✗ ${cf.path} — ${how}`));
    }
    if (r.conflicts.length > 20)
      console.warn(color.dim(`    … and ${r.conflicts.length - 20} more`));
  }

  return r.created.length + r.seeded.length + r.updated.length + r.merged.length + r.deleted.length;
}

/**
 * The one read-only safety assessment of a toolkit source — remote state (via a strictly
 * read-only pullToolkitCheckout), vendor safety, source cleanliness, and the reasons list
 * built from them. Shared by the toolkit-self check/preview block, workspace --check, and
 * --preview so a new signal (or a wording fix) lands in every mode at once instead of
 * drifting across three hand-built copies.
 */
function assessReadOnlySource(srcDir, { pullOpts, io, skipRemote = false }) {
  const pullInfo = skipRemote
    ? null
    : pullToolkitCheckout(srcDir, { ...pullOpts, check: true, dryRun: true, noInstall: true }, io);
  const vs = vendorSafety(srcDir);
  const sourceClean = pullInfo?.sourceClean ?? sourceCleanliness(srcDir);
  const remoteState = pullInfo?.remoteState ?? null;
  const reasons = [];
  if (remoteState && !["current", "no-upstream"].includes(remoteState.state))
    reasons.push(remoteMessage(remoteState).text);
  if (sourceClean === "dirty") reasons.push("the toolkit checkout has uncommitted changes");
  if (sourceClean === "inspection-error")
    reasons.push("couldn't determine whether the toolkit checkout is clean");
  if (!vs.safe) reasons.push(vendorSafetyReason(vs));
  return { remoteState, sourceClean, vs, reasons };
}

/**
 * `--vendor-apply-only <srcDir=snapshot> --repo <repo> [--force]` — the structurally
 * non-recursive vendor step. Has NO hand-off logic anywhere in it: it cannot spawn a
 * child, so there is nothing for an ambient environment variable or a stray flag to
 * confuse — the old `AIOS_UPDATE_VENDOR_CHILD` recursion guard this replaces is deleted
 * entirely, not hardened. `srcDir` is always the caller's pinned, immutable snapshot
 * (never the live, mutable toolkit checkout), so `vendorSafety` here is the authoritative,
 * TOCTOU-immune final gate — nothing can change under it between this check and the
 * writes that follow.
 */
async function cmdVendorApplyOnly(repo, args) {
  const color = c;
  const srcDir = argValue(args, "--from");
  if (!srcDir || !looksLikeToolkit(srcDir)) {
    throw new UpdateError(
      `--vendor-apply-only requires --from pointing at a valid toolkit checkout — got ${srcDir}.`
    );
  }
  const stampSource = argValue(args, "--stamp-source");
  if (!stampSource || /[\r\n]/.test(stampSource)) {
    throw new UpdateError("--vendor-apply-only requires a single-line --stamp-source value.");
  }
  const force = args.includes("--force");

  const vs = vendorSafety(srcDir);
  if (!vs.safe) {
    throw new UpdateError(
      `the pinned toolkit snapshot has unresolved conflicts — ${vendorSafetyReason(vs)}.\n` +
        `  Refusing to vendor conflict markers into your workspace.`
    );
  }

  const sha = gitSha(srcDir); // srcDir IS the pinned snapshot — this trivially equals the pinned sha
  const meta = toolkitMeta(srcDir); // unmodified — reads the snapshot's own frozen files
  const stampPath = path.join(repo, VERSION_FILE);
  assertDestPathSafe(repo, VERSION_FILE, "write version stamp");
  // gen-catalog (spawned below) writes these fixed destinations with no containment checks
  // of its own — assert them here, at the same chokepoint as every other managed write, so
  // a symlinked catalog destination is refused before anything is written.
  for (const rel of [".claude/skills/INDEX.md", ".claude/INTEGRATIONS.md", "RESOLVER.md"])
    assertDestPathSafe(repo, rel, "regenerate catalog");
  // PRE-FLIGHT containment scan over every managed + seed destination — all-or-nothing.
  // The per-file asserts inside mergeManaged remain as a backstop, but they fire mid-write-
  // loop: one bad destination there would leave every earlier file already vendored (a
  // partial apply with no stamp). Refusing up front, before the first write, keeps a
  // symlinked/escaping destination from ever producing a half-applied workspace.
  for (const entry of [...MANAGED_PATHS, ...SEED_IF_ABSENT]) {
    if (!existsSync(path.join(srcDir, entry.src))) continue;
    for (const file of entryFiles(srcDir, entry)) assertDestPathSafe(repo, file.destRel);
  }
  const baseSha = existsSync(stampPath)
    ? readFileSync(stampPath, "utf8").split(/\s/)[0]
    : undefined;
  const dirty = force ? new Set() : dirtyManagedPaths(repo);

  const shortSha = sha.slice(0, 12);
  console.log(color.dim(`  syncing toolkit ${meta.label} from ${stampSource} (${shortSha}) …`));
  const r = mergeManaged(srcDir, srcDir, repo, baseSha, { dirty, force, dryRun: false });

  // Regenerate the derived catalogs from the just-synced skills so INDEX.md,
  // INTEGRATIONS.md, and RESOLVER.md's generated block never drift after an update.
  // A snapshot without the script ships no catalogs to regenerate — skip. A script that
  // RAN and FAILED is an incomplete apply: recorded, and the stamp write below is skipped
  // so `--check` keeps reporting the workspace behind until a re-run succeeds.
  const catalogScript = path.join(srcDir, "scripts", "gen-catalog.mjs");
  let catalogFailed = false;
  if (existsSync(catalogScript)) {
    try {
      execFileSync(process.execPath, [catalogScript, "--repo", repo], { stdio: "inherit" });
    } catch {
      catalogFailed = true;
      console.warn(
        color.yellow("  gen-catalog failed — catalogs may be stale; fix and re-run `aios update`.")
      );
    }
  }

  const changedCount = printMergeReport(color, r);

  if (r.conflicts.length) {
    // Leave the stamp at the old base so a re-run re-surfaces the conflicts once resolved.
    // This is a NORMAL outcome of local customization (a workspace edit conflicting with
    // the toolkit's incoming change) — not the same as vendorSafety's hard refusal above
    // (which means the SOURCE toolkit itself is broken) — exitStatus stays 0.
    console.warn(
      color.yellow(
        `  resolve the conflict(s) and re-run \`aios update\` — version stays pinned at ${(
          baseSha || "(none)"
        ).slice(0, 12)} until then.`
      )
    );
    return buildResult({
      mode: "vendor-apply-only",
      exitStatus: 0,
      applied: true,
      changedCount,
      vendorSafety: vs,
      reasons: [`${r.conflicts.length} conflict(s) — not applied for those files`],
    });
  }

  if (catalogFailed) {
    // Same honesty model as conflicts: an incomplete apply is never stamped — a fresh
    // stamp would make `--check` report "up to date" over drifted catalogs forever.
    console.warn(
      color.yellow(
        `  catalogs were not regenerated — version stays pinned at ${(baseSha || "(none)").slice(0, 12)} until a re-run succeeds.`
      )
    );
    return buildResult({
      mode: "vendor-apply-only",
      exitStatus: 0,
      applied: true,
      changedCount,
      vendorSafety: vs,
      reasons: ["catalog regeneration failed — version not stamped; re-run `aios update`"],
    });
  }

  writeFileSync(stampPath, stampBody(sha, meta, stampSource));
  if (changedCount) {
    console.log(
      color.green(
        `  toolkit synced to ${meta.label} (${shortSha}) — ${changedCount} file(s) changed.`
      )
    );
    console.log(color.dim("  Review + commit these on your workspace's master branch."));
  } else {
    console.log(color.green(`  already up to date — ${meta.label} (${shortSha}).`));
  }
  return buildResult({
    mode: "vendor-apply-only",
    exitStatus: 0,
    applied: true,
    changedCount,
    vendorSafety: vs,
  });
}

/**
 * `aios update`. Returns a structured result object (never a bare number, never exits) so
 * programmatic callers (onboarding, tests) can inspect `.applyAllowed`/`.reasons` instead
 * of parsing console text. Every expected failure — dirty tree, unresolved conflict, bad
 * `--from`, unknown flag, a non-fast-forward, an uninspectable local repo — throws
 * `UpdateError`; this function is the ONE place that catches it and converts it into a
 * printed message + a non-zero result. Any OTHER thrown error is a genuinely unexpected
 * bug and is left to propagate to the CLI dispatcher's own catch-all (`scripts/aios.mjs`).
 */
export async function cmdUpdate(repo, cfg, args) {
  let result;
  try {
    result = await cmdUpdateInner(repo, cfg, args);
  } catch (e) {
    if (e instanceof UpdateError) {
      console.error(c.red(`error: ${e.message}`));
      result = buildResult({ mode: "error", exitStatus: 1, reasons: [e.message] });
    } else {
      throw e;
    }
  }
  // --vendor-apply-only runs as a SEPARATE PROCESS from its caller (see the hand-off in
  // cmdUpdateInner) — `stdio: "inherit"` gives live progress output but means the parent
  // can't read this process's return value at all, only its exit code. --result-file is
  // the one place BOTH the normal-return and thrown-UpdateError paths converge (this same
  // try/catch), so writing it here — once — covers every outcome the child can have.
  const resultFile = argValue(args, "--result-file");
  if (resultFile) {
    try {
      writeFileSync(resultFile, JSON.stringify(result));
    } catch {
      /* best-effort — the parent falls back to exit-code-only if this write fails */
    }
  }
  return result;
}

async function cmdUpdateInner(repo, cfg, args) {
  const color = c;
  assertKnownUpdateFlags(args);

  // Structurally non-recursive internal hand-off. Validated and dispatched FIRST, before
  // anything else in this function runs — nothing below this block is reachable from a
  // --vendor-apply-only invocation, and cmdVendorApplyOnly itself has no code path that
  // could ever reach back here.
  if (args.includes("--vendor-apply-only")) {
    const allowed = new Set([
      "--vendor-apply-only",
      "--from",
      "--repo",
      "--force",
      "--result-file",
      "--stamp-source",
    ]);
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--from" || a === "--repo" || a === "--result-file" || a === "--stamp-source") {
        i++; // skip the flag's value
        continue;
      }
      if (!allowed.has(a)) {
        throw new UpdateError(
          `aios update --vendor-apply-only accepts only --from/--repo/--force/--result-file/--stamp-source — got ${a}. ` +
            `This is an internal hand-off entrypoint, not meant to be combined with other flags.`
        );
      }
    }
    return await cmdVendorApplyOnly(repo, args);
  }

  const check = args.includes("--check");
  // --dry-run is this CLI's universal "no writes" convention; alias it to --preview for the
  // general case. Excluded when --contribute is present, where it keeps its existing
  // narrower meaning (handled inside cmdContribute — previews the PR without writing).
  const preview =
    args.includes("--preview") || (args.includes("--dry-run") && !args.includes("--contribute"));

  // --contribute performs Git + `gh` writes (pushes a branch, opens a PR). It must never run
  // under a read-only mode — otherwise `aios update --check --contribute <path>` silently makes
  // remote writes while claiming to be read-only. Preview it with `--contribute <path> --dry-run`.
  if (args.includes("--contribute") && (check || preview)) {
    throw new UpdateError(
      "aios update --contribute cannot be combined with --check/--preview — it pushes a branch and\n" +
        "  can open a PR. Preview it instead with: aios update --contribute <path> --dry-run"
    );
  }

  const noPull = args.includes("--no-pull") || preview;
  const stash = args.includes("--stash");
  const noInstall = args.includes("--no-install");
  const pullOpts = { stash, noInstall, dryRun: check, check };
  const io = { log: (m) => console.log(m), warn: (m) => console.warn(m) };
  const mode = check ? "check" : preview ? "preview" : "apply";

  // Run inside the toolkit checkout itself: no workspace to re-vendor into, so `aios update`
  // just brings the checkout current (git pull + npm ci) — the "self-update" case. Nothing
  // is ever vendored here, so any snapshot pullToolkitCheckout pins is unused — discard it.
  if (looksLikeToolkit(repo)) {
    console.log(color.blue("aios update") + color.dim(`  toolkit checkout ${repo}`));
    if (check || preview) {
      // Both read-only modes must report the same remote/local safety signals that apply
      // enforces — one shared assessment (ls-remote only; vendorSafety catches an
      // unresolved index before we advertise applyAllowed).
      const a = assessReadOnlySource(repo, { pullOpts, io });
      if (preview) {
        console.log(color.dim("  --preview — nothing to re-vendor in the toolkit checkout."));
      }
      return buildResult({
        mode,
        exitStatus: 0,
        remoteState: a.remoteState,
        sourceClean: a.sourceClean,
        vendorSafety: a.vs,
        reasons: a.reasons,
      });
    }
    if (noPull) {
      // Even a no-op needs an honest signal: with every safety field null, buildResult
      // would have nothing to derive applyAllowed from (and now fails closed on that) —
      // cleanliness is the one cheap, local signal this branch can truthfully report.
      console.log(color.dim("  --no-pull — nothing to re-vendor in the toolkit checkout."));
      return buildResult({ mode, exitStatus: 0, sourceClean: sourceCleanliness(repo) });
    }
    // selfUpdate: nothing is vendored here, so a current-but-dirty checkout is a no-op
    // success (the everyday state of an actively-developed checkout), no snapshot is
    // pinned, and only a REAL pull still requires a clean tree or --stash.
    const pr = pullToolkitCheckout(repo, { ...pullOpts, selfUpdate: true }, io);
    if (pr.snapshotDir) removePinnedSnapshot(repo, pr.snapshotDir);
    return buildResult({
      mode,
      exitStatus: 0,
      remoteState: pr.remoteState,
      sourceClean: pr.sourceClean,
    });
  }

  const { dir: srcDir, ephemeral, stampSource } = resolveSource(args, cfg, (m) => console.warn(m));

  // --contribute upstreams a locally-improved managed file as a toolkit PR (own flow).
  if (args.includes("--contribute")) {
    try {
      await cmdContribute(repo, { dir: srcDir, ephemeral }, args, argValue(args, "--contribute"));
    } finally {
      if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
    }
    return buildResult({ mode: "contribute", exitStatus: 0 });
  }

  try {
    if (check) {
      // ephemeral (freshly cloned) sources are trivially current — no remote check needed.
      const a = assessReadOnlySource(srcDir, { pullOpts, io, skipRemote: ephemeral });
      const { remoteState, sourceClean, vs } = a;

      const sha = gitSha(srcDir);
      const meta = toolkitMeta(srcDir);
      const stampPath = path.join(repo, VERSION_FILE);
      const stampField = (label) => {
        if (!existsSync(stampPath)) return undefined;
        const m = readFileSync(stampPath, "utf8").match(new RegExp(`^${label}\\s+(.+)$`, "m"));
        return m ? m[1].trim() : undefined;
      };
      const have = existsSync(stampPath)
        ? readFileSync(stampPath, "utf8").split(/\s/)[0]
        : "(none)";
      const matches = have !== "(none)" && (sha.startsWith(have) || have.startsWith(sha));
      const short = (s) => (s === "(none)" ? s : s.slice(0, 12));
      const haveVer = stampField("toolkit-version");
      const missingSeeds = missingSeedPaths(srcDir, repo);
      const remoteCurrent =
        !remoteState || remoteState.state === "current" || remoteState.state === "no-upstream";

      // Check-only extras (stamp match, missing seeds) append to the shared assessment.
      const reasons = [...a.reasons];
      if (!matches)
        reasons.push(
          `this workspace is on ${haveVer ? `v${haveVer}` : short(have)}, local toolkit ${meta.label} (${short(sha)})`
        );
      if (missingSeeds.length)
        reasons.push(
          `missing seed${missingSeeds.length === 1 ? "" : "s"}: ${missingSeeds.join(", ")}`
        );

      const allGreen =
        matches && !missingSeeds.length && remoteCurrent && sourceClean === "clean" && vs.safe;
      if (allGreen) {
        console.log(color.green(`  up to date — ${meta.label} (${short(sha)}).`));
      } else {
        console.log(color.yellow(`  behind — ${reasons.join("; ")}. Run \`aios update\`.`));
      }
      return buildResult({
        mode: "check",
        exitStatus: 0,
        remoteState,
        sourceClean,
        vendorSafety: vs,
        srcHead: sha,
        reasons,
      });
    }

    if (preview) {
      // preview never pulls (implies --no-pull) and never writes — it operates directly
      // against the live srcDir, same honest point-in-time scope as --check. No snapshot
      // is needed since nothing is ever written.
      const a = assessReadOnlySource(srcDir, { pullOpts, io, skipRemote: ephemeral });
      const { remoteState, sourceClean, vs } = a;
      if (!vs.safe) {
        console.warn(
          color.yellow(`  toolkit has unresolved conflicts — ${vendorSafetyReason(vs)}.`)
        );
      }
      if (sourceClean !== "clean") {
        console.warn(
          color.yellow(
            `  toolkit checkout is ${sourceClean === "dirty" ? "dirty" : "not fully inspectable"} — this preview may not match what apply produces.`
          )
        );
      }

      const sha = gitSha(srcDir);
      const meta = toolkitMeta(srcDir);
      console.log(
        color.dim(`  previewing toolkit ${meta.label} from ${srcDir} (${sha.slice(0, 12)}) …`)
      );
      const stampPath = path.join(repo, VERSION_FILE);
      const baseSha = existsSync(stampPath)
        ? readFileSync(stampPath, "utf8").split(/\s/)[0]
        : undefined;
      const force = args.includes("--force");
      const dirty = force ? new Set() : dirtyManagedPaths(repo);

      const r = mergeManaged(srcDir, srcDir, repo, baseSha, { dirty, force, dryRun: true });

      const changedCount = printMergeReport(color, r, { preview: true });
      console.log(
        color.dim(
          `  preview only — ${changedCount} managed file(s) would change; no files or conflict sidecars were written.`
        )
      );
      return buildResult({
        mode: "preview",
        exitStatus: 0,
        remoteState,
        sourceClean,
        vendorSafety: vs,
        srcHead: sha,
        changedCount,
        reasons: a.reasons,
      });
    }

    // APPLY mode from here. Every path below ends with a pinned, immutable snapshot to
    // hand off to --vendor-apply-only — whether the source was actually pulled, skipped
    // via --no-pull, or is a freshly-cloned ephemeral checkout (already current). Both
    // paths run through pullToolkitCheckout (throws UpdateError on its own failures), so
    // the clean gate, --stash handling, and snapshot pinning are one implementation —
    // `localOnly` just skips the remote classification and fast-forward.
    const snapshotSource =
      noPull || ephemeral
        ? pullToolkitCheckout(srcDir, { ...pullOpts, localOnly: true, noInstall: true }, io)
        : pullToolkitCheckout(srcDir, pullOpts, io);

    // From here the pinned snapshot exists on disk (a registered git worktree in the
    // user's toolkit checkout). ONE finally owns its whole lifetime: every exit — the
    // UpdateError refusals below, a plain system error (mkdtempSync ENOSPC, an
    // uninspectable probe read), or the normal return — runs the same cleanup, so no new
    // exit path can ever reintroduce the leak class this block used to have (three
    // hand-placed removePinnedSnapshot calls, each covering only the throws above it).
    let resultDir = null;
    try {
      const entrypoint = path.join(snapshotSource.snapshotDir, "scripts", "aios.mjs");
      if (!existsSync(entrypoint)) {
        throw new UpdateError(
          `the pinned toolkit snapshot is missing its CLI entrypoint (${entrypoint}) — the toolkit checkout may be corrupted.`
        );
      }

      // The child below is the SNAPSHOT's own CLI, so the snapshot must understand the
      // hand-off flags — a snapshot of a toolkit that predates --vendor-apply-only would
      // reject them via its own assertKnownUpdateFlags and die with an opaque "unknown
      // flag". That happens for real sources the state table lets proceed without a
      // fast-forward to current main: a pinned AIOS_TOOLKIT_DIR/--from at an old commit,
      // or an offline/no-upstream checkout. Probe the snapshot's update.mjs for the flag
      // and refuse with a message naming the actual problem + the fix. A snapshot with NO
      // scripts/update.mjs can't be probed (real toolkits always ship it; test stubs
      // don't) — let those through to the entrypoint, which speaks for itself. If a future
      // change adds a hand-off flag an older POST-protocol toolkit won't know, extend this
      // probe to cover that flag too.
      const snapshotUpdateModule = path.join(snapshotSource.snapshotDir, "scripts", "update.mjs");
      if (
        existsSync(snapshotUpdateModule) &&
        !readFileSync(snapshotUpdateModule, "utf8").includes("--vendor-apply-only")
      ) {
        const fixHint = ephemeral
          ? `Set toolkit_repo in aios.yaml (or AIOS_TOOLKIT_DIR/--from) to a toolkit at or after the hand-off protocol — the cloned source itself is a throwaway temp dir.`
          : `Bring that checkout up to date first (git -C ${srcDir} pull), then re-run \`aios update\`.`;
        throw new UpdateError(
          `the toolkit source (${stampSource}) predates the self-update hand-off protocol — its own ` +
            `CLI doesn't understand --vendor-apply-only, so this toolkit can't drive it.\n` +
            `  ${fixHint}`
        );
      }

      // The consent pin for two-step preview→apply flows (onboarding): the caller passes
      // the sha its preview reported, and a source that has since moved refuses instead of
      // silently vendoring content the user never saw.
      const expectHead = argValue(args, "--expect-src-head");
      if (expectHead && snapshotSource.srcHead && snapshotSource.srcHead !== expectHead) {
        throw new UpdateError(
          `the toolkit source moved since it was previewed (previewed ${expectHead.slice(0, 12)}, ` +
            `now ${snapshotSource.srcHead.slice(0, 12)}) — re-run the preview and confirm against the new state.`
        );
      }

      // stdio: "inherit" gives live progress output for what can be a slow operation, but
      // means this process can't read the child's return value at all — only its exit
      // outcome. --result-file is the one side-channel back (see cmdUpdate).
      resultDir = mkdtempSync(path.join(os.tmpdir(), "aios-vendor-result-"));
      const resultFile = path.join(resultDir, "result.json");
      const passthrough = [
        "update",
        "--vendor-apply-only",
        "--from",
        snapshotSource.snapshotDir,
        "--repo",
        repo,
        "--result-file",
        resultFile,
        "--stamp-source",
        stampSource,
      ];
      if (args.includes("--force")) passthrough.push("--force");
      const res = spawnSync(process.execPath, [entrypoint, ...passthrough], { stdio: "inherit" });

      let exitStatus, reasons;
      if (res.error) {
        exitStatus = 1;
        reasons = [`couldn't launch the vendor step (${res.error.message})`];
        console.error(color.red(`error: couldn't launch the vendor step (${res.error.message})`));
      } else if (res.signal) {
        exitStatus = 1;
        reasons = [`the vendor step was terminated (signal ${res.signal})`];
        console.error(color.red(`error: the vendor step was terminated (signal ${res.signal})`));
      } else {
        exitStatus = res.status ?? 1;
        reasons = exitStatus ? ["the vendor step failed — see output above"] : [];
      }

      // Best-effort: if the child's result file is missing/unparseable (e.g. it crashed
      // before writing it, or res.error fired before it ever ran), fall back to the
      // exit-code-only synthesis above rather than throwing here.
      let childResult = null;
      try {
        childResult = JSON.parse(readFileSync(resultFile, "utf8"));
      } catch {
        /* fall back to exit-code-only reasons/changedCount below */
      }

      return buildResult({
        mode: "apply",
        exitStatus,
        remoteState: snapshotSource.remoteState,
        sourceClean: snapshotSource.sourceClean,
        vendorSafety: childResult?.vendorSafety ?? null,
        srcHead: snapshotSource.srcHead,
        applied: exitStatus === 0,
        changedCount: childResult?.changedCount ?? 0,
        reasons: childResult?.reasons?.length ? childResult.reasons : reasons,
      });
    } finally {
      if (resultDir) rmSync(resultDir, { recursive: true, force: true });
      removePinnedSnapshot(srcDir, snapshotSource.snapshotDir);
    }
  } finally {
    if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
  }
}
