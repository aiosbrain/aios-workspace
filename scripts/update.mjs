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
    return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Resolve the toolkit source dir. Returns { dir, ephemeral } — clone dirs are ephemeral. */
function resolveSource(args, cfg, warn) {
  const candidates = [
    argValue(args, "--from"),
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
 * Copy one managed entry from source→workspace. For directories this is an OVERLAY:
 * toolkit files overwrite matching workspace files, but files the workspace has that
 * the toolkit does NOT (a person's own scripts / skills living in the same dir) are
 * LEFT UNTOUCHED. `scripts/` and `.claude/skills/` are mixed toolkit+personal dirs, so
 * a wholesale replace would delete personal content — never do that.
 */
function syncEntry(srcRoot, destRoot, entry) {
  const src = path.join(srcRoot, entry.src);
  const dest = path.join(destRoot, entry.dest);
  if (!existsSync(src)) return { path: entry.dest, status: "missing-in-source" };
  if (entry.kind === "dir") {
    // Overlay, not replace: no rm of dest — cpSync overwrites matches, keeps extras.
    cpSync(src, dest, { recursive: true, force: true });
  } else {
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(src, dest);
    if (entry.exec) chmodSync(dest, 0o755);
  }
  return { path: entry.dest, status: "synced" };
}

/** Overlay every managed path from a toolkit checkout into a workspace. Exported for tests. */
export function syncManaged(srcRoot, destRoot) {
  return MANAGED_PATHS.map((e) => syncEntry(srcRoot, destRoot, e));
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
      if (have === sha) {
        console.log(color.green(`  toolkit up to date (${sha}).`));
      } else {
        console.log(
          color.yellow(
            `  toolkit behind — workspace pinned ${have}, upstream ${sha}. Run \`aios update\`.`
          )
        );
      }
      return;
    }

    console.log(color.dim(`  syncing toolkit from ${srcDir} (${sha}) …`));
    const results = syncManaged(srcDir, repo);

    // Pin the version.
    writeFileSync(
      path.join(repo, VERSION_FILE),
      `${sha}\nsynced-at ${new Date().toISOString()}\nsource ${srcDir}\n`
    );

    // Regenerate the derived catalogs from the just-synced skills so INDEX.md,
    // INTEGRATIONS.md, and RESOLVER.md's generated block never drift after an update.
    try {
      execFileSync(process.execPath, [path.join(srcDir, "scripts", "gen-catalog.mjs"), "--repo", repo], {
        stdio: "inherit",
      });
    } catch {
      console.warn(c.yellow("  gen-catalog failed — re-run `npm run aios -- update` or regenerate manually"));
    }

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
      console.log(color.green(`  toolkit updated to ${sha} — ${n} file(s) changed:`));
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
      console.log(color.green(`  already up to date (${sha}) — nothing changed.`));
    }
  } finally {
    if (ephemeral) rmSync(srcDir, { recursive: true, force: true });
  }
}
