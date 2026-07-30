/**
 * repo-bootstrap/engine.mjs — the stamping engine behind `aios repo-bootstrap` (AIO-602).
 *
 * Re-run + drift semantics REUSE the toolkit's 3-way decision table (decideMerge from
 * scripts/toolkit-merge.mjs) with content HASHES as the three versions — equality is
 * all the table uses, so hashes are a faithful substitute for content and the version
 * stamp stays small:
 *
 *   base   = sha256 recorded in .aios-bootstrap-version at the last stamp
 *   mine   = sha256 of the target's current file
 *   theirs = sha256 of the toolkit's new source content
 *
 *   noop        -> unchanged
 *   create      -> write (file absent in target)
 *   take-theirs -> write (target never edited it; source moved)
 *   keep-mine   -> local edit, source unchanged: KEEP the local file, keep the OLD
 *                  recorded base (so a later source change still 3-ways correctly),
 *                  report as drift.
 *   merge/fallback -> both sides changed (or no recorded base): keep the local file,
 *                  write the new source to <dest>.aios-incoming — surface, never guess.
 *
 * SEED_IF_ABSENT is create-only: an existing destination is never read, merged,
 * overwritten, or deleted — including with --force.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decideMerge } from "../toolkit-merge.mjs";
import {
  BOOTSTRAP_MANAGED,
  BOOTSTRAP_SEED_IF_ABSENT,
  BOOTSTRAP_VERSION,
  BOOTSTRAP_VERSION_FILE,
  TRANSFORMS,
} from "./manifest.mjs";

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");

const sha256 = (content) =>
  content === undefined
    ? undefined
    : "sha256:" + createHash("sha256").update(content).digest("hex");

const readIfExists = (abs) => (existsSync(abs) ? readFileSync(abs, "utf8") : undefined);

/** Substitute {{KEY}} placeholders; throws on any placeholder left unresolved. */
export function renderTemplate(text, params) {
  const out = text.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) =>
    Object.hasOwn(params, key) ? params[key] : m
  );
  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`repo-bootstrap: unresolved template placeholder ${leftover[0]}`);
  return out;
}

/** Apply a named fail-closed transform; throws if any anchor is missing. */
export function applyTransform(name, content) {
  const steps = TRANSFORMS[name];
  if (!steps) throw new Error(`repo-bootstrap: unknown transform '${name}'`);
  let out = content;
  for (const { find, replace } of steps) {
    if (!out.includes(find)) {
      throw new Error(
        `repo-bootstrap: transform '${name}' anchor not found — the upstream source drifted; ` +
          `refusing to stamp a guard with unverified semantics (missing: ${find})`
      );
    }
    out = out.split(find).join(replace);
  }
  return out;
}

/** Resolve one manifest entry to its stamped content. */
export function resolveSource(entry, toolkitDir, params) {
  let content;
  if (entry.src) {
    const abs = path.join(toolkitDir, entry.src);
    if (!existsSync(abs)) throw new Error(`repo-bootstrap: source missing: ${entry.src}`);
    content = readFileSync(abs, "utf8");
  } else {
    const abs = path.join(ASSETS_DIR, entry.asset);
    if (!existsSync(abs)) throw new Error(`repo-bootstrap: asset missing: ${entry.asset}`);
    content = readFileSync(abs, "utf8");
    if (entry.params) content = renderTemplate(content, params);
  }
  if (entry.transform) content = applyTransform(entry.transform, content);
  return content;
}

function writeStamped(targetDir, entry, content) {
  const abs = path.join(targetDir, entry.dest);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  if (entry.exec) chmodSync(abs, 0o755);
}

export function readVersionStamp(targetDir) {
  const raw = readIfExists(path.join(targetDir, BOOTSTRAP_VERSION_FILE));
  if (raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null; // unreadable stamp = no base — every managed decision falls back safely
  }
}

