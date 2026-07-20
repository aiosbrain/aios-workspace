/**
 * update.mjs — `aios update`: get the latest AIOS (the "auto-update like Claude" command).
 *
 * One command, two halves. First it brings the local toolkit checkout current (git fetch +
 * fast-forward + `npm ci`; see toolkit-pull.mjs) — because the workspace CLI is a thin shim
 * forwarding to that checkout, a stale checkout means stale command code AND a re-vendor of
 * stale governance. Then it re-vendors: a scaffolded workspace carries a COPY of the toolkit
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
 *   aios update --no-pull  # skip the git pull + npm ci; only re-vendor governance
 *   aios update --stash    # auto-stash a dirty toolkit tree, pull, then restore it
 *   aios update --no-install  # skip `npm ci` even if the toolkit lockfile changed
 *   aios update --from DIR  # use a specific toolkit checkout as the source
 *   aios update --force    # take the toolkit version for everything (overwrite)
 *
 * Safety: a dirty toolkit tree is never clobbered (refuse, or --stash to stash+restore); a
 * non-fast-forward toolkit is refused, not auto-merged. Managed files with UNCOMMITTED local
 * changes are skipped (never clobbered). Conflicts are NEVER written inline (the files are
 * executed/parsed) — the toolkit version lands at <file>.aios-incoming and the marked-up
 * merge at <file>.aios-merge; the stamp stays at the old base until conflicts are resolved.
 * Run inside the toolkit checkout itself, update just pulls it (nothing to re-vendor into).
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
  realpathSync,
  constants as fsConstants,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { c, die } from "./cli-common.mjs";
import { MANAGED_PATHS, SEED_IF_ABSENT, VERSION_FILE } from "./toolkit-manifest.mjs";
import { decideMerge, threeWayMerge, gitShow, lsTree } from "./toolkit-merge.mjs";
import { toolkitMeta } from "./toolkit-meta.mjs";
import { cmdContribute } from "./toolkit-contribute.mjs";
import { pullToolkitCheckout, unmergedPaths } from "./toolkit-pull.mjs";

const DEFAULT_REPO = "https://github.com/aiosbrain/aios-workspace.git";

// The toolkit checkout this CLI is executing from — <toolkit>/scripts/update.mjs → <toolkit>.
// The workspace shim (scaffold/scripts/aios.mjs) may forward here via a relative path rather
// than $AIOS_TOOLKIT_DIR, so resolving from the running file guarantees update pulls/vendors
// the SAME checkout the user is actually running — not a different one on the default path.
const RUNNING_TOOLKIT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** Real path of the checkout THIS process loaded its modules from. Its HEAD is captured lazily
 *  inside cmdUpdate (NOT at module load — importing update.mjs must not shell out to git; other
 *  commands, e.g. ship, import it and assert no external calls). Comparing the source's real
 *  path + current HEAD against these decides whether the vendor phase must hand off. */
function realPathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
const RUNNING_TOOLKIT_REAL = realPathOr(RUNNING_TOOLKIT);

/**
 * Should the vendor phase hand off to the SOURCE's CLI instead of running in this process? Yes
 * whenever our loaded modules don't correspond to the source at its current HEAD: a DIFFERENT
 * checkout (`--from B`), or the SAME checkout whose HEAD moved since we loaded (our own
 * fast-forward OR a concurrent updater's). When neither head is knowable (a non-git source),
 * there's nothing to hand off to, so run in-process — which also guarantees the child can't loop
 * (its RUNNING head == the source head it re-execs against). Pure, so both the alternate-`--from`
 * and the un-raceable concurrent-fast-forward case are unit-testable.
 */
export function shouldReExecVendor({ srcReal, srcHead, runReal, runHead }) {
  // A DIFFERENT checkout always needs the hand-off — even a non-git one whose head is unknown
  // (looksLikeToolkit accepts a `.git`-less vendored copy). Only the HEAD-moved comparison is
  // skipped when a head is unknowable, which keeps the re-exec child (same checkout) from looping.
  if (srcReal !== runReal) return true;
  if (srcHead === "unknown" || runHead === "unknown") return false;
  return srcHead !== runHead;
}

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

