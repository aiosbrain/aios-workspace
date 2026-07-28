#!/usr/bin/env node
/**
 * Runtime-neutral Stop/idle gate for the local Cursor Bugbot reviewer.
 *
 * Claude, Codex, Cursor, and OpenCode adapters all call this file. The expensive
 * blocked verdicts are cached by the exact base-to-worktree fingerprint in worktree-local
 * git state. Clear verdicts are never trusted from disk. The child Cursor reviewer
 * runs outside the checkout so project Stop hooks cannot recursively launch the gate.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUGBOT_BLOCKED_MARKER,
  BUGBOT_CLEAR_MARKER,
  captureBranchDiff,
  LOCAL_BUGBOT_DIFF_CAP,
  REQUIRED_BUGBOT_FAIL_ON,
  REQUIRED_BUGBOT_MODEL,
  resolveRequiredBugbotBase,
  REVIEW_WALL_CLOCK_BUDGET_MS,
} from "../scripts/review-bugbot.mjs";
import { resolveCanonicalBranchHead } from "../scripts/review-bugbot/trusted-env.mjs";

const REVIEW_CHILD_TIMEOUT_SECONDS = 400;
// Grace on top of the child's own absolute wall-clock budget. Raised from 20s: the parent
// kill must be the LAST resort, well after the child has had time to fail closed itself
// and write a verdict, otherwise the kill lands mid-review and produces no verdict at all.
const REVIEW_PROCESS_GRACE_MS = 60_000;
const NATIVE_HOOK_GRACE_MS = 60_000;
// The handoff exists so a run that was queued behind the lock sees the real failure
// instead of spawning its own duplicate review. That window is seconds; anything later is
// a legitimate retry of a transient infrastructure failure, so the TTL stays short —
// a long one would lock the operator who owns the failure out of their own retry.
const ERROR_HANDOFF_TTL_MS = 120_000;
const LOCK_POLL_MS = 250;
const LOCK_INITIALIZATION_GRACE_MS = 5_000;
const OUTPUT_CAP = 9_000;
const GATE_POLICY_VERSION = "medium-read-only-code-security-secrets-v23";
const VALID_RUNTIMES = new Set(["claude", "codex", "cursor", "opencode"]);
const TRUSTED_GIT_BIN = ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find(
  existsSync
);

function git(args, cwd) {
  if (!TRUSTED_GIT_BIN) throw new Error("trusted system git binary not found");
  return execFileSync(TRUSTED_GIT_BIN, ["--no-replace-objects", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: hardenedChildEnv(process.env),
  }).trim();
}

export function hardenedChildEnv(source) {
  const env = { ...source };
  for (const key of [
    "AIOS_BUGBOT_MODEL",
    "AIOS_BUGBOT_HOOK_NONCE",
    "AIOS_BUGBOT_DISABLE",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_EXTRA_CA_CERTS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_LIBRARY_PATH",
    "BASH_ENV",
    "ENV",
    "CDPATH",
  ]) {
    delete env[key];
  }
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

function gitMaybe(args, cwd) {
  try {
    return git(args, cwd);
  } catch {
    return "";
  }
}

function stripAnsi(value) {
  const input = String(value ?? "");
  let output = "";
  for (let index = 0; index < input.length; index++) {
    if (input.charCodeAt(index) === 27 && input[index + 1] === "[") {
      index += 2;
      while (index < input.length && input[index] !== "m") index++;
      continue;
    }
    output += input[index];
  }
  return output;
}

function capOutput(value) {
  const clean = stripAnsi(value).trim();
  if (clean.length <= OUTPUT_CAP) return clean;
  return `${clean.slice(0, OUTPUT_CAP)}\n… (Bugbot output truncated by hook)`;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function statePath(repo) {
  const rel = git(["rev-parse", "--git-path", "aios/local-bugbot-gate.json"], repo);
  return path.resolve(repo, rel);
}

function lockOwner(file) {
  try {
    const parsed = JSON.parse(readFileSync(`${file}.lock`, "utf8"));
    return Number.isInteger(parsed?.pid) && parsed.pid > 0 ? parsed.pid : null;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function openOwnedLock(lock) {
  const fd = openSync(lock, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return { fd, lock };
  } catch (error) {
    closeSync(fd);
    rmSync(lock, { force: true });
    throw error;
  }
}

function acquireLock(file, staleMs) {
  const lock = `${file}.lock`;
  mkdirSync(path.dirname(lock), { recursive: true });
  try {
    return openOwnedLock(lock);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const owner = lockOwner(file);
      const abandoned = owner
        ? !processIsAlive(owner)
        : Date.now() - statSync(lock).mtimeMs > Math.min(staleMs, LOCK_INITIALIZATION_GRACE_MS);
      if (abandoned) {
        rmSync(lock, { force: true });
        return openOwnedLock(lock);
      }
    } catch {
      // A concurrent process may have removed it; the next turn can retry.
    }
    return null;
  }
}

function releaseLock(lock) {
  if (!lock) return;
  try {
    closeSync(lock.fd);
  } finally {
    rmSync(lock.lock, { force: true });
  }
}

/**
 * Human-readable account of a review whose child process died without a verdict. The
 * operator needs to distinguish "the reviewer found something" from "we killed it".
 */
