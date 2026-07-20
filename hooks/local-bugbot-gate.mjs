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
} from "../scripts/review-bugbot.mjs";

const REVIEW_CHILD_TIMEOUT_SECONDS = 400;
const REVIEW_ATTEMPT_BUDGET_MULTIPLIER = 3; // first attempt + one doubled retry
const REVIEW_PROCESS_GRACE_MS = 20_000;
const NATIVE_HOOK_GRACE_MS = 60_000;
const LOCK_POLL_MS = 250;
const LOCK_INITIALIZATION_GRACE_MS = 5_000;
const OUTPUT_CAP = 9_000;
const GATE_POLICY_VERSION = "medium-read-only-code-security-secrets-v20";
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

function hardenedChildEnv(source) {
  const env = { ...source };
  for (const key of [
    "AIOS_BUGBOT_MODEL",
    "AIOS_BUGBOT_HOOK_NONCE",
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

function cachedResult(file, fingerprint) {
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

function defaultReview({ repo, baseSha, branch, env, model, timeoutMs }) {
  const cli = path.join(repo, "scripts", "aios.mjs");
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
  let child;
  try {
    child = spawnSync(
      process.execPath,
      [
        cli,
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
      ],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: childEnv,
      }
    );
  } finally {
    heartbeat.kill();
  }
  const output = [child.stdout, child.stderr, child.error?.message].filter(Boolean).join("\n");
  return { ok: child.status === 0, output, status: child.status, signal: child.signal };
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
  probeOnly = false,
} = {}) {
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
  const snapshot = captureBranchDiff(root, baseSha, { includeWorktree: true });
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
      reason: `refusing to send untracked content to Bugbot; stage intended files first: ${snapshot.withheldUntrackedFiles.join(", ")}`,
      fingerprint: snapshot.fingerprint,
    };
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
  const reviewTimeoutMs =
    REVIEW_ATTEMPT_BUDGET_MULTIPLIER * REVIEW_CHILD_TIMEOUT_SECONDS * 1000 +
    REVIEW_PROCESS_GRACE_MS;

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
    const currentSnapshot = captureBranchDiff(root, baseSha, { includeWorktree: true });
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
    result = evaluateLocalBugbotGate({
      // Hook payloads are agent-controlled input. Anchor the gate to the process
      // working directory selected by the checked-in native adapter.
      repo: process.cwd(),
      probeOnly: args.probe,
    });
  } catch (error) {
    result = { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
  const output = args.probe || args.json ? result : formatHookResult(args.runtime, result);
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (args.checkExit && ["blocked", "error"].includes(result.status)) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
