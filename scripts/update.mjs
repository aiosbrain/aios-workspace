/**
 * update.mjs — `aios update`: re-vendor the toolkit into this workspace.
 *
 * A scaffolded workspace carries a COPY of the toolkit (see toolkit-manifest.mjs).
 * This command re-syncs the MANAGED_PATHS from the canonical toolkit and pins the
 * version — the one-command way for a forked workspace to stay in sync. It NEVER
 * touches personal content (it only writes MANAGED_PATHS.dest).
 *
 * It is a **3-way merge**, not a blind overlay (see toolkit-merge.mjs): with the
 * toolkit at the last-synced sha as the base, a file the workspace improved locally is
 * MERGED with the toolkit's change (or surfaced as a conflict) rather than silently
 * overwritten — the granola-1.1.0 regression class. Upstream deletions/renames are
 * propagated only for files the workspace didn't touch.
 *
 *   aios update            # 3-way merge managed paths; print what changed
 *   aios update --check    # dry-run: is this workspace behind? (no writes)
 *   aios update --from DIR  # use a specific toolkit checkout as the source
 *   aios update --force    # take the toolkit version for everything (overwrite)
 *
 * Safety: managed files with UNCOMMITTED local changes are skipped (never clobbered).
 * Conflicts are NEVER written inline (the files are executed/parsed) — the toolkit
 * version lands at <file>.aios-incoming and the marked-up merge at <file>.aios-merge;
 * the stamp stays at the old base until conflicts are resolved.
 *
 * Source resolution: --from DIR → $AIOS_TOOLKIT_DIR → ~/Projects/aios/aios-workspace
 * → `git clone` the canonical repo (aios.yaml `toolkit_repo`, else the default).
 *
 * Zero dependencies (git + cp/rm shelled out; Node >= 18).
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
} from "node:fs";
import { execFileSync } from "node:child_process";
import { c, die } from "./cli-common.mjs";
import { MANAGED_PATHS, VERSION_FILE } from "./toolkit-manifest.mjs";
import { decideMerge, threeWayMerge, gitShow, lsTree } from "./toolkit-merge.mjs";
import { toolkitMeta } from "./toolkit-meta.mjs";

const DEFAULT_REPO = "https://github.com/aiosbrain/aios-workspace.git";

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

function gitSha(dir) {
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
  const candidates = [
    from,
    process.env.AIOS_TOOLKIT_DIR,
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

/** Every toolkit file under an entry, as { srcRel, destRel } (files only). */
function entryFiles(srcRoot, entry) {
  const absSrc = path.join(srcRoot, entry.src);
  if (!existsSync(absSrc)) return [];
  if (entry.kind !== "dir") return [{ srcRel: entry.src, destRel: entry.dest }];
  const out = [];
  const walk = (dir, sub) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      const rel = sub ? `${sub}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      else out.push({ srcRel: `${entry.src}/${rel}`, destRel: `${entry.dest}/${rel}` });
    }
  };
  walk(absSrc, "");
  return out;
}

/** Apply one file's merge decision. Mutates the workspace; records into `r`. */
function applyFile({ toolkitDir, srcRoot, repo, baseSha, entry, srcRel, destRel, force }, r) {
  const destAbs = path.join(repo, destRel);
  const theirs = readIf(path.join(srcRoot, srcRel));
  const mine = readIf(destAbs);
  const write = (content) => {
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
      writeFileSync(`${destAbs}.aios-incoming`, theirs);
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
        writeFileSync(`${destAbs}.aios-incoming`, theirs);
        writeFileSync(`${destAbs}.aios-merge`, content);
        r.conflicts.push({ path: destRel, kind: "merge" });
      }
      return;
    }
  }
}

/** Propagate upstream deletions/renames for a dir entry (files gone since baseSha). */
function applyDeletions({ toolkitDir, srcRoot, repo, baseSha, entry, force }, r) {
  const baseFiles = lsTree(toolkitDir, baseSha, entry.src); // srcRel paths at base
  if (!baseFiles.length) return;
  const present = new Set(entryFiles(srcRoot, entry).map((f) => f.srcRel));
  for (const srcRel of baseFiles) {
    if (present.has(srcRel)) continue; // still shipped — not a deletion
    const destRel = entry.dest + srcRel.slice(entry.src.length);
    const destAbs = path.join(repo, destRel);
    const mine = readIf(destAbs);
    if (mine === undefined) continue; // already gone locally
    const base = gitShow(toolkitDir, baseSha, srcRel);
    if (force || mine === base) {
      unlinkSync(destAbs); // untouched locally → propagate the removal
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
  const r = { created: [], updated: [], merged: [], deleted: [], conflicts: [], skippedDirty: [] };
  for (const entry of MANAGED_PATHS) {
    if (!existsSync(path.join(srcRoot, entry.src))) continue;
    for (const f of entryFiles(srcRoot, entry)) {
      if (dirty.has(f.destRel)) {
        r.skippedDirty.push(f.destRel);
        continue;
      }
      applyFile({ toolkitDir, srcRoot, repo, baseSha, entry, ...f, force }, r);
    }
    if (entry.kind === "dir")
      applyDeletions({ toolkitDir, srcRoot, repo, baseSha, entry, force }, r);
  }
  return r;
}

/** The `.aios-toolkit-version` body. Line 1 is the sha (parsed as the merge base). */
function stampBody(sha, meta, srcDir) {
  const lines = [sha, `toolkit-version ${meta.version}`];
  if (meta.brainApi) lines.push(`brain-api ${meta.brainApi}`);
  lines.push(`synced-at ${new Date().toISOString()}`, `source ${srcDir}`);
  return lines.join("\n") + "\n";
}

export async function cmdUpdate(repo, cfg, args) {
  const color = c;
  // Guard: don't self-update the toolkit repo itself.
  if (looksLikeToolkit(repo)) {
    die("`aios update` runs inside a workspace, not the toolkit repo itself.");
  }

  const check = args.includes("--check");
  const { dir: srcDir, ephemeral } = resolveSource(args, cfg, (m) => console.warn(m));
  const sha = gitSha(srcDir);
  const meta = toolkitMeta(srcDir); // semver + brain-api version of the source toolkit
  const stampPath = path.join(repo, VERSION_FILE);
  const stampField = (label) => {
    if (!existsSync(stampPath)) return undefined;
    const m = readFileSync(stampPath, "utf8").match(new RegExp(`^${label}\\s+(.+)$`, "m"));
    return m ? m[1].trim() : undefined;
  };

  try {
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
      if (matches) {
        console.log(color.green(`  toolkit up to date — ${meta.label} (${short(sha)}).`));
      } else {
        const from = haveVer ? `v${haveVer}` : short(have);
        console.log(
          color.yellow(
            `  toolkit behind — workspace on ${from}, upstream ${meta.label} (${short(sha)}). ` +
              `Run \`aios update\`.`
          )
        );
      }
      return;
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
    const r = mergeManaged(srcDir, srcDir, repo, baseSha, { dirty, force });

    const report = (label, arr, tone = color.green) => {
      if (!arr.length) return;
      console.log(tone(`  ${label}: ${arr.length}`));
      for (const p of arr.slice(0, 20)) console.log(color.dim(`    ${p}`));
      if (arr.length > 20) console.log(color.dim(`    … and ${arr.length - 20} more`));
    };
    report("created", r.created);
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
            ? "both sides changed — see .aios-merge, take .aios-incoming, or edit in place"
            : cf.kind === "deleted-upstream"
              ? "removed upstream but you modified it — delete it or upstream your change"
              : "no sync baseline — see .aios-incoming, or re-run --force if you have no local edits";
        console.warn(color.dim(`    ✗ ${cf.path} — ${how}`));
      }
      if (r.conflicts.length > 20)
        console.warn(color.dim(`    … and ${r.conflicts.length - 20} more`));
    }

    const changedCount = r.created.length + r.updated.length + r.merged.length + r.deleted.length;
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
}
