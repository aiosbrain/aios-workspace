/**
 * toolkit-contribute.mjs — `aios update --contribute <path>`: open a toolkit PR from a
 * managed file a workspace improved locally.
 *
 * The 3-way merge surfaces a locally-edited managed file as a conflict every sync until
 * it's upstreamed (the granola-1.1.0 lesson). This closes that loop in one command: it
 * maps the workspace file back to its toolkit `src`, drops it into a fresh toolkit
 * worktree off origin/main (never touching the primary checkout — the AIOS worktree
 * rule), commits, pushes, and opens the PR with `gh`.
 *
 * Path mapping (`contributeTarget`) is pure + unit-tested; the git/gh orchestration is
 * integration-only and gated behind a `--dry-run` that prints the plan without writing.
 */

import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, mkdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, UpdateError } from "./cli-common.mjs";
import { MANAGED_PATHS } from "./toolkit-manifest.mjs";

/** Strip the merge sidecar suffixes so `--contribute foo.md.aios-incoming` maps to foo.md. */
function stripSidecar(p) {
  return p.replace(/\.aios-(incoming|merge)$/, "");
}

/**
 * Map a workspace-relative managed path → its toolkit `src` location. Returns
 * { destRel, srcRel, entry, excluded } or null when the path isn't a toolkit-managed
 * file. `excluded` is true for a dir entry's `exclude`d file (e.g. access-control.md):
 * it's still a legitimate scaffold path (it maps and CAN be contributed), it's just
 * not synced by `aios update` in the toolkit → workspace direction. Pure.
 */
export function contributeTarget(rawPath) {
  const destRel = stripSidecar(rawPath.replace(/^\.\//, "").replace(/\/+$/, ""));
  for (const entry of MANAGED_PATHS) {
    if (entry.kind !== "dir" && destRel === entry.dest) {
      return { destRel, srcRel: entry.src, entry, excluded: false };
    }
    if (entry.kind === "dir" && destRel.startsWith(entry.dest + "/")) {
      const tail = destRel.slice(entry.dest.length + 1); // path within the dir
      const excluded = (entry.exclude || []).includes(tail);
      return { destRel, srcRel: entry.src + destRel.slice(entry.dest.length), entry, excluded };
    }
  }
  return null;
}

/** A safe git branch slug from a dest path + short content hash (collision-resistant). */
export function contributeBranch(destRel, content) {
  const base = destRel
    .replace(/\.[^/.]+$/, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  // Tiny non-crypto hash (djb2) — just to disambiguate branches, not for security.
  let h = 5381;
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
  return `contribute/${base}-${h.toString(16).slice(0, 8)}`;
}

function hasRemote(dir) {
  try {
    execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ghAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the contribute flow. `srcInfo` ({ dir, ephemeral }) is the caller's already-resolved
 * toolkit source, so tests can pass a stub. Returns the PR url (or the plan, on --dry-run).
 */
export async function cmdContribute(repo, srcInfo, args, rawPath) {
  const color = c;
  if (!rawPath || rawPath.startsWith("--")) {
    throw new UpdateError("usage: aios update --contribute <path/to/managed-file> [--dry-run]");
  }
  const target = contributeTarget(rawPath);
  if (!target) {
    throw new UpdateError(
      `${rawPath} isn't a toolkit-managed file — only governance files synced by \`aios update\`\n` +
        `  can be contributed upstream (see scripts/toolkit-manifest.mjs). Personal content stays local.`
    );
  }
  const localAbs = path.join(repo, target.destRel);
  if (!existsSync(localAbs))
    throw new UpdateError(`${target.destRel} doesn't exist in this workspace.`);
  const content = readFileSync(localAbs, "utf8");
  const branch = contributeBranch(target.destRel, content);
  const dryRun = args.includes("--dry-run");

  const { dir: toolkitDir, ephemeral } = srcInfo;
  const plan = {
    file: target.destRel,
    toolkitPath: target.srcRel,
    branch,
    toolkit: toolkitDir,
  };

  if (target.excluded) {
    console.warn(
      color.yellow(
        `  ${target.destRel} is stamp-time PERSONALIZED (excluded from \`aios update\`'s ` +
          `sync direction) — it likely contains your own tier table/team names/aliases. ` +
          `Scrub those before contributing it as the shared scaffold default.`
      )
    );
  }

  if (dryRun) {
    console.log(color.dim("  contribute plan (dry-run — nothing written):"));
    console.log(color.dim(`    workspace file : ${plan.file}`));
    console.log(color.dim(`    → toolkit path : ${plan.toolkitPath}`));
    console.log(color.dim(`    branch         : ${plan.branch}`));
    console.log(color.dim(`    toolkit repo   : ${plan.toolkit}`));
    if (target.excluded) console.log(color.dim(`    excluded       : yes (personalized file)`));
    return plan;
  }

  if (ephemeral) {
    throw new UpdateError(
      "no local toolkit checkout with push access — `--contribute` needs your aios-workspace\n" +
        "  clone. Point at it with `--from /path/to/aios-workspace` or set AIOS_TOOLKIT_DIR."
    );
  }
  if (!hasRemote(toolkitDir))
    throw new UpdateError(`toolkit at ${toolkitDir} has no \`origin\` remote to push to.`);
  if (!ghAvailable())
    throw new UpdateError(
      "`gh` (GitHub CLI) is required to open the PR — install it or open the PR by hand."
    );

  // Work in a throwaway worktree off origin/main so the primary checkout is untouched.
  const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git(toolkitDir, "fetch", "origin", "main", "-q");
  const wt = mkdtempSync(path.join(os.tmpdir(), "aios-contribute-"));
  try {
    git(toolkitDir, "worktree", "add", "-q", "-b", branch, wt, "origin/main");
    const destInToolkit = path.join(wt, target.srcRel);
    mkdirSync(path.dirname(destInToolkit), { recursive: true });
    copyFileSync(localAbs, destInToolkit);
    const status = git(wt, "status", "--porcelain").trim();
    if (!status) {
      throw new UpdateError(
        `${target.destRel} already matches the toolkit — nothing to contribute.`
      );
    }
    git(wt, "add", "--", target.srcRel);
    const subject = `chore(toolkit): contribute ${path.basename(target.srcRel)} from a workspace`;
    const body =
      `Upstreams a locally-improved managed file via \`aios update --contribute\`.\n\n` +
      `- workspace file: \`${target.destRel}\`\n- toolkit path: \`${target.srcRel}\`\n\n` +
      `Review the change; once merged, \`aios update\` converges instead of re-flagging it.`;
    git(wt, "commit", "-q", "-m", `${subject}\n\n${body}`);
    git(wt, "push", "-q", "-u", "origin", branch);
    const url = execFileSync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        "aiosbrain/aios-workspace",
        "--base",
        "main",
        "--head",
        branch,
        "--title",
        subject,
        "--body",
        body,
      ],
      { cwd: wt, encoding: "utf8" }
    ).trim();
    console.log(color.green(`  opened toolkit PR: ${url}`));
    return { ...plan, url };
  } finally {
    try {
      git(toolkitDir, "worktree", "remove", "--force", wt);
    } catch {
      rmSync(wt, { recursive: true, force: true });
    }
  }
}
