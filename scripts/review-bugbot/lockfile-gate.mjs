/**
 * review-bugbot/lockfile-gate.mjs — fail-closed compensating checks for content excluded
 * from the review prompt (currently: `package-lock.json`).
 *
 * Owned invariant: an excluded path is ONLY safe to drop from the prompt because these
 * gates run and pass. `npm ci --dry-run` alone only proves the lock and manifest agree — it
 * resolves the tree from the lockfile and never fetches a tarball, so a tampered
 * `integrity` or a `resolved` repointed at an attacker mirror sails straight through it.
 * `inspectLockDelta` is the actual control for that class (registry-host allowlist,
 * integrity-hash presence/consistency, workspace-link escape checks) and
 * `verifyLockfileResolves` is the lock↔manifest desync check, run under the pinned Node
 * with lifecycle scripts disabled so verifying an untrusted lockfile cannot execute code.
 * ANY failure blocks. AIO-558: extracted verbatim from `scripts/review-bugbot.mjs` (this
 * repo, not a rewrite) — see `docs/v1-operator-loop/domains/safety-unit-extraction.md`.
 *
 * Exported:
 *   runExcludedPathGates(worktree, excluded, changedFiles, { baseSha })
 *   inspectLockDelta(worktree, lockPath, baseSha, { allowedHosts })
 *   DEFAULT_LOCK_RESOLVED_HOSTS
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitRaw, trustedScannerEnv } from "./trusted-env.mjs";

const LOCKFILE_VERIFY_TIMEOUT_MS = 120_000;
/** Hosts a changed lockfile entry may resolve from. Anything else fails closed. */
export const DEFAULT_LOCK_RESOLVED_HOSTS = ["registry.npmjs.org"];
const LOCK_SUMMARY_CAP = 200;
// npm ships as a Node script behind an `#!/usr/bin/env node` shebang, so it cannot be
// spawned under a sanitized PATH. Run its CLI entry point with THIS node binary instead:
// no PATH lookup, no shebang, and the interpreter is the pinned one by construction.
const TRUSTED_NPM_CLI_JS = [
  path.join(
    path.dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  ),
  "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
  "/usr/local/lib/node_modules/npm/bin/npm-cli.js",
  "/usr/lib/node_modules/npm/bin/npm-cli.js",
].find(existsSync);

function pinnedNodeMajor(worktree) {
  try {
    return parseInt(
      readFileSync(path.join(worktree, ".nvmrc"), "utf8").trim().replace(/^v/, ""),
      10
    );
  } catch {
    return null;
  }
}

function lockPackages(text, label) {
  if (!String(text).trim()) return new Map();
  const parsed = JSON.parse(text);
  if (!parsed.packages) {
    throw new Error(`${label} has no "packages" map (lockfileVersion 2+ is required)`);
  }
  return new Map(
    Object.entries(parsed.packages)
      .filter(([key]) => key)
      .map(([key, entry]) => [key, entry ?? {}])
  );
}

/** The registry host of a tarball `resolved`, or null when it is not an http(s) URL. */
function registryHost(resolved) {
  try {
    const url = new URL(resolved);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : null;
  } catch {
    return null;
  }
}

/**
 * A workspace `link` entry's `resolved` is a filesystem path, not a URL — `npm ci`'s own
 * EUSAGE rejection of an out-of-tree link target is the only thing standing between this
 * repo and a lockfile entry that symlinks somewhere outside the worktree (e.g. `../../evil`
 * or an absolute path). That defense lives in npm, not in this inspector, so a reviewer
 * reading `inspectLockDelta`'s output alone would never know it was relied on. Resolve the
 * target against the worktree root ourselves and fail closed the same way here.
 */
function linkEscapesWorktree(worktree, resolved) {
  const root = path.resolve(worktree);
  const target = path.resolve(root, resolved);
  return target !== root && !target.startsWith(root + path.sep);
}

/**
 * Inspect the lockfile delta the reviewer no longer sees. `npm ci --dry-run` only proves
 * the lock and the manifest agree — it resolves the tree from the lockfile and never
 * fetches a tarball, so a tampered `integrity` or a `resolved` repointed at an attacker
 * mirror sails straight through it. These checks are the actual control for that class,
 * and the summary they return puts the delta back in front of the reviewer.
 */
