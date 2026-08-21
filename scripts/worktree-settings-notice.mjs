#!/usr/bin/env node
/**
 * worktree-settings-notice.mjs — hydration-time settings staleness signal
 * (AIO-1014, follow-up to AIO-920).
 *
 * Post-AIO-920, worktree hydration never overwrites a `.claude/settings.json`
 * committed in the worktree's branch — the branch copy is authoritative. The
 * deliberate consequence: a long-lived branch is pinned to its branch-point
 * hook set, so a new PreToolUse guard (or any hook) landing on main never
 * reaches existing worktrees, and the hydration skip message reads as success.
 *
 * This script is that missing signal. Invoked by scripts/link-worktree-env.sh
 * right after the settings step, it compares the hook list in the branch's
 * committed settings against origin/main's and prints ONE line naming what the
 * branch lacks. Read-only by design: it NEVER rewrites the file (picking the
 * hooks up is a `git merge main` decision, not hydration's), and it fails
 * quiet — no repo, no base ref, no committed copy on either side, or
 * unparseable JSON all mean "say nothing" rather than a false alarm.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SETTINGS_PATH = ".claude/settings.json";
// First ref that resolves wins. origin/main is what `aios worktree add` bases
// on; the bare locals cover fixtures and repos with no remote.
const BASE_REF_CANDIDATES = ["origin/main", "origin/master", "main", "master"];

// A hook's identity is `<event>:<script basename>` for every script-looking
// token in the command string — robust to the shapes settings.json actually
// carries (`${CLAUDE_PROJECT_DIR}/hooks/x.mjs`, `/bin/sh "…/y.sh" args`, and
// inline-shell commands that exec a guard). Matcher and argument changes are
// deliberately NOT drift: the notice is about hooks that are absent outright.
const SCRIPT_TOKEN = /[\w.-]+\.(?:mjs|cjs|js|sh|py)\b/g;

/** Hook identities in a settings.json text → Set<"Event:script">, or null if unparseable. */
export function extractHookIdentities(settingsText) {
  let parsed;
  try {
    parsed = JSON.parse(settingsText);
  } catch {
    return null;
  }
  const hooks = parsed?.hooks;
  const ids = new Set();
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return ids;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups)
      for (const h of group?.hooks ?? [])
        for (const m of String(h?.command ?? "").matchAll(SCRIPT_TOKEN))
          ids.add(`${event}:${m[0]}`);
  }
  return ids;
}

/** Identities present in main's settings but absent from the branch's, sorted. */
export function diffHookIdentities(branchText, mainText) {
  const branch = extractHookIdentities(branchText);
  const main = extractHookIdentities(mainText);
  if (!branch || !main) return []; // fail-quiet: never alarm off unparseable JSON
  return [...main].filter((id) => !branch.has(id)).sort();
}

/** The one-line notice, or null when there is nothing to say. */
export function formatNotice(missing) {
  if (!missing.length) return null;
  return (
    `notice: branch settings behind main — missing hook(s): ${missing.join(", ")} ` +
    `(hydration keeps the branch's committed ${SETTINGS_PATH}; merge main to pick them up)`
  );
}

/**
 * Compare the worktree's HEAD-committed settings against the base ref's and
 * return the notice line, or null. Silent (null) on any git failure.
 */
export function runNotice({ worktree = process.cwd(), env = process.env } = {}) {
  const show = (ref) =>
    execFileSync("git", ["-C", worktree, "show", `${ref}:${SETTINGS_PATH}`], {
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
  let branchText;
  try {
    branchText = show("HEAD");
  } catch {
    return null; // not a repo, or the branch has no committed settings (seed path)
  }
  for (const ref of BASE_REF_CANDIDATES) {
    let mainText;
    try {
      mainText = show(ref);
    } catch {
      continue; // ref missing, or settings not committed at that ref
    }
    return formatNotice(diffHookIdentities(branchText, mainText));
  }
  return null;
}

// ── CLI: node worktree-settings-notice.mjs [--worktree <dir>] ────────────────
// Prints the notice (if any) and always exits 0 — a signal must never fail the
// hydration that surfaces it.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const i = process.argv.indexOf("--worktree");
  const worktree = i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : process.cwd();
  const notice = runNotice({ worktree });
  if (notice) console.log(notice);
}
