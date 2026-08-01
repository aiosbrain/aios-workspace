#!/usr/bin/env node
/**
 * worktree-self-heal.mjs — SessionStart hook (AIO-482).
 *
 * `aios worktree add` hydrates a new worktree (node_modules symlink, .mcp.json,
 * .claude config, `aios asks wire`). Tools that create worktrees themselves —
 * Conductor (conductor.build) is the motivating case — never call it, so their
 * worktrees get only what git *tracks* and the harness silently half-works.
 *
 * This hook closes that gap from the other end: it runs at the start of every
 * Claude Code session, and if it finds itself in an un-hydrated worktree it runs
 * the same `scripts/link-worktree-env.sh` that `aios worktree add` runs.
 *
 * Ships as ordinary tracked content, so it arrives via `git pull` / `aios update`
 * and self-heals worktrees that already exist. Complements (does not replace) the
 * `hooks/git/post-checkout` hook, which fires earlier but is per-machine state.
 *
 * Contract: ALWAYS exits 0. Never blocks a session, never throws.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/** Marker written by link-worktree-env.sh once hydration completes. */
export const MARKER = path.join(".aios", ".worktree-hydrated");

/** Hard ceiling so a slow hydration can never hang a session start. */
const HYDRATE_TIMEOUT_MS = 120_000;

const HYDRATOR = path.join("scripts", "link-worktree-env.sh");

/**
 * Resolve the toolkit checkout that owns `scripts/link-worktree-env.sh`. A
 * scaffolded workspace only vendors the CLI *shim*, so the hydrator lives in the
 * canonical toolkit checkout. Candidate order matches scaffold/scripts/aios.mjs.
 */
export function findHydrator(here, primary) {
  const candidates = [
    here,
    primary,
    process.env.AIOS_TOOLKIT_DIR,
    path.resolve(primary, "../aios-workspace"),
    path.resolve(primary, "../aios/aios-workspace"),
    path.resolve(primary, "../../aios-workspace"),
  ];
  for (const dir of candidates) {
    if (!dir) continue;
    const p = path.join(dir, HYDRATOR);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * @returns {{status: "hydrated"|"skipped"|"failed", reason?: string}}
 */
export function selfHeal(cwd) {
  let commonDir;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return { status: "skipped", reason: "not a git repo" };
  }
  if (!commonDir) return { status: "skipped", reason: "not a git repo" };

  // `--git-common-dir` is absolute for a linked worktree, relative (".git") in the
  // primary — resolve against cwd either way, then take its parent (the primary).
  const primary = path.dirname(path.resolve(cwd, commonDir));
  if (primary === path.resolve(cwd)) return { status: "skipped", reason: "primary checkout" };
  if (existsSync(path.join(cwd, MARKER))) return { status: "skipped", reason: "already hydrated" };

  const hydrator = findHydrator(path.resolve(cwd), primary);
  if (!hydrator) return { status: "skipped", reason: "link-worktree-env.sh not found" };

  const r = spawnSync("bash", [hydrator], {
    cwd,
    timeout: HYDRATE_TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status === 0) return { status: "hydrated" };
  return {
    status: "failed",
    reason: (r.stderr || r.error?.message || "").trim().split("\n").pop(),
  };
}

// ── entrypoint ──────────────────────────────────────────────────────────────
const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith("worktree-self-heal.mjs");
if (isMain) {
  try {
    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const { status, reason } = selfHeal(cwd);
    if (status === "hydrated") {
      console.log("[aios] un-hydrated worktree detected — AIOS harness config restored.");
    } else if (status === "failed") {
      console.error(`[aios] worktree self-heal failed (non-fatal): ${reason || "unknown"}`);
    }
  } catch {
    /* never block a session */
  }
  process.exit(0);
}