/** Resolve the toolkit source dir. Returns { dir, ephemeral } — clone dirs are ephemeral. */
function resolveSource(args, cfg, warn) {
  // An explicit --from is a promise: if it isn't a toolkit, that's an error, not a
  // silent fall-through to some other source the user didn't ask for.
  const from = argValue(args, "--from");
  if (from && !looksLikeToolkit(from)) {
    die(
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
    if (looksLikeToolkit(dir)) return { dir: path.resolve(dir), ephemeral: false };
  }
  // Fall back to cloning the canonical repo.
  const url = cfg?.toolkit_repo || DEFAULT_REPO;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "aios-toolkit-"));
  warn(c.dim(`  no local toolkit found — cloning ${url} …`));
  try {
    execFileSync("git", ["clone", "--depth", "1", url, tmp], { stdio: "ignore" });
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    die(
      `couldn't fetch the toolkit (${e.message}).\n` +
        `  Point at a local checkout: aios update --from /path/to/aios-workspace\n` +
        `  or set AIOS_TOOLKIT_DIR, or set toolkit_repo in aios.yaml.`
    );
  }
  if (!looksLikeToolkit(tmp)) {
    rmSync(tmp, { recursive: true, force: true });
    die(`cloned ${url} but it doesn't look like the AIOS toolkit`);
  }
  return { dir: tmp, ephemeral: true };
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

/** Refuse a seed destination whose existing parent chain escapes through a symlink. */
function assertSeedParentSafe(repo, destRel) {
  const root = path.resolve(repo);
  const destAbs = path.resolve(root, destRel);
  if (destAbs !== root && !destAbs.startsWith(root + path.sep)) {
    throw new Error(`refusing to seed path outside the workspace: ${destRel}`);
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
      throw new Error(
        `refusing to seed ${destRel}: parent path is not a real workspace directory (${path.relative(root, current)})`
      );
    }
  }
}

/** Every toolkit file under an entry, as { srcRel, destRel } (files only). */
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

// A git conflict OPENER/closer at line start — 7 markers followed by a space (labelled, as git
// writes them) OR end-of-line (a bare, label-less marker some tools / manual edits produce).
// Every real conflict has an opener, so this catches marker-bearing files that an UNMERGED-index
// check misses — e.g. a conflict that was `git add`-ed (index looks resolved) or hand-authored.
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |\t|\r?$)/m;

/**
 * Managed SOURCE files (relative paths) that contain conflict markers in their CONTENT. The
 * unmerged-index check (toolkit-pull `unmergedPaths`) only sees UNMERGED entries; a staged or
 * hand-authored marker leaves the index clean, so we must also read the bytes we're about to
 * vendor. Governance files are executed/parsed downstream — a marker must never reach them.
 */
export function conflictMarkerPaths(srcRoot) {
  const hits = [];
  for (const entry of MANAGED_PATHS) {
    if (!existsSync(path.join(srcRoot, entry.src))) continue;
    for (const f of entryFiles(srcRoot, entry)) {
      let content;
      try {
        content = readFileSync(path.join(srcRoot, f.srcRel), "utf8");
      } catch {
        continue;
      }
      if (CONFLICT_MARKER.test(content)) hits.push(f.srcRel);
    }
  }
  return hits;
}