function errorHandoffReason(handoff) {
  const seconds = Math.round((handoff.elapsedMs ?? 0) / 1000);
  const cause = handoff.signal
    ? `was killed by ${handoff.signal} after ${seconds}s`
    : `exited ${handoff.exitStatus ?? "without a status"} after ${seconds}s`;
  const budget = handoff.parentDeadlineFired ? " (wall-clock budget exceeded)" : "";
  return `Local Bugbot ${cause}${budget}. No verdict was produced, so this is a failed required check, not a clear. Rerun the gate once the cause is addressed.`;
}

function cachedResult(file, fingerprint, nowMs = Date.now()) {
  const previous = readJson(file);
  if (previous?.fingerprint !== fingerprint) return null;
  if (previous.status === "blocked") {
    return {
      status: "blocked",
      cached: true,
      fingerprint,
      reason:
        "Bugbot previously found Medium-or-higher findings for this exact changeset; change the diff or run the manual review command to refresh evidence.",
    };
  }
  // A short-lived terminal error handoff: concurrent waiters get the real failure instead
  // of piling on a duplicate expensive review. Deliberately EXPIRING — unlike a blocked
  // verdict it is not evidence about the diff, so it must never become a permanent block.
  if (
    previous.status === "error" &&
    Number.isFinite(previous.expiresAt) &&
    nowMs < previous.expiresAt
  ) {
    return {
      status: "error",
      cached: true,
      fingerprint,
      reason: errorHandoffReason(previous),
    };
  }
  return null;
}

function waitForLockOrResult(file, fingerprint, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let nextHeartbeat = Date.now() + 30_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    const cached = cachedResult(file, fingerprint);
    if (cached) return { cached };
    const lock = acquireLock(file, timeoutMs + REVIEW_PROCESS_GRACE_MS);
    if (lock) return { lock };
    if (Date.now() >= nextHeartbeat) {
      process.stderr.write("[local-bugbot] waiting for the in-flight review in this worktree\n");
      nextHeartbeat += 30_000;
    }
    Atomics.wait(sleeper, 0, 0, LOCK_POLL_MS);
  }
  return { error: "timed out waiting for the concurrent local Bugbot review" };
}

