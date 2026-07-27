/**
 * review-bugbot/trusted-env.mjs — the sandboxed trust boundary for every subprocess the
 * local Bugbot gate spawns (git, the Cursor CLI, and the secrets scanner).
 *
 * Owned invariant: every child process this gate runs is invoked against a FIXED trusted
 * binary (never a PATH lookup that a poisoned parent shell could redirect) and a
 * denylisted, reconstructed environment (no inherited GIT_, CURSOR_, NODE_, or LD_ escape
 * hatches). `resolveRequiredBugbotBase` is the sole authority for the diff base: it
 * verifies `origin/main` against the canonical remote outside the checkout with global
 * Git config disabled, so a rewritten local tracking ref or `url.*` rule cannot choose the
 * review base. AIO-540/AIO-558 precedent: extracted verbatim from `scripts/review-bugbot.mjs`
 * (this repo, not a rewrite) — see `docs/v1-operator-loop/domains/safety-unit-extraction.md`.
 *
 * Exported:
 *   trustedReviewerEnv(source)
 *   gitQuiet(args, cwd)
 *   gitRaw(args, cwd)
 *   resolveRequiredBugbotBase(repo, { canonicalUrl })
 *   runLocalSecretsPreflight(worktree, sourceEnv)
 *   CANONICAL_BUGBOT_MAIN_URL
 *   TRUSTED_CURSOR_BIN
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";

export const CANONICAL_BUGBOT_MAIN_URL = "https://github.com/aiosbrain/aios-workspace.git";
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const TRUSTED_GIT_BIN = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
  existsSync
);
const TRUSTED_BASH_BIN = ["/bin/bash", "/usr/bin/bash"].find(existsSync);
const TRUSTED_ACCOUNT = userInfo();
const TRUSTED_HOME = TRUSTED_ACCOUNT.homedir;
export const TRUSTED_CURSOR_BIN = [
  path.join(TRUSTED_HOME, ".local", "bin", "cursor"),
  path.join(TRUSTED_HOME, ".cursor", "bin", "cursor"),
  "/opt/homebrew/bin/cursor",
  "/usr/local/bin/cursor",
  "/usr/bin/cursor",
].find(existsSync);

function trustedUserEnv(source = process.env) {
  const env = { ...source };
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "CURSOR_CONFIG_DIR",
    "ZDOTDIR",
  ]) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (/^CURSOR_.*(?:_PATH|_PATHS|_DIR|_HOME)$/.test(key)) delete env[key];
  }
  env.HOME = TRUSTED_HOME;
  env.USER = TRUSTED_ACCOUNT.username;
  env.LOGNAME = TRUSTED_ACCOUNT.username;
  env.XDG_CONFIG_HOME = path.join(TRUSTED_HOME, ".config");
  env.XDG_DATA_HOME = path.join(TRUSTED_HOME, ".local", "share");
  env.XDG_STATE_HOME = path.join(TRUSTED_HOME, ".local", "state");
  env.XDG_CACHE_HOME = path.join(TRUSTED_HOME, ".cache");
  env.SHELL = "/bin/sh";
  return env;
}

function trustedGitEnv(source = process.env) {
  const env = trustedUserEnv(source);
  // Git has many environment-only configuration and helper escape hatches
  // (`GIT_CONFIG_PARAMETERS`, `GIT_EXEC_PATH`, transport helpers, object dirs,
  // and more). Deny the whole namespace, then add back only the fixed controls
  // below. A partial denylist would let a poisoned parent shell redirect the
  // canonical-main lookup before any review runs.
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_") ||
      /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/i.test(key) ||
      key === "SSL_CERT_FILE" ||
      key === "SSL_CERT_DIR"
    ) {
      delete env[key];
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin";
  return env;
}

function trustedScannerEnv(source = process.env) {
  const env = trustedGitEnv(source);
  for (const key of [
    "BASH_ENV",
    "ENV",
    "CDPATH",
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
  ]) {
    delete env[key];
  }
  env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

export function trustedReviewerEnv(source = process.env) {
  const allowed = {};
  for (const key of [
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
  ]) {
    if (source[key] !== undefined) allowed[key] = source[key];
  }
  return trustedScannerEnv(allowed);
}

function gitQuiet(args, cwd) {
  if (!TRUSTED_GIT_BIN) throw new Error("trusted system git binary not found");
  try {
    return execFileSync(TRUSTED_GIT_BIN, ["--no-replace-objects", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Without this a diff over Node's 1 MB default silently becomes "" — a fail-OPEN
      // that would hand the reviewer an empty changeset.
      maxBuffer: GIT_MAX_BUFFER,
      env: trustedGitEnv(),
    }).trim();
  } catch {
    return "";
  }
}

function gitRaw(args, cwd) {
  if (!TRUSTED_GIT_BIN) throw new Error("trusted system git binary not found");
  try {
    return execFileSync(TRUSTED_GIT_BIN, ["--no-replace-objects", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // Without this a diff over Node's 1 MB default silently becomes "" — a fail-OPEN
      // that would hand the reviewer an empty changeset.
      maxBuffer: GIT_MAX_BUFFER,
      env: trustedGitEnv(),
    });
  } catch {
    return "";
  }
}

function gitRequired(args, cwd) {
  if (!TRUSTED_GIT_BIN) throw new Error("trusted system git binary not found");
  return execFileSync(TRUSTED_GIT_BIN, ["--no-replace-objects", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: GIT_MAX_BUFFER,
    env: trustedGitEnv(),
  }).trim();
}

function gitObjectExists(repo, sha) {
  try {
    gitRequired(["cat-file", "-e", `${sha}^{commit}`], repo);
    return true;
  } catch {
    return false;
  }
}

export function resolveRequiredBugbotBase(repo, { canonicalUrl = CANONICAL_BUGBOT_MAIN_URL } = {}) {
  let listing;
  try {
    // Resolve main outside the checkout with global/system Git configuration disabled,
    // so a rewritten local tracking ref or url.* rule cannot choose the review base.
    listing = gitRequired(["ls-remote", "--exit-code", canonicalUrl, "refs/heads/main"], tmpdir());
  } catch {
    return {
      ok: false,
      reason:
        "cannot verify origin/main against the canonical remote; network access is required even for a clean worktree because committed branch changes must not be skipped",
    };
  }
  const remoteSha = listing.match(/^([a-f0-9]{40,64})\s+refs\/heads\/main$/m)?.[1];
  if (!remoteSha) {
    return { ok: false, reason: "canonical remote did not return a valid main commit" };
  }
  if (!gitObjectExists(repo, remoteSha)) {
    try {
      gitRequired(["fetch", "--no-tags", "--quiet", canonicalUrl, "refs/heads/main"], repo);
    } catch {
      return { ok: false, reason: "cannot fetch the verified canonical main commit" };
    }
  }
  if (!gitObjectExists(repo, remoteSha)) {
    return { ok: false, reason: "canonical fetch did not provide the verified main commit" };
  }
  const baseSha = gitQuiet(["merge-base", "HEAD", remoteSha], repo);
  if (!baseSha) {
    return { ok: false, reason: "current HEAD has no merge base with canonical main" };
  }
  return { ok: true, baseSha, remoteSha };
}

export function runLocalSecretsPreflight(worktree, sourceEnv = process.env) {
  const scanner = path.join(worktree, "validation", "check-secrets.sh");
  if (!TRUSTED_BASH_BIN) {
    return { ok: false, reason: "required trusted bash binary is missing" };
  }
  if (!existsSync(scanner)) {
    return {
      ok: false,
      reason: "required local secrets preflight is missing: validation/check-secrets.sh",
    };
  }
  try {
    execFileSync(TRUSTED_BASH_BIN, [scanner, worktree], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
      env: trustedScannerEnv(sourceEnv),
    });
    return { ok: true };
  } catch {
    // Never return scanner output: even a faulty pattern must not echo secret material
    // into hook evidence or an external agent prompt.
    return {
      ok: false,
      reason:
        "local secrets preflight failed; run `bash validation/check-secrets.sh .` locally and fix every finding before Bugbot",
    };
  }
}

export { gitQuiet, gitRaw, trustedScannerEnv };