/** Seed destinations that the toolkit can supply and the workspace does not have. */
export function missingSeedPaths(srcRoot, repo) {
  const missing = [];
  for (const entry of SEED_IF_ABSENT) {
    if (!existsSync(path.join(srcRoot, entry.src))) continue;
    for (const file of entryFiles(srcRoot, entry)) {
      assertSeedParentSafe(repo, file.destRel);
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
      assertSeedParentSafe(repo, file.destRel);
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
  const destAbs = path.join(repo, destRel);
  const theirs = readIf(path.join(srcRoot, srcRel));
  const mine = readIf(destAbs);
  const write = (content) => {
    if (dryRun) return;
    mkdirSync(path.dirname(destAbs), { recursive: true });
    writeFileSync(destAbs, content);
    if (entry.exec) chmodSync(destAbs, 0o755);
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
      if (!dryRun) writeFileSync(`${destAbs}.aios-incoming`, theirs);
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
        if (!dryRun) {
          writeFileSync(`${destAbs}.aios-incoming`, theirs);
          writeFileSync(`${destAbs}.aios-merge`, content);
        }
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
// the self-update re-exec can never silently drop a flag it doesn't know how to forward.
const UPDATE_BOOL_FLAGS = new Set([
  "--check",
  "--preview",
  "--no-pull",
  "--stash",
  "--no-install",
  "--force",
  "--dry-run", // consumed by --contribute (cmdContribute); previews the PR without writing
]);
const UPDATE_VALUE_FLAGS = new Set(["--from", "--repo", "--contribute"]);

function assertKnownUpdateFlags(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (UPDATE_VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    if (a.startsWith("--") && !UPDATE_BOOL_FLAGS.has(a))
      die(
        `aios update: unknown flag ${a} — supported: ` +
          `${[...UPDATE_BOOL_FLAGS].join("|")} ${[...UPDATE_VALUE_FLAGS].map((f) => `${f} <val>`).join(" ")}`
      );
  }
}

/**
 * `aios update`. Returns a process exit status (0 = success) instead of exiting, so
 * programmatic callers (e.g. onboarding, which runs `--check` → `--preview` → apply as
 * library calls) survive the call: `--preview` implies `--no-pull` — it never mutates the
 * toolkit, never re-execs, never exits. The interactive CLI maps a non-zero return onto
 * `process.exitCode`. (`die()` still exits on invalid input/unsafe states.)
 */
export async function cmdUpdate(repo, cfg, args) {
  const color = c;
  assertKnownUpdateFlags(args);
  const check = args.includes("--check");
  const preview = args.includes("--preview");
  // --contribute performs Git + `gh` writes (pushes a branch, opens a PR). It must never run
  // under a read-only mode — otherwise `aios update --check --contribute <path>` silently makes
  // remote writes while claiming to be read-only. Preview it with `--contribute <path> --dry-run`.
  if (args.includes("--contribute") && (check || preview)) {
    die(
      "aios update --contribute cannot be combined with --check/--preview — it pushes a branch and\n" +
        "  can open a PR. Preview it instead with: aios update --contribute <path> --dry-run"
    );
  }
  // A preview is a read-only classification: it must never pull (mutate the toolkit
  // checkout), never re-exec, and never exit — onboarding calls it mid-flow.
  const noPull = args.includes("--no-pull") || preview;
  const stash = args.includes("--stash");
  const noInstall = args.includes("--no-install");
  const pullOpts = { stash, noInstall, dryRun: check, check };
  const io = { log: (m) => console.log(m), warn: (m) => console.warn(m) };

  // Run inside the toolkit checkout itself: no workspace to re-vendor into, so `aios update`
  // just brings the checkout current (git pull + npm ci) — the "self-update" case.
  if (looksLikeToolkit(repo)) {
    console.log(color.blue("aios update") + color.dim(`  toolkit checkout ${repo}`));
    // --check always reports status (read-only). --no-pull/--preview only suppress an APPLY
    // run — and in the toolkit there's nothing else to do, so they're no-ops there.
    if (noPull && !check) {
      console.log(
        color.dim(
          `  ${preview ? "--preview" : "--no-pull"} — nothing to re-vendor in the toolkit checkout.`
        )
      );
      return 0;
    }
    pullToolkitCheckout(repo, pullOpts, io);
    return 0;
  }

  // HEAD of the checkout this process's modules were loaded from. Captured BEFORE resolveSource()
  // (which can do slow I/O — an existsSync chain, or a real `git clone` in the fallback) so a
  // concurrent updater that fast-forwards RUNNING_TOOLKIT during that window can't slip past
  // shouldReExecVendor undetected. Computed here (not at import) so importing update.mjs — e.g.
  // from ship.mjs, which asserts no external calls — never shells out to git.
  const runToolkitHead = gitSha(RUNNING_TOOLKIT);

  const { dir: srcDir, ephemeral } = resolveSource(args, cfg, (m) => console.warn(m));

  // --contribute upstreams a locally-improved managed file as a toolkit PR (own flow).
  if (args.includes("--contribute")) {
    try {
      await cmdContribute(repo, { dir: srcDir, ephemeral }, args, argValue(args, "--contribute"));
    } finally {
      if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
    }
    return 0;
  }

  try {
    // Bring the local toolkit checkout current BEFORE re-vendoring from it — otherwise the
    // sync copies stale governance and the shim runs stale code. A freshly-cloned source is
    // already at latest. --check reports git status read-only (even with --no-pull, since
    // --check always reports); --no-pull only skips the pull on an APPLY run.
    let pullInfo = null;
    if (!ephemeral && (check || !noPull)) {
      pullInfo = pullToolkitCheckout(srcDir, pullOpts, io);
    }

    // Read the source HEAD ONCE, after the pull. Reused for both the hand-off decision and the
    // version stamp so they can't disagree if a concurrent updater moves srcDir between them.
    const srcHead = gitSha(srcDir);

    // Never vendor FROM a conflicted toolkit — its files hold `<<<<<<<` markers and the
    // destinations are executed/parsed. Runs HERE, in the parent (current code), BEFORE any
    // re-exec hand-off — so the guarantee can't depend on the source CLI's version — and
    // independently of the pull (so --no-pull can't bypass it). The unmerged-index check is
    // cheap (git) and always runs; the full content scan is apply-only (it's the safety gate
    // for the vendor write, and read-only --check shouldn't pay a whole-tree read).
    const applying = !check && !preview;
    const conflicted = [
      ...new Set([...unmergedPaths(srcDir), ...(applying ? conflictMarkerPaths(srcDir) : [])]),
    ];
    if (conflicted.length) {
      const detail = `${srcDir} has ${conflicted.length} file(s) with conflict markers (e.g. ${conflicted[0]})`;
      if (check || preview) {
        // Read-only modes write nothing, so a conflicted source is a warning, not a hard
        // stop — dying here would kill a programmatic caller (onboarding) mid-flow.
        console.warn(color.yellow(`  toolkit has unresolved conflicts — ${detail}.`));
      } else {
        die(
          `the toolkit checkout has unresolved conflicts — ${detail}.\n` +
            `  Refusing to vendor conflict markers into your workspace. Resolve them (git -C\n` +
            `  ${srcDir} status), then re-run \`aios update\`.`
        );
      }
    }

    // The vendor phase must run code that matches the SOURCE at its CURRENT head. This process
    // loaded its modules (MANAGED_PATHS, merge logic) from RUNNING_TOOLKIT at runToolkitHead.
    // Hand off whenever the source is a DIFFERENT checkout (`--from B`) OR the source HEAD has
    // moved since load — by our own fast-forward, by a concurrent updater, or anything else. Keying
    // on "did MY merge move HEAD" (pulled>0) missed both: an already-current `--from B` and a
    // race where another process fast-forwarded between our behind-count and our merge.
    // Gated on !ephemeral, like the pull above: a throwaway network clone always has a different
    // real path from RUNNING_TOOLKIT, which would otherwise force a redundant child spawn on every
    // single apply run. (Ephemeral only happens if RUNNING_TOOLKIT itself isn't a valid toolkit.)
    if (applying && !ephemeral) {
      const handOff = shouldReExecVendor({
        srcReal: realPathOr(srcDir),
        srcHead,
        runReal: RUNNING_TOOLKIT_REAL,
        runHead: runToolkitHead,
      });
      if (handOff) {
        // Re-exec the SOURCE's CLI (its current code) with --no-pull so it vendors directly and
        // cannot loop (its own RUNNING_TOOLKIT == srcDir at srcHeadNow, so it will match). Deps
        // were already reconciled by the pull above; forward only the target + --force.
        const passthrough = ["update", "--no-pull", "--from", srcDir, "--repo", repo];
        if (args.includes("--force")) passthrough.push("--force");
        const res = spawnSync(
          process.execPath,
          [path.join(srcDir, "scripts", "aios.mjs"), ...passthrough],
          { stdio: "inherit" }
        );
        // Return the child's status instead of exiting: a programmatic caller (onboarding) must
        // survive the hand-off; the CLI dispatcher maps this onto process.exitCode.
        return res.status ?? 1;
      }
    }

    const sha = srcHead; // the single post-pull read; stamped value == the head we validated
    const meta = toolkitMeta(srcDir); // semver + brain-api version of the source toolkit
    const stampPath = path.join(repo, VERSION_FILE);
    const stampField = (label) => {
      if (!existsSync(stampPath)) return undefined;
      const m = readFileSync(stampPath, "utf8").match(new RegExp(`^${label}\\s+(.+)$`, "m"));
      return m ? m[1].trim() : undefined;
    };

    if (check) {
      // Compare the pinned version to the source sha; also surface the semver delta.
      const have = existsSync(stampPath)
        ? readFileSync(stampPath, "utf8").split(/\s/)[0]
        : "(none)";
      // Tolerant compare: older stamps hold a short sha, new ones the full sha — a
      // prefix match on either side means up to date.
      const matches = have !== "(none)" && (sha.startsWith(have) || have.startsWith(sha));
      const short = (s) => (s === "(none)" ? s : s.slice(0, 12));
      const haveVer = stampField("toolkit-version");
      const missingSeeds = missingSeedPaths(srcDir, repo);
      // `sha` is the LOCAL toolkit HEAD — check mode never fast-forwards. So a workspace can
      // match the local toolkit exactly while that toolkit is itself behind its remote. The
      // verdict must fold in the git-side status, or it would report a green "up to date"
      // immediately after reporting "N commits behind". Three git states can block green:
      //   behind > 0        — toolkit is definitively behind
      //   behind === null   — toolkit differs from the remote (exact count needs a fetch)
      //   !remoteVerified   — the remote was unreachable (offline); a stale local count that
      //                       happens to read 0 must NOT be trusted as "up to date"
      // Keep null (remote differs / count unknown) distinct from 0 — `?? 0` would collapse it
      // back to a green verdict. Only when NO pull ran (pullInfo null) is 0 the right default.
      const behind = pullInfo ? pullInfo.behind : 0;
      const remoteVerified = pullInfo ? pullInfo.remoteVerified !== false : true;
      const remoteCurrent = remoteVerified && behind === 0;
      if (matches && !missingSeeds.length && remoteCurrent) {
        console.log(color.green(`  up to date — ${meta.label} (${short(sha)}).`));
        return 0;
      }
      const why = [];
      if (!remoteVerified)
        why.push(`couldn't verify the toolkit's remote (offline?) — status unconfirmed`);
      else if (behind === null)
        why.push(`the toolkit checkout differs from ${pullInfo.upstream} (behind)`);
      else if (behind > 0)
        why.push(
          `the toolkit checkout is ${behind} commit${behind === 1 ? "" : "s"} behind ${pullInfo.upstream}`
        );
      if (!matches)
        why.push(
          `this workspace is on ${haveVer ? `v${haveVer}` : short(have)}, local toolkit ${meta.label} (${short(sha)})`
        );
      if (missingSeeds.length)
        why.push(`missing seed${missingSeeds.length === 1 ? "" : "s"}: ${missingSeeds.join(", ")}`);
      console.log(color.yellow(`  behind — ${why.join("; ")}. Run \`aios update\`.`));
      return 0;
    }

    // Protect uncommitted local edits: skip them (don't clobber) unless --force.
    const force = args.includes("--force");
    const dirty = force ? new Set() : dirtyManagedPaths(repo);

    // The merge base = the toolkit sha this workspace last synced from (its stamp).
    const baseSha = existsSync(stampPath)
      ? readFileSync(stampPath, "utf8").split(/\s/)[0]
      : undefined;

    const shortSha = sha.slice(0, 12);
    console.log(color.dim(`  syncing toolkit ${meta.label} from ${srcDir} (${shortSha}) …`));
    const r = mergeManaged(srcDir, srcDir, repo, baseSha, { dirty, force, dryRun: preview });

    // Regenerate the derived catalogs from the just-synced skills so INDEX.md,
    // INTEGRATIONS.md, and RESOLVER.md's generated block never drift after an update.
    if (!preview) {
      try {
        execFileSync(
          process.execPath,
          [path.join(srcDir, "scripts", "gen-catalog.mjs"), "--repo", repo],
          {
            stdio: "inherit",
          }
        );
      } catch {
        console.warn(
          color.yellow(
            "  gen-catalog failed — re-run `npm run aios -- update` or regenerate manually"
          )
        );
      }
    }

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

    const changedCount =
      r.created.length + r.seeded.length + r.updated.length + r.merged.length + r.deleted.length;
    if (preview) {
      console.log(
        color.dim(
          `  preview only — ${changedCount} managed file(s) would change; no files or conflict sidecars were written.`
        )
      );
      return 0;
    }
    if (r.conflicts.length) {
      // Leave the stamp at the old base so a re-run re-surfaces the conflicts once resolved.
      console.warn(
        color.yellow(
          `  resolve the conflict(s) and re-run \`aios update\` — version stays pinned at ${(
            baseSha || "(none)"
          ).slice(0, 12)} until then.`
        )
      );
    } else {
      writeFileSync(stampPath, stampBody(sha, meta, srcDir));
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
    }
  } finally {
    if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
  }
  return 0;
}
