/**
 * update.mjs — `aios update`: re-vendor the toolkit into this workspace.
 *
 * A scaffolded workspace carries a COPY of the toolkit (see toolkit-manifest.mjs).
 * This command re-copies the MANAGED_PATHS from the canonical toolkit and pins the
 * version — the one-command way for a forked workspace to stay in sync. It NEVER
 * touches personal content (it only writes MANAGED_PATHS.dest).
 *
 *   aios update            # sync managed paths; print what changed
 *   aios update --check    # dry-run: is this workspace behind? (no writes)
 *   aios update --from DIR  # use a specific toolkit checkout as the source
 *   aios update --force    # overwrite even managed files with uncommitted local edits
 *
 * Safety: managed files with UNCOMMITTED local changes are skipped (not clobbered) so
 * local work with no git object can't be destroyed. Commit them, `git checkout --` to
 * discard, or pass --force to overwrite.
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
  cpSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  statSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { c, die } from "./cli-common.mjs";
import { MANAGED_PATHS, VERSION_FILE } from "./toolkit-manifest.mjs";

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
 * This is the interim guard; the eventual 3-way merge reconciles committed local edits too.
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

/** Recursively overlay a dir, copying each file unless shouldSkip(destRel) flags it dirty. */
function overlayDir(srcDir, destDir, destRelBase, shouldSkip, skipped) {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const s = path.join(srcDir, name);
    const rel = destRelBase ? `${destRelBase}/${name}` : name;
    if (statSync(s).isDirectory()) {
      overlayDir(s, path.join(destDir, name), rel, shouldSkip, skipped);
    } else if (shouldSkip(rel)) {
      skipped.push(rel);
    } else {
      cpSync(s, path.join(destDir, name), { force: true });
    }
  }
}

/**
 * Copy one managed entry from source→workspace. For directories this is an OVERLAY:
 * toolkit files overwrite matching workspace files, but files the workspace has that
 * the toolkit does NOT (a person's own scripts / skills living in the same dir) are
 * LEFT UNTOUCHED. `scripts/` and `.claude/skills/` are mixed toolkit+personal dirs, so
 * a wholesale replace would delete personal content — never do that. Files with
 * uncommitted local changes (`dirty`) are skipped, not clobbered.
 */
function syncEntry(srcRoot, destRoot, entry, dirty, skipped) {
  const src = path.join(srcRoot, entry.src);
  const dest = path.join(destRoot, entry.dest);
  if (!existsSync(src)) return { path: entry.dest, status: "missing-in-source" };
  const shouldSkip = (rel) => dirty.has(rel);
  if (entry.kind === "dir") {
    overlayDir(src, dest, entry.dest, shouldSkip, skipped);
  } else if (shouldSkip(entry.dest)) {
    skipped.push(entry.dest);
    return { path: entry.dest, status: "skipped-dirty" };
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest, { force: true });
    if (entry.exec) chmodSync(dest, 0o755);
  }
  return { path: entry.dest, status: "synced" };
}

/**
 * Overlay every managed path from a toolkit checkout into a workspace. Exported for tests.
 * `opts.dirty` is the set of dest paths with uncommitted changes to skip (default: none).
 * Returns `{ results, skipped }` — per-entry results plus the flat list of skipped files.
 */
export function syncManaged(srcRoot, destRoot, opts = {}) {
  const dirty = opts.dirty || new Set();
  const skipped = [];
  const results = MANAGED_PATHS.map((e) => syncEntry(srcRoot, destRoot, e, dirty, skipped));
  return { results, skipped };
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

  try {
    if (check) {
      // Lightweight drift check: compare the pinned version to the source sha.
      const stampPath = path.join(repo, VERSION_FILE);
      const have = existsSync(stampPath)
        ? readFileSync(stampPath, "utf8").split(/\s/)[0]
        : "(none)";
      // Tolerant compare: older stamps hold a short sha, new ones the full sha — a
      // prefix match on either side means up to date.
      const matches = have !== "(none)" && (sha.startsWith(have) || have.startsWith(sha));
      const short = (s) => (s === "(none)" ? s : s.slice(0, 12));
      if (matches) {
        console.log(color.green(`  toolkit up to date (${short(sha)}).`));
      } else {
        console.log(
          color.yellow(
            `  toolkit behind — workspace pinned ${short(have)}, upstream ${short(sha)}. ` +
              `Run \`aios update\`.`
          )
        );
      }
      return;
    }

    // Protect uncommitted local edits to managed files: skip them (don't clobber) unless
    // the owner opts in with --force. Committed local edits are surfaced by the git-status
    // diff below (and reconciled properly once the 3-way merge lands).
    const force = args.includes("--force");
    const dirty = force ? new Set() : dirtyManagedPaths(repo);

    const shortSha = sha.slice(0, 12);
    console.log(color.dim(`  syncing toolkit from ${srcDir} (${shortSha}) …`));
    const { results, skipped } = syncManaged(srcDir, repo, { dirty });

    if (skipped.length) {
      console.warn(
        color.yellow(
          `  skipped ${skipped.length} file(s) with uncommitted local changes (not overwritten):`
        )
      );
      for (const p of skipped.slice(0, 20)) console.warn(color.dim(`    ~ ${p}`));
      if (skipped.length > 20) console.warn(color.dim(`    … and ${skipped.length - 20} more`));
      console.warn(
        color.dim(
          "  Commit them (then re-run to see the toolkit diff), `git checkout -- <path>` to " +
            "discard and take the toolkit version, or re-run with --force to overwrite."
        )
      );
    }

    // Pin the version.
    writeFileSync(
      path.join(repo, VERSION_FILE),
      `${sha}\nsynced-at ${new Date().toISOString()}\nsource ${srcDir}\n`
    );

    // Report exactly which managed files changed (the workspace is a git repo).
    let changed = "";
    try {
      changed = execFileSync(
        "git",
        ["-C", repo, "status", "--short", "--", ...MANAGED_PATHS.map((e) => e.dest), VERSION_FILE],
        { encoding: "utf8" }
      ).trim();
    } catch {
      /* not a git repo — skip the diff summary */
    }
    const missing = results.filter((r) => r.status === "missing-in-source");
    for (const m of missing) console.warn(color.yellow(`  (not in source, skipped: ${m.path})`));

    if (changed) {
      const n = changed.split("\n").length;
      console.log(color.green(`  toolkit updated to ${shortSha} — ${n} file(s) changed:`));
      console.log(
        changed
          .split("\n")
          .slice(0, 40)
          .map((l) => color.dim("    " + l))
          .join("\n")
      );
      if (n > 40) console.log(color.dim(`    … and ${n - 40} more`));
      console.log(color.dim("  Review + commit these on your workspace's master branch."));
    } else {
      console.log(color.green(`  already up to date (${shortSha}) — nothing changed.`));
    }
  } finally {
    if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
  }
}