function toolkitSha(toolkitDir) {
  try {
    // NOSONAR javascript:S4036 — `git` comes from the operator's PATH by design;
    // a developer CLI has no fixed, unwritable install location across machines.
    return execFileSync("git", ["-C", toolkitDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(); // NOSONAR
  } catch {
    return "unknown";
  }
}

function toolkitSemver(toolkitDir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(toolkitDir, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Plan (and optionally apply) the stamp. Pure of process.exit; returns a report.
 *
 * @param {object} o
 * @param {string} o.toolkitDir  the canonical toolkit checkout (stamp SOURCE)
 * @param {string} o.targetDir   the split repo being bootstrapped (must be a git root)
 * @param {object} [o.params]    template params (LINT_SCRIPT, TEST_SCRIPT, REPO_NAME…)
 * @param {boolean} [o.check]    report-only: no writes, no hooks, no version stamp
 * @param {boolean} [o.force]    overwrite drifted MANAGED files (seeds stay untouched)
 */
export function runBootstrap({ toolkitDir, targetDir, params = {}, check = false, force = false }) {
  const priorFiles = readVersionStamp(targetDir)?.files ?? {};
  const ctx = { toolkitDir, targetDir, params, check, force, priorFiles, nextFiles: {} };
  const report = {
    created: [],
    updated: [],
    unchanged: [],
    keptLocal: [],
    conflicts: [],
    forced: [],
    seeded: [],
    seedKept: [],
    hooks: [],
  };

  for (const entry of BOOTSTRAP_MANAGED) applyManagedEntry(entry, ctx, report);
  for (const entry of BOOTSTRAP_SEED_IF_ABSENT) applySeedEntry(entry, ctx, report);
  if (!check) {
    installGitHooks(targetDir, report);
    writeVersionStamp(ctx);
  }

  report.drift = [...report.keptLocal, ...report.conflicts];
  return report;
}

/** One MANAGED entry: 3-way decide (over hashes) → write / keep / surface. */
function applyManagedEntry(entry, ctx, report) {
  const theirsContent = resolveSource(entry, ctx.toolkitDir, ctx.params);
  const theirs = sha256(theirsContent);
  const abs = path.join(ctx.targetDir, entry.dest);
  const mine = sha256(readIfExists(abs));
  const base = ctx.priorFiles[entry.dest];
  const decision = decideMerge({ base, mine, theirs });

  if (decision === "noop") {
    report.unchanged.push(entry.dest);
    ctx.nextFiles[entry.dest] = theirs;
    if (!ctx.check && entry.exec) chmodSync(abs, 0o755); // re-assert the exec bit
  } else if (decision === "create" || decision === "take-theirs") {
    if (!ctx.check) writeStamped(ctx.targetDir, entry, theirsContent);
    report[decision === "create" ? "created" : "updated"].push(entry.dest);
    ctx.nextFiles[entry.dest] = theirs;
  } else if (ctx.force) {
    if (!ctx.check) writeStamped(ctx.targetDir, entry, theirsContent);
    report.forced.push(entry.dest);
    ctx.nextFiles[entry.dest] = theirs;
  } else if (decision === "keep-mine") {
    // Local edit, source unchanged: keep the file AND the old base so a future
    // source change still resolves against what was actually stamped.
    report.keptLocal.push(entry.dest);
    ctx.nextFiles[entry.dest] = base;
  } else {
    // merge (all three differ) or fallback (no recorded base, local file differs):
    // never guess — keep the local file, surface the new source beside it.
    if (!ctx.check) {
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs + ".aios-incoming", theirsContent);
    }
    report.conflicts.push(entry.dest);
    if (base !== undefined) ctx.nextFiles[entry.dest] = base;
  }
}

/** One SEED_IF_ABSENT entry: create-only — an existing file is never touched. */
function applySeedEntry(entry, ctx, report) {
  if (existsSync(path.join(ctx.targetDir, entry.dest))) {
    // Never read, merge, overwrite, or delete an existing seed — even with --force.
    report.seedKept.push(entry.dest);
    return;
  }
  if (!ctx.check)
    writeStamped(ctx.targetDir, entry, resolveSource(entry, ctx.toolkitDir, ctx.params));
  report.seeded.push(entry.dest);
}

function writeVersionStamp({ toolkitDir, targetDir, params, nextFiles }) {
  const stamp = {
    bootstrapVersion: BOOTSTRAP_VERSION,
    toolkitSha: toolkitSha(toolkitDir),
    toolkitSemver: toolkitSemver(toolkitDir),
    stampedAt: new Date().toISOString(),
    params,
    files: nextFiles,
  };
  writeFileSync(
    path.join(targetDir, BOOTSTRAP_VERSION_FILE),
    JSON.stringify(stamp, null, 2) + "\n"
  );
}

/**
 * Install the git-level hooks from the target's OWN stamped copies (no toolkit
 * reference — a bootstrapped repo must guard itself with no adjacent core checkout).
 */
function installGitHooks(targetDir, report) {
  // NOSONAR javascript:S4036 — `bash`/`git` come from the operator's PATH by design
  // (developer CLI, no fixed install location); the script args are absolute paths.
  const run = (cmd, args) =>
    execFileSync(cmd, args, { cwd: targetDir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }); // NOSONAR

  // pre-commit + pre-merge-commit + reference-transaction (worktree guards).
  run("bash", [path.join(targetDir, ".harness/hooks/git/install-primary-commit-guard.sh")]);
  report.hooks.push("pre-commit", "pre-merge-commit", "reference-transaction");

  // pre-push leak gate (chains any pre-existing pre-push hook).
  run("bash", [path.join(targetDir, "scripts/install-leak-gate-push-hook.sh")]);
  report.hooks.push("pre-push");

  // post-checkout worktree self-hydration. Installed only when absent or ours —
  // a foreign post-checkout hook is preserved untouched (surfaced in the report).
  const hooksDir = run("git", ["rev-parse", "--git-path", "hooks"]).trim();
  const hooksAbs = path.isAbsolute(hooksDir) ? hooksDir : path.join(targetDir, hooksDir);
  const dest = path.join(hooksAbs, "post-checkout");
  const src = path.join(targetDir, ".harness/hooks/git/post-checkout");
  const marker = "aios-bootstrap post-checkout";
  const current = readIfExists(dest);
  if (current === undefined || current.includes(marker)) {
    mkdirSync(hooksAbs, { recursive: true });
    writeFileSync(dest, readFileSync(src, "utf8"));
    chmodSync(dest, 0o755);
    report.hooks.push("post-checkout");
  } else {
    report.hooks.push("post-checkout (foreign hook preserved — install manually if wanted)");
  }
}

/** Remove a partial `.aios-incoming` set (used by tests / conflict resolution flows). */
export function clearIncoming(targetDir) {
  for (const entry of BOOTSTRAP_MANAGED) {
    const p = path.join(targetDir, entry.dest + ".aios-incoming");
    if (existsSync(p)) rmSync(p);
  }
}