/** The exact argv the gate hands its child reviewer. Exported so tests assert behavior. */
export function reviewChildArgs({ repo, baseSha, branch, model }) {
  return [
    path.join(repo, "scripts", "aios.mjs"),
    "review-bugbot",
    branch,
    "--base",
    baseSha,
    "--worktree",
    repo,
    "--include-worktree",
    "--fail-on",
    REQUIRED_BUGBOT_FAIL_ON,
    "--model",
    model,
    "--cursor-timeout",
    String(REVIEW_CHILD_TIMEOUT_SECONDS),
    "--read-only",
    "--hook-protocol",
    "--exclude-generated",
  ];
}

function defaultReview({ repo, baseSha, branch, env, model, timeoutMs }) {
  process.stderr.write("[local-bugbot] code + security review started (both required)\n");
  const heartbeat = spawn(
    process.execPath,
    [
      "-e",
      "const p=Number(process.argv[1]),s=Date.now();setInterval(()=>{try{process.kill(p,0)}catch{process.exit(0)}process.stderr.write(`[local-bugbot] still reviewing (${Math.max(1,Math.round((Date.now()-s)/60000))}m elapsed)\\n`)},30000)",
      String(process.pid),
    ],
    { stdio: ["ignore", "ignore", "inherit"] }
  );
  heartbeat.unref();
  const childEnv = { ...hardenedChildEnv(env), NO_COLOR: "1" };
  const startedAt = Date.now();
  let child;
  try {
    child = spawnSync(process.execPath, reviewChildArgs({ repo, baseSha, branch, model }), {
      cwd: repo,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: childEnv,
    });
  } finally {
    heartbeat.kill();
  }
  const output = [child.stdout, child.stderr, child.error?.message].filter(Boolean).join("\n");
  return {
    ok: child.status === 0,
    output,
    status: child.status,
    signal: child.signal,
    elapsedMs: Date.now() - startedAt,
    parentDeadlineFired: child.error?.code === "ETIMEDOUT",
  };
}

