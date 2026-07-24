/**
 * worktree.mjs — `aios worktree`: a git worktree wrapper with automatic config
 * propagation. `add` creates the worktree off a base ref and hydrates dev config
 * (via link-worktree-env.sh + a post-checkout hook); `init`/`list`/`install-hook`/
 * `uninstall-hook` round it out. Extracted from scripts/aios.mjs (AIO-315);
 * behaviour-preserving.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, copyFileSync, chmodSync, unlinkSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { c, die } from "./cli-common.mjs";

/**
 * Compute the worktree path for a repo + branch under the per-repo container
 * convention: `<dirname(repo)>/<basename(repo)>-worktrees/<task>`, where
 * `<task>` is the branch with slashes turned into dashes, and a leading
 * `<basename(repo)>-` prefix is dropped from the task if the branch already
 * started with it (avoids e.g. `aios-team-brain-worktrees/aios-team-brain-foo`).
 *
 * Example: repo `aios-team-brain` + branch `chore/resolver-routing` →
 * `aios/aios-team-brain-worktrees/chore-resolver-routing`.
 */
export function computeWorktreePath(repo, branch) {
  const repoName = path.basename(repo);
  const containerDir = path.join(path.dirname(repo), `${repoName}-worktrees`);
  let task = branch.replace(/\//g, "-");
  const redundantPrefix = `${repoName}-`;
  if (task.startsWith(redundantPrefix)) {
    task = task.slice(redundantPrefix.length);
  }
  return path.join(containerDir, task);
}

export async function cmdWorktree(repo, cfg, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const scriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "link-worktree-env.sh"
  );
  const hookSrc = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "hooks",
    "git",
    "post-checkout"
  );
  const hookDest = path.join(repo, ".git", "hooks", "post-checkout");
  const guardInstaller = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "install-primary-commit-guard.sh"
  );

  // Install the primary-checkout commit guard (blocks feature commits landing on
  // a non-main branch in the primary checkout — forces worktree use). Local-only
  // .git/hooks file, so re-installed here on every `worktree add`/`install-hook`.
  function installGuard() {
    if (!existsSync(guardInstaller)) {
      console.log(c.dim("  primary-commit-guard installer not found — skipping"));
      return false;
    }
    try {
      execFileSync("bash", [guardInstaller], { cwd: repo, stdio: "pipe" });
      console.log(c.dim("  installed primary-commit-guard → blocks feature commits in the primary checkout"));
      return true;
    } catch (e) {
      console.log(c.dim("  primary-commit-guard install failed (non-fatal): ") + (e.message || e));
      return false;
    }
  }

  function installHook() {
    if (!existsSync(hookSrc)) {
      console.log(c.dim("  hook source not found at") + ` ${hookSrc}`);
      return false;
    }
    if (existsSync(hookDest)) {
      const srcContent = readFileSync(hookSrc, "utf8");
      const destContent = readFileSync(hookDest, "utf8");
      if (srcContent === destContent) {
        console.log(c.dim("  post-checkout hook already installed"));
        return true;
      }
    }
    copyFileSync(hookSrc, hookDest);
    chmodSync(hookDest, 0o755);
    console.log(c.dim("  installed post-checkout hook → auto-hydrates new worktrees"));
    return true;
  }

  if (sub === "add") {
    const branch = rest[0];
    if (!branch) die("usage: aios worktree add <feat/branch-name> [--base <ref>]");

    const baseIdx = rest.indexOf("--base");
    const base = baseIdx >= 0 ? rest[baseIdx + 1] : "origin/main";
    const wtPath = computeWorktreePath(repo, branch);
    const containerDir = path.dirname(wtPath);

    // 0. Ensure the auto-hydration hook + primary-commit guard are installed in primary
    installHook();
    installGuard();

    // 0b. Ensure the container dir exists — `git worktree add` does not
    // reliably mkdir -p intermediate directories on every platform/git
    // version, so create it ourselves first.
    if (!existsSync(containerDir)) {
      mkdirSync(containerDir, { recursive: true });
    }

    // 1. Fetch + create worktree
    console.log(
      c.blue(`aios worktree add`) +
        c.dim(`  ${branch} → ${path.relative(path.dirname(repo), wtPath)}`)
    );
    try {
      execFileSync("git", ["-C", repo, "fetch", "origin"], { stdio: "pipe" });
    } catch {
      /* fetch may fail offline; proceed */
    }
    const out = execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, wtPath, base], {
      encoding: "utf8",
      stdio: "pipe",
    });
    console.log(c.dim(out.trim()));

    // The post-checkout hook above fires automatically during `git worktree add`
    // and runs link-worktree-env.sh for us. But also run it synchronously so we
    // can print the result.
    if (existsSync(scriptPath) && existsSync(wtPath)) {
      execFileSync("bash", [scriptPath], { cwd: wtPath, stdio: "inherit" });
    }

    console.log(`\n${c.green("Ready:")} cd ${wtPath}`);
    return;
  }

  if (sub === "init") {
    const dirIdx = rest.indexOf("--dir");
    const targetDir = dirIdx >= 0 ? rest[dirIdx + 1] : process.cwd();
    if (!existsSync(targetDir)) die(`directory not found: ${targetDir}`);
    if (existsSync(scriptPath)) {
      execFileSync("bash", [scriptPath], { cwd: targetDir, stdio: "inherit" });
    } else {
      console.log(c.dim("link-worktree-env.sh not found — nothing to do"));
    }
    return;
  }

  const flags = new Set(rest);

  if (sub === "install-hook") {
    installHook();
    installGuard();
    return;
  }

  if (sub === "uninstall-hook" || flags.has("--uninstall-hook")) {
    if (existsSync(hookDest)) {
      unlinkSync(hookDest);
      console.log(c.dim("removed post-checkout hook"));
    } else {
      console.log(c.dim("no post-checkout hook to remove"));
    }
    return;
  }

  // list worktrees
  if (sub === "list" || !sub) {
    const out = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf8" });
    console.log(c.blue("aios worktree list") + c.dim(`  (${repo})`));
    console.log(out.trim());
    return;
  }

  die(
    "usage: aios worktree add <feat/branch-name> [--base <ref>]\n" +
      "       aios worktree init [--dir <path>]  hydrate config in the given directory\n" +
      "       aios worktree list                  list all worktrees for this repo\n" +
      "       aios worktree install-hook          install the auto-hydration post-checkout hook\n" +
      "       aios worktree uninstall-hook        remove it"
  );
}
