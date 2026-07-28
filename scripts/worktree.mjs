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

const HOOK_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "git",
  "post-checkout"
);
const PRIMARY_GUARD_INSTALLER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "install-primary-commit-guard.sh"
);
const PUSH_GATE_INSTALLER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "install-leak-gate-push-hook.sh"
);
/**
 * Interpreter used to run the backstop installers. A bare `"bash"` is resolved through
 * `$PATH`, so a writable directory earlier in `$PATH` could substitute the shell that
 * installs our security guards — the one place in this file where that matters. Both
 * installers are bash-3.2 compatible, so a fixed system path works on macOS and Linux
 * alike; the bare name survives only as a last resort for layouts without either
 * (e.g. NixOS), where the guard cannot be installed at all otherwise.
 */
const BASH = ["/bin/bash", "/usr/bin/bash"].find((candidate) => existsSync(candidate)) ?? "bash";

/**
 * Where the post-checkout hook lives for `repo`. Resolved via `--git-common-dir`, not
 * `<repo>/.git`: inside a linked worktree `.git` is a *file*, and hooks are shared from
 * the primary's common dir — so a naive join would point at a path that cannot exist and
 * silently report "no hook installed" for a repo that has one.
 */
export function postCheckoutHookPath(repo) {
  let commonDir = ".git";
  try {
    commonDir = execFileSync("git", ["-C", repo, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* not a git repo — fall through to the conventional path */
  }
  return path.join(path.resolve(repo, commonDir), "hooks", "post-checkout");
}

/**
 * Install the auto-hydration `post-checkout` hook into `repo`'s .git/hooks.
 * Idempotent (no-op when already byte-identical) and never throws — it is called
 * both from `aios worktree add`/`install-hook` (verbose) and as a silent side
 * effect of `aios update`/`aios onboard` (AIO-482), so that worktrees created by
 * tools that never call `aios worktree add` — Conductor et al — still hydrate.
 *
 * @param {string} repo   the primary checkout
 * @param {{quiet?: boolean}} [opts]
 * @returns {"installed"|"present"|"skipped"} what happened
 */
export function installPostCheckoutHook(repo, { quiet = false } = {}) {
  const say = (msg) => {
    if (!quiet) console.log(c.dim(msg));
  };
  try {
    if (!existsSync(HOOK_SRC)) {
      say(`  hook source not found at ${HOOK_SRC}`);
      return "skipped";
    }
    const hookDest = postCheckoutHookPath(repo);
    if (!existsSync(path.dirname(hookDest))) {
      say("  no .git/hooks dir — skipping post-checkout hook");
      return "skipped";
    }
    if (existsSync(hookDest) && readFileSync(HOOK_SRC, "utf8") === readFileSync(hookDest, "utf8")) {
      say("  post-checkout hook already installed");
      return "present";
    }
    copyFileSync(HOOK_SRC, hookDest);
    chmodSync(hookDest, 0o755);
    // Printed even when quiet: a newly installed hook is a real state change worth
    // one line. An already-present hook stays silent.
    console.log(c.dim("  installed post-checkout hook → auto-hydrates new worktrees"));
    return "installed";
  } catch {
    return "skipped";
  }
}

function runBackstopInstaller(repo, installer, label, successMessage, { quiet = false } = {}) {
  if (!existsSync(installer)) {
    if (!quiet) console.log(c.dim(`  ${label} installer not found — skipping`));
    return "skipped";
  }
  try {
    execFileSync(BASH, [installer], { cwd: repo, stdio: "pipe" });
    if (!quiet) console.log(c.dim(`  installed ${successMessage}`));
    return "installed";
  } catch (error) {
    if (!quiet) {
      console.log(c.dim(`  ${label} install failed (non-fatal): `) + (error.message || error));
    }
    return "failed";
  }
}

/**
 * Hydrate every machine-local worktree backstop. This is the shared contract used by
 * worktree add/init, onboarding, and update so a fresh clone cannot receive only the
 * post-checkout convenience hook while remaining publishable without commit/push guards.
 */
export function installWorktreeSafetyBackstops(repo, { quiet = false, productOnly = false } = {}) {
  const gateAvailable = existsSync(path.join(repo, "scripts", "leak-gate.sh"));
  return {
    postCheckout: installPostCheckoutHook(repo, { quiet }),
    primaryCommit:
      !productOnly || gateAvailable
        ? runBackstopInstaller(
            repo,
            PRIMARY_GUARD_INSTALLER,
            "primary-commit-guard",
            "primary-commit-guard → blocks all commits in the primary checkout",
            { quiet }
          )
        : "skipped",
    prePush: gateAvailable
      ? runBackstopInstaller(
          repo,
          PUSH_GATE_INSTALLER,
          "leak-gate push hook",
          "pre-push leak gate → blocks publishing confidential material",
          { quiet }
        )
      : "skipped",
  };
}

export async function cmdWorktree(repo, cfg, args) {
  const sub = args[0];
  const rest = args.slice(1);
  const scriptPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "link-worktree-env.sh"
  );
  const hookDest = postCheckoutHookPath(repo);
  const installSafety = () => installWorktreeSafetyBackstops(repo);

  if (sub === "add") {
    const branch = rest[0];
    if (!branch) die("usage: aios worktree add <feat/branch-name> [--base <ref>]");

    const baseIdx = rest.indexOf("--base");
    const base = baseIdx >= 0 ? rest[baseIdx + 1] : "origin/main";
    const wtPath = computeWorktreePath(repo, branch);
    const containerDir = path.dirname(wtPath);

    // 0. Ensure the auto-hydration hook + primary-commit guard are installed in primary
    installSafety();

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
    installSafety();
    if (existsSync(scriptPath)) {
      execFileSync("bash", [scriptPath], { cwd: targetDir, stdio: "inherit" });
    } else {
      console.log(c.dim("link-worktree-env.sh not found — nothing to do"));
    }
    return;
  }

  // `aios worktree doctor` (AIO-482) — read-only readiness report for the three
  // hydration layers a worktree-creating tool (Conductor et al) can trigger.
  if (sub === "doctor") {
    const settingsPath = path.join(repo, ".claude", "settings.json");
    let sessionStartWired = false;
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      sessionStartWired = (settings.hooks?.SessionStart ?? []).some((g) =>
        (g.hooks ?? []).some((h) => String(h.command ?? "").includes("worktree-self-heal.mjs"))
      );
    } catch {
      /* missing/invalid settings.json → not wired */
    }
    const checks = [
      [existsSync(hookDest), "post-checkout hook installed (hydrates at worktree creation)"],
      [sessionStartWired, "SessionStart self-heal hook wired in .claude/settings.json"],
      [
        existsSync(path.join(repo, ".conductor", "settings.toml")),
        ".conductor/settings.toml present (Conductor runs it as its setup script)",
      ],
    ];
    console.log(c.blue("aios worktree doctor") + c.dim(`  (${repo})`));
    for (const [ok, label] of checks) console.log(`  ${ok ? c.green("✓") : c.dim("·")} ${label}`);
    // The SessionStart layer alone is the guarantee; the other two are earlier triggers.
    console.log(
      sessionStartWired
        ? `\n${c.green("Conductor support: ready")}`
        : `\n${c.dim("Conductor support: not wired")} — run ${c.blue("aios update")}`
    );
    return;
  }

  const flags = new Set(rest);

  if (sub === "install-hook") {
    installSafety();
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
      "       aios worktree doctor                report auto-hydration readiness (Conductor et al)\n" +
      "       aios worktree install-hook          install the auto-hydration post-checkout hook\n" +
      "       aios worktree uninstall-hook        remove it"
  );
}