function blockedReason(result) {
  const output = capOutput(result.output || result.reason);
  const heading =
    result.status === "error"
      ? "Local Bugbot could not complete. Treat this as a failed required check."
      : "Local Bugbot found Medium-or-higher findings. Completion and merge are blocked.";
  return [
    heading,
    "Fix the findings, then let the Stop/idle hook rerun against the changed diff.",
    output && `\nBugbot evidence:\n${output}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function evaluateLocalBugbotGate({
  repo,
  env = process.env,
  runReview = defaultReview,
  resolveBase = resolveRequiredBugbotBase,
  resolveBranchHead = resolveCanonicalBranchHead,
  probeOnly = false,
} = {}) {
  // Explicit operator opt-out, for teams that have adopted the paid cloud Cursor Bugbot as the
  // enforcing gate instead. Strict on the literal "1" so a stray truthy value can't silently
  // disable a security gate, and always announced on stderr so a skipped review is never silent.
  // `skipped` is non-blocking (formatHookResult maps it to a pass) — a distinct status would block.
  if (String(env.AIOS_BUGBOT_DISABLE ?? "").trim() === "1" && !probeOnly) {
    process.stderr.write(
      "[local-bugbot] disabled via AIOS_BUGBOT_DISABLE=1 — relying on cloud Bugbot for this change\n"
    );
    return {
      status: "skipped",
      reason: "local Bugbot disabled via AIOS_BUGBOT_DISABLE=1",
    };
  }
  const root = git(["rev-parse", "--show-toplevel"], repo ?? process.cwd());
  const cli = path.join(root, "scripts", "aios.mjs");
  if (!existsSync(cli)) {
    return {
      status: "error",
      reason: "required local Bugbot dependency is missing: scripts/aios.mjs",
    };
  }
  const file = statePath(root);

  const resolvedBase = resolveBase(root);
  if (!resolvedBase.ok) {
    return {
      status: "error",
      reason: resolvedBase.reason,
    };
  }
  const { baseSha } = resolvedBase;

  const branch = gitMaybe(["symbolic-ref", "--quiet", "--short", "HEAD"], root) || "HEAD";
  const snapshot = captureBranchDiff(root, baseSha, {
    includeWorktree: true,
    excludeFromPrompt: true,
  });
  if (snapshot.suppressedTrackedFiles.length) {
    return {
      status: "error",
      reason: `refusing full-worktree review while tracked paths use skip-worktree/assume-unchanged: ${snapshot.suppressedTrackedFiles.join(", ")}`,
      fingerprint: snapshot.fingerprint,
    };
  }
  if (snapshot.withheldUntrackedFiles.length) {
    return {
      status: "error",
      reason: `refusing to send untracked content to Bugbot; stage the files you intend to have reviewed, or gitignore them if they are machine-local (build output, runtime/session state): ${snapshot.withheldUntrackedFiles.join(", ")}`,
      fingerprint: snapshot.fingerprint,
    };
  }
  // Ownership handoff, per listGateTargets' own doctrine: once a branch is pushed, the
  // PR-level gates (CI, cloud Bugbot, CodeRabbit) own it, and the local pre-PR gate owns
  // exactly what has not reached them yet. Verified ONLY against the canonical remote —
  // the same trust boundary as resolveRequiredBugbotBase — never a local ref, so the
  // AIO-555 offline forgeries (`git update-ref refs/remotes/...`) cannot take this path;
  // the only way onto it is an actual push, which by definition delivers the changeset to
  // the stronger gates. Without this, a pushed in-flight branch with cached findings
  // blocks every OTHER session's Stop hook repo-wide on work those sessions must not
  // touch. `status --porcelain` is trustworthy here because skip-worktree/assume-unchanged
  // suppression already failed closed above, and untracked files make it non-empty.
  if (branch !== "HEAD" && git(["status", "--porcelain"], root) === "") {
    const canonicalHead = resolveBranchHead(branch);
    if (canonicalHead && canonicalHead === gitMaybe(["rev-parse", "HEAD"], root)) {
      return {
        status: "skipped",
        reason: `branch ${branch} head is on the canonical remote with a clean worktree; PR-level gates own this changeset`,
        fingerprint: snapshot.fingerprint,
      };
    }
  }
  if (snapshot.reviewTooLarge) {
    return {
      status: "error",
      reason: `changeset exceeds the ${LOCAL_BUGBOT_DIFF_CAP}-character local Bugbot limit; split the changeset so code and security reviewers can inspect it atomically`,
      fingerprint: snapshot.fingerprint,
    };
  }
  if (!snapshot.diffStat && !snapshot.logOneline) {
    return {
      status: "skipped",
      reason: "no changes against Bugbot base",
      fingerprint: snapshot.fingerprint,
    };
  }

  const model = REQUIRED_BUGBOT_MODEL;
  const fingerprint = createHash("sha256")
    .update(`${GATE_POLICY_VERSION}\0${REQUIRED_BUGBOT_FAIL_ON}\0${model}\0${snapshot.fingerprint}`)
    .digest("hex");
  if (probeOnly) return { status: "probe", fingerprint };
  // The child owns an absolute REVIEW_WALL_CLOCK_BUDGET_MS deadline and fails closed on its
  // own; this kill is only the backstop for a child that stops responding entirely.
  const reviewTimeoutMs = REVIEW_WALL_CLOCK_BUDGET_MS + REVIEW_PROCESS_GRACE_MS;

  const existing = cachedResult(file, fingerprint);
  if (existing) return existing;

  const acquired = waitForLockOrResult(file, fingerprint, reviewTimeoutMs + NATIVE_HOOK_GRACE_MS);
  if (acquired.cached) return acquired.cached;
  if (!acquired.lock) {
    return {
      status: "error",
      reason: acquired.error,
    };
  }
  const lock = acquired.lock;
  const raced = cachedResult(file, fingerprint);
  if (raced) {
    releaseLock(lock);
    return raced;
  }
  try {
    const review = runReview({
      repo: root,
      baseSha,
      branch,
      env,
      model,
      timeoutMs: reviewTimeoutMs,
    });
    // A killed child produced no verdict at all. Record a SHORT-LIVED error handoff before
    // the lock is released so every waiter sees the real failure instead of spawning its own
    // duplicate review — and so it expires, because an infrastructure failure is not evidence
    // about the diff and must never harden into a permanent block or be mistaken for a clear.
    if (review.signal || review.parentDeadlineFired) {
      const handoff = {
        status: "error",
        fingerprint,
        expiresAt: Date.now() + ERROR_HANDOFF_TTL_MS,
        signal: review.signal ?? null,
        exitStatus: review.status ?? null,
        elapsedMs: review.elapsedMs ?? 0,
        parentDeadlineFired: review.parentDeadlineFired === true,
        baseSha,
        branch,
        model,
        reviewedAt: new Date().toISOString(),
      };
      writeJson(file, handoff);
      return {
        status: "error",
        cached: false,
        fingerprint,
        reason: errorHandoffReason(handoff),
        output: capOutput(review.output),
      };
    }
    const currentSnapshot = captureBranchDiff(root, baseSha, {
      includeWorktree: true,
      excludeFromPrompt: true,
    });
    if (currentSnapshot.suppressedTrackedFiles.length) {
      return {
        status: "error",
        reason: `tracked paths gained skip-worktree/assume-unchanged while Bugbot was reviewing: ${currentSnapshot.suppressedTrackedFiles.join(", ")}`,
        fingerprint: currentSnapshot.fingerprint,
      };
    }
    const currentFingerprint = createHash("sha256")
      .update(
        `${GATE_POLICY_VERSION}\0${REQUIRED_BUGBOT_FAIL_ON}\0${model}\0${currentSnapshot.fingerprint}`
      )
      .digest("hex");
    if (currentFingerprint !== fingerprint) {
      return {
        status: "error",
        reason: "worktree changed while Bugbot was reviewing; run a fresh review before completing",
        fingerprint: currentFingerprint,
      };
    }
    const rawOutput = stripAnsi(review.output);
    const output = capOutput(review.output);
    const verifiedClear = rawOutput.split("\n").some((line) => line.trim() === BUGBOT_CLEAR_MARKER);
    if (review.ok && verifiedClear) {
      // A writable on-disk clear cache is a bypass: an agent can forge the public
      // fingerprint. Persist only blocked metadata and require a real review for clear.
      rmSync(file, { force: true });
      return { status: "clear", verified: true, cached: false, fingerprint, output };
    }
    if (review.ok) {
      return {
        status: "error",
        reason: "Bugbot exited successfully without the required verified-clear marker",
        output,
      };
    }

    const isFinding = output.split("\n").some((line) => line.trim() === BUGBOT_BLOCKED_MARKER);
    if (isFinding) {
      writeJson(file, {
        status: "blocked",
        fingerprint,
        baseSha,
        branch,
        model,
        reviewedAt: new Date().toISOString(),
        evidenceSha256: createHash("sha256").update(rawOutput).digest("hex"),
      });
      return { status: "blocked", cached: false, fingerprint, output };
    }
    return {
      status: "error",
      reason: output || `Bugbot exited ${review.status ?? "without a status"}`,
      output,
    };
  } finally {
    releaseLock(lock);
  }
}

/**
 * Enumerate every worktree this gate is responsible for, from git state alone.
 *
 * Target selection must not come from the agent (see `main`): an agent that could name the
 * directory to review could dodge review entirely by naming a clean one. But anchoring to the
 * session's start directory is equally wrong — CLAUDE.md §5 requires all work to happen in a
 * linked worktree, so the session directory is normally the PRIMARY checkout, which is the one
 * tree the pre-commit guard forbids committing to. Pinned there, the gate reviews a tree that by
 * construction holds no work, and never sees the change it is meant to gate.
 *
 * So: enumerate the repo's registered worktrees — git state, not agent input — and return every
 * one holding work that has not yet reached the remote (uncommitted changes, or commits absent
 * from its upstream). Once a branch is pushed, the PR-level gates (CI, cloud Bugbot, CodeRabbit)
 * own it; a local pre-PR gate owns exactly what has not reached them yet.
 *
 * This is strictly stronger than pinning: the agent cannot choose the target, and cannot hide work
 * by changing directory, because every in-play worktree is reviewed.
 */
export function listGateTargets(projectDir, gitFn = git) {
  const listing = gitFn(["worktree", "list", "--porcelain", "-z"], projectDir);
  // `-z` because `git worktree list --porcelain` does not quote paths, so a path containing a
  // newline would otherwise mis-parse into a skipped worktree — a silent false clear.
  const roots = listing
    .split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => field.slice("worktree ".length))
    .filter(Boolean);

  // Deliberately NO filtering beyond "the directory still exists". An earlier revision skipped
  // worktrees that looked clean or already pushed, deriving that from `git status`, `@{upstream}`
  // and the local `refs/remotes/origin/main` — all of which an agent can write offline, so
  // `git update-ref refs/remotes/origin/main HEAD` (or `git update-index --skip-worktree`) emptied
  // the target list and cleared the gate. Selection must never consult an agent-writable signal.
  //
  // Filtering is also unnecessary: evaluateLocalBugbotGate already resolves its base through
  // resolveRequiredBugbotBase (canonical remote, not the writable local ref), already errors on
  // skip-worktree/assume-unchanged paths, and already returns `skipped` on an empty diff BEFORE
  // spawning a review. A clean, fully-merged worktree therefore costs local git work and no
  // review, and every exclusion decision is made against a trusted base instead of a forgeable one.
  return roots.filter((root) => existsSync(root));
}

/**
 * Combine per-worktree verdicts fail-closed: any block blocks, then any error errors, and only an
 * all-clear sweep clears. Findings stay attributed to the worktree they came from — conflating
 * them is what made the pinned gate's output unactionable.
 */
export function aggregateGateResults(results) {
  if (!results.length) {
    // Not a positive clear: an empty target list means enumeration found nothing, which is
    // indistinguishable from enumeration having failed. Announce it so a neutered gate and a
    // genuinely empty repo do not produce byte-identical silence.
    process.stderr.write(
      "[local-bugbot] no reviewable worktree was found — nothing was reviewed\n"
    );
    return { status: "skipped", reason: "no reviewable worktree found", worktrees: [] };
  }
  const tag = (result) => (result.worktree ? `[${result.worktree}]\n` : "");
  // A CACHED blocked verdict carries its explanation in `reason`, not `output` (see cachedResult),
  // so reading only `output` renders a worktree tag and nothing else — which is what the operator
  // sees on every Stop after the first, the common case. Never emit a content-free entry: an empty
  // block reads as a broken gate rather than a real finding, and the tag alone also defeats
  // blockedReason's `output || reason` fallback by making `output` non-empty.
  const evidence = (result) =>
    `${tag(result)}${
      result.output ||
      result.reason ||
      "no evidence recorded for this worktree; run the manual review command there to refresh it"
    }`;

  const blocked = results.filter((result) => result.status === "blocked");
  if (blocked.length) {
    return {
      status: "blocked",
      cached: blocked.every((result) => result.cached === true),
      fingerprint: blocked[0].fingerprint,
      worktrees: blocked.map((result) => result.worktree),
      output: blocked.map(evidence).join("\n\n"),
    };
  }

  const errored = results.filter((result) => result.status === "error");
  if (errored.length) {
    return {
      status: "error",
      worktrees: errored.map((result) => result.worktree),
      reason: errored
        .map((result) => `${result.worktree ?? "?"}: ${result.reason ?? "unknown error"}`)
        .join("; "),
      output: errored.map(evidence).join("\n\n"),
    };
  }

  // A probe never reviews; it reports the fingerprints callers dedup on
  // (.opencode/plugins/aios-bugbot.mjs requires `fingerprint`, and silently re-reviews without it).
  // A skipped sibling (empty diff, or a pushed head the PR gates own) is neutral in a probe
  // sweep — without this, one clean worktree beside one probed worktree fell through to the
  // unrecognised-verdict error below.
  const probes = results.filter((result) => result.status === "probe");
  const skippedCount = results.filter((result) => result.status === "skipped").length;
  if (probes.length && probes.length + skippedCount === results.length) {
    return {
      status: "probe",
      fingerprint: createHash("sha256")
        .update(probes.map((result) => `${result.worktree}\0${result.fingerprint}`).join("\n"))
        .digest("hex"),
      fingerprints: probes.map((result) => ({
        worktree: result.worktree,
        fingerprint: result.fingerprint,
      })),
    };
  }

  if (results.every((result) => result.status === "skipped")) {
    return { status: "skipped", reason: results[0].reason };
  }

  // Allowlist, not catch-all. Only an explicitly verified clear counts as clear; any status this
  // function does not recognise is an error, so a future status added to evaluateLocalBugbotGate
  // fails closed instead of silently passing the gate.
  const unrecognised = results.filter(
    (result) =>
      !(result.status === "clear" && result.verified === true) && result.status !== "skipped"
  );
  if (unrecognised.length) {
    return {
      status: "error",
      worktrees: unrecognised.map((result) => result.worktree),
      reason: `unrecognised or unverified Bugbot verdict, refusing to treat as clear: ${unrecognised
        .map((result) => `${result.worktree ?? "?"}=${result.status ?? "undefined"}`)
        .join(", ")}`,
    };
  }

  return {
    status: "clear",
    verified: true,
    cached: false,
    worktrees: results.map((result) => result.worktree),
  };
}

export function formatHookResult(runtime, result) {
  if (!VALID_RUNTIMES.has(runtime)) throw new Error(`unsupported hook runtime: ${runtime}`);
  if (["clear", "skipped"].includes(result.status)) return {};
  const reason = blockedReason(result);
  if (runtime === "cursor") return { followup_message: reason };
  if (runtime === "claude") return { decision: "block", reason };
  if (runtime === "codex") {
    return {
      continue: false,
      stopReason: "Required local Bugbot check did not pass.",
      systemMessage: reason,
    };
  }
  return { ...result, reason };
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  return {
    runtime: value("--runtime"),
    json: argv.includes("--json"),
    checkExit: argv.includes("--check-exit"),
    probe: argv.includes("--probe"),
  };
}

function readHookInput() {
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!VALID_RUNTIMES.has(args.runtime)) {
    process.stderr.write(
      "usage: local-bugbot-gate.mjs --runtime claude|codex|cursor|opencode [--json] [--check-exit]\n"
    );
    process.exitCode = 2;
    return;
  }
  readHookInput();
  let result;
  try {
    // Hook payloads are agent-controlled input, so the target is never taken from them — nor from
    // the process working directory, which the checked-in adapter pins to the session's start
    // directory (normally the primary checkout, where CLAUDE.md §5 forbids doing work). Targets
    // come from git's own worktree registry instead; see listGateTargets().
    const results = listGateTargets(process.cwd()).map((repo) => {
      try {
        return { ...evaluateLocalBugbotGate({ repo, probeOnly: args.probe }), worktree: repo };
      } catch (error) {
        // One unreviewable worktree must not mask a finding in another, so this degrades to a
        // per-target error and still lets every other target report.
        return {
          status: "error",
          worktree: repo,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    });
    result = aggregateGateResults(results);
  } catch (error) {
    result = { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  const output = args.probe || args.json ? result : formatHookResult(args.runtime, result);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (args.checkExit && ["blocked", "error"].includes(result.status)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