export function inspectLockDelta(
  worktree,
  lockPath,
  baseSha,
  { allowedHosts = DEFAULT_LOCK_RESOLVED_HOSTS } = {}
) {
  let before;
  let after;
  try {
    before = lockPackages(
      gitRaw(["show", `${baseSha}:${lockPath}`], worktree),
      "the base lockfile"
    );
    after = lockPackages(readFileSync(path.join(worktree, lockPath), "utf8"), lockPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { failures: [`${lockPath} could not be parsed for review: ${detail}`], summary: [] };
  }

  const failures = [];
  const summary = [];
  for (const [name, next] of after) {
    const previous = before.get(name);
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) continue;
    // A workspace link is a symlink into this same repo, not a downloaded artifact: it has
    // no tarball, no registry and no integrity hash by construction. Its target IS reviewed
    // (it is a path inside the changeset), so the tarball rules below must not fire on it.
    const linked = next.link === true;
    const host = !linked && next.resolved ? registryHost(next.resolved) : null;
    const integrityChanged = (previous?.integrity ?? null) !== (next.integrity ?? null);
    summary.push(
      `${name} ${previous?.version ?? "(added)"} → ${next.version ?? "(none)"}` +
        ` [${linked ? `workspace link ${next.resolved ?? ""}`.trim() : (host ?? "no tarball")}]` +
        `${integrityChanged ? " integrity changed" : ""}`
    );
    if (linked) {
      if (next.resolved && linkEscapesWorktree(worktree, next.resolved)) {
        failures.push(
          `${lockPath}: ${name} is a workspace link whose target ${next.resolved} resolves outside the worktree`
        );
      }
      continue;
    }

    if (next.resolved && !host) {
      failures.push(
        `${lockPath}: ${name} resolves from ${next.resolved}, which is not a registry tarball`
      );
    } else if (next.resolved && !allowedHosts.includes(host)) {
      failures.push(
        `${lockPath}: ${name} resolves from ${host}, which is not an allowed registry host`
      );
    }
    if (previous?.integrity && !next.integrity) {
      failures.push(`${lockPath}: ${name} lost its integrity hash`);
    }
    if (!previous && next.resolved && !next.integrity) {
      failures.push(`${lockPath}: ${name} was added with a tarball but no integrity hash`);
    }
    if (
      previous?.integrity &&
      next.integrity &&
      integrityChanged &&
      previous.version === next.version &&
      previous.resolved === next.resolved
    ) {
      failures.push(
        `${lockPath}: ${name} changed its integrity hash without changing version or resolved URL`
      );
    }
  }
  for (const name of before.keys()) {
    if (!after.has(name)) summary.push(`${name} ${before.get(name).version ?? ""} → (removed)`);
  }
  return { failures, summary };
}

/**
 * Verify a changed lockfile resolves cleanly in a throwaway checkout under the pinned Node,
 * with lifecycle scripts disabled so verifying an untrusted lockfile cannot execute code.
 * This is the lock↔manifest desync check ONLY — content trust comes from `inspectLockDelta`.
 */
function verifyLockfileResolves(worktree, lockPath) {
  const dir = path.posix.dirname(lockPath) === "." ? "" : path.posix.dirname(lockPath);
  const pinned = pinnedNodeMajor(worktree);
  const running = parseInt(process.versions.node.split(".")[0], 10);
  if (pinned && pinned !== running) {
    return `${lockPath} changed but the lockfile verification must run under the pinned Node ${pinned} (running Node ${running})`;
  }
  if (!TRUSTED_NPM_CLI_JS) {
    return `${lockPath} changed but npm's CLI entry point could not be located to verify it`;
  }
  const temp = mkdtempSync(path.join(tmpdir(), "aios-bugbot-lockfile-"));
  try {
    // The manifest set is what `npm ci` reads: the lockfile plus every tracked package.json
    // (workspaces included). Nothing else is copied, so no project code can run.
    const manifests = gitRaw(
      ["ls-files", "-z", "--", ":(glob)**/package.json", "package.json"],
      worktree
    )
      .split("\0")
      .filter(Boolean);
    for (const rel of [lockPath, ...manifests]) {
      const source = path.join(worktree, rel);
      if (!existsSync(source)) continue;
      mkdirSync(path.join(temp, path.dirname(rel)), { recursive: true });
      copyFileSync(source, path.join(temp, rel));
    }
    const env = trustedScannerEnv();
    // npm shells out to git for git-backed dependencies; keep node's own directory first.
    env.PATH = [path.dirname(process.execPath), env.PATH].join(":");
    execFileSync(
      process.execPath,
      [TRUSTED_NPM_CLI_JS, "ci", "--ignore-scripts", "--dry-run", "--no-audit", "--no-fund"],
      {
        cwd: path.join(temp, dir),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: LOCKFILE_VERIFY_TIMEOUT_MS,
        env,
      }
    );
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return `${lockPath} changed but failed clean verification (npm ci --ignore-scripts in a temp checkout): ${detail}`;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Fail-closed gates that stand in for reviewer eyes on the paths excluded from the prompt.
 * ANY failure blocks — an excluded path is only safe because these run — and the summaries
 * they return are fed back into both prompts so the delta is disclosed, not hidden.
 */
export function runExcludedPathGates(worktree, excluded, changedFiles, { baseSha } = {}) {
  const failures = [];
  const summaries = {};
  const lockfiles = excluded.filter(
    (file) => path.posix.basename(file.path) === "package-lock.json"
  );
  for (const lock of lockfiles) {
    const dir = path.posix.dirname(lock.path);
    const manifest = dir === "." ? "package.json" : `${dir}/package.json`;
    if (!changedFiles.includes(manifest)) {
      failures.push(
        `${lock.path} changed without a matching ${manifest} change; a dependency change must be visible in the reviewed manifest`
      );
      continue;
    }
    if (baseSha) {
      const delta = inspectLockDelta(worktree, lock.path, baseSha);
      failures.push(...delta.failures);
      const shown = delta.summary.slice(0, LOCK_SUMMARY_CAP);
      if (delta.summary.length > shown.length) {
        shown.push(`… and ${delta.summary.length - shown.length} more changed entries`);
      }
      summaries[lock.path] = shown;
    }
    const failure = verifyLockfileResolves(worktree, lock.path);
    if (failure) failures.push(failure);
  }
  return { ok: !failures.length, reason: failures.join("; "), summaries };
}
