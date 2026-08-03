#!/usr/bin/env node

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateGateResults,
  evaluateLocalBugbotGate as evaluateProductionGate,
  formatAdvisoryHookResult,
  hardenedChildEnv,
  listGateTargets,
  reviewChildArgs,
  summarizeAdvisorySweep,
} from "../hooks/local-bugbot-gate.mjs";
import {
  BUGBOT_BLOCKED_MARKER,
  BUGBOT_CLEAR_MARKER,
  BUGBOT_CLEAR_TOKEN,
  buildBugbotPrompt,
  buildSecurityReviewPrompt,
  ATTEMPT_RESERVE_MARGIN_MS,
  captureBranchDiff,
  hasFindingsAtOrAbove,
  inspectLockDelta,
  REQUIRED_BUGBOT_MODEL,
  resolveRequiredBugbotBase,
  retryReviewTimeoutOnce,
  REVIEW_WALL_CLOCK_BUDGET_MS,
  runExcludedPathGates,
  runLocalSecretsPreflight,
  runLocalPrePrReview,
  runLocalBugbotReview,
  trustedReviewerEnv,
  UNTRACKED_HASH_SIZE_CAP,
} from "../scripts/review-bugbot.mjs";
import { resolveCanonicalBranchHead } from "../scripts/review-bugbot/trusted-env.mjs";
import { AIOSBugbot, hardenedGateEnv } from "../.opencode/plugins/aios-bugbot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const VERIFIED_CLEAR_OUTPUT = `${BUGBOT_CLEAR_MARKER}\n${BUGBOT_CLEAR_TOKEN}`;

function evaluateLocalBugbotGate(options = {}) {
  return evaluateProductionGate({
    ...options,
    // A developer's ambient shell (e.g. AIOS_BUGBOT_DISABLE=1 exported for local convenience
    // by aios/.envrc) must never leak into a test that didn't ask to exercise it — otherwise
    // this gate silently short-circuits to "skipped" outside CI. Tests that DO want to
    // exercise AIOS_BUGBOT_DISABLE pass their own explicit `env`, which wins over this default.
    env: options.env ?? { ...process.env, AIOS_BUGBOT_DISABLE: "" },
    resolveBase:
      options.resolveBase ??
      ((repo) => ({ ok: true, baseSha: git(repo, "merge-base", "HEAD", "origin/main") })),
    // Fixtures have no canonical remote; never let a test reach the network ls-remote.
    resolveBranchHead: options.resolveBranchHead ?? (() => null),
  });
}

function git(repo, ...args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function fixture() {
  const repo = mkdtempSync(path.join(tmpdir(), "aios-bugbot-gate-"));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "AIOS Test");
  git(repo, "config", "user.email", "test@aios.invalid");
  mkdirSync(path.join(repo, "scripts"));
  mkdirSync(path.join(repo, "validation"));
  writeFileSync(path.join(repo, "scripts", "aios.mjs"), "#!/usr/bin/env node\n");
  writeFileSync(
    path.join(repo, "validation", "check-secrets.sh"),
    readFileSync(path.join(REPO, "validation", "check-secrets.sh"))
  );
  writeFileSync(path.join(repo, "package.json"), '{"name":"aios-workspace","type":"module"}\n');
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "main");
  git(repo, "checkout", "-qb", "feat/gate");
  return repo;
}

test("the local evaluateLocalBugbotGate wrapper is immune to an ambient AIOS_BUGBOT_DISABLE=1", () => {
  // Regression guard for the wrapper's default env (see the comment on it above): without
  // that default, a maintainer's own shell — aios/.envrc exports AIOS_BUGBOT_DISABLE=1 for
  // local dev convenience — would leak into every test that omits `env` and silently turn
  // this whole file's coverage into a no-op (`status: "skipped"` instead of real review logic).
  const previous = process.env.AIOS_BUGBOT_DISABLE;
  process.env.AIOS_BUGBOT_DISABLE = "1";
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const result = evaluateLocalBugbotGate({
      repo,
      runReview: () => ({ ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT }),
    });
    assert.notEqual(
      result.status,
      "skipped",
      "an ambient AIOS_BUGBOT_DISABLE=1 in the host shell must not leak into a test that didn't ask for it"
    );
    assert.equal(result.status, "clear");
  } finally {
    if (previous === undefined) delete process.env.AIOS_BUGBOT_DISABLE;
    else process.env.AIOS_BUGBOT_DISABLE = previous;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Medium+ matcher is strict while Low remains advisory", async () => {
  assert.equal(hasFindingsAtOrAbove("- Medium: stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("1. [Medium] stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("Medium — stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("Medium - stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("**[Medium]** scripts/x.mjs:1 — stale", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("**High Severity**\n\nUnsafe retry loop.", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("| High | x | unsafe |", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("- Low: wording", "medium"), false);
  assert.equal(hasFindingsAtOrAbove("No Critical, High, or Medium findings.", "medium"), false);
  assert.equal(hasFindingsAtOrAbove("High-priority follow-up", "medium"), false);
  assert.equal(hasFindingsAtOrAbove("- Medium priority follow-up", "medium"), false);
  assert.equal(hasFindingsAtOrAbove("- High-priority follow-up", "medium"), false);

  const prompts = [];
  // A fixture repo with a deterministic commit pair: the ambient checkout's
  // HEAD~1 is not reviewable under CI's shallow merge-commit checkout.
  const repo = fixture();
  appendFileSync(path.join(repo, "tracked.txt"), "regression\n");
  git(repo, "add", "tracked.txt");
  git(repo, "commit", "-qm", "change");
  const blocked = await runLocalBugbotReview({
    worktree: repo,
    baseSha: "HEAD~1",
    branch: "feat/test",
    failOn: "medium",
    readOnly: true,
    reviewPrompt: async (input) => {
      prompts.push(input.prompt);
      return `- Medium: real regression\n\n${BUGBOT_CLEAR_TOKEN}`;
    },
    secretsPreflight: () => ({ ok: true }),
  });
  assert.equal(blocked.ok, false, "strict threshold must override a contradictory clear token");
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((prompt) => /cannot run commands/i.test(prompt)));
});

test("review timeouts retry once with a doubled per-call budget", async () => {
  const attempts = [];
  const result = await retryReviewTimeoutOnce(async (timeoutMs) => {
    attempts.push(timeoutMs);
    if (attempts.length === 1) throw new Error("cursor agent timed out after 400s");
    return BUGBOT_CLEAR_TOKEN;
  }, 400_000);
  assert.equal(result, BUGBOT_CLEAR_TOKEN);
  assert.deepEqual(attempts, [400_000, 800_000]);

  await assert.rejects(
    retryReviewTimeoutOnce(async () => {
      throw new Error("cursor agent exited 1");
    }, 400_000),
    /exited 1/
  );
});

test("hook child kill is the shared wall-clock budget plus a real grace", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    let hookTimeoutMs = 0;
    const result = evaluateLocalBugbotGate({
      repo,
      runReview: ({ timeoutMs }) => {
        hookTimeoutMs = timeoutMs;
        return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
      },
    });
    assert.equal(result.status, "clear");
    // The child's own absolute deadline is the budget; the parent kill must sit strictly
    // AFTER it so the child always gets to fail closed with a verdict of its own.
    assert.equal(hookTimeoutMs, REVIEW_WALL_CLOCK_BUDGET_MS + 60_000);
    assert.ok(hookTimeoutMs > REVIEW_WALL_CLOCK_BUDGET_MS);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("pre-PR review shares the Medium+ full-worktree policy", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(path.join(repo, "untracked.txt"), "included\n");
    git(repo, "add", "untracked.txt");
    let prompt = "";
    let passTimeout = 0;
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 120_000,
      reviewPrompt: async (input) => {
        prompt = input.prompt;
        passTimeout = input.timeoutMs;
        return `- Medium: regression\n\n${BUGBOT_CLEAR_TOKEN}`;
      },
    });
    assert.equal(review.ok, false);
    assert.equal(review.pass, "code");
    assert.equal(passTimeout, 120_000, "the configured timeout applies to each review call");
    assert.match(prompt, /included/);

    let calls = 0;
    const securityBlocked = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 120_000,
      reviewPrompt: async () => {
        calls++;
        return calls === 1 ? BUGBOT_CLEAR_TOKEN : "- Medium: unsafe default";
      },
    });
    assert.equal(securityBlocked.ok, false);
    assert.equal(securityBlocked.pass, "security");
    assert.equal(calls, 2, "the shared Bugbot runner must execute code and security passes");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("noncompliant reviewer prose fails closed without a verdict model", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const calls = [];
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 400_000,
      reviewPrompt: async (input) => {
        calls.push(input);
        if (input.label.includes("code review")) {
          return "Reviewed the changes. No Critical, High, or Medium findings to report.";
        }
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, false);
    assert.equal(review.error, true);
    // 3, not 2, since AIO-468: the code pass returns an unreadable verdict and is re-asked
    // ONCE (the security pass answers cleanly first time, so it is asked once). The
    // fail-closed outcome above is unchanged — a re-ask that stays unreadable still blocks.
    assert.equal(calls.length, 3);
    assert.match(review.output, /review protocol error/);
    // The retry must reuse the SAME review pass, never introduce a separate
    // verdict-normalization model call to launder noncompliant prose into a verdict.
    assert.ok(calls.every((call) => !call.label.includes("verdict normalization")));

    const blocked = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      reviewPrompt: async (input) =>
        input.label.includes("code review")
          ? "There is a serious unlabelled authorization bypass."
          : BUGBOT_CLEAR_TOKEN,
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.finding, false);
    assert.equal(blocked.error, true);
    assert.equal(blocked.pass, "code");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("terminal clear ignores progress prose but cannot override a streamed finding", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const baseSha = git(repo, "rev-parse", "main");
    const progressOnly = await runLocalPrePrReview({
      worktree: repo,
      baseSha,
      branch: "feat/gate",
      reviewPrompt: async () => ({
        transcript: "Launching validators for evidence.",
        result: BUGBOT_CLEAR_TOKEN,
      }),
    });
    assert.equal(progressOnly.ok, true);

    const resultOnlyClear = await runLocalPrePrReview({
      worktree: repo,
      baseSha,
      branch: "feat/gate",
      reviewPrompt: async () => ({
        transcript: "Launching validators for evidence.",
        result: "Still checking validators.",
        eventResult: BUGBOT_CLEAR_TOKEN,
      }),
    });
    assert.equal(resultOnlyClear.ok, true);

    const contradictory = await runLocalPrePrReview({
      worktree: repo,
      baseSha,
      branch: "feat/gate",
      reviewPrompt: async ({ label }) =>
        label.includes("code review")
          ? {
              transcript: "- Medium: streamed correctness regression",
              result: BUGBOT_CLEAR_TOKEN,
            }
          : { transcript: "", result: BUGBOT_CLEAR_TOKEN },
    });
    assert.equal(contradictory.ok, false);
    assert.equal(contradictory.finding, true);
    assert.match(contradictory.output, /streamed correctness regression/);

    const legacyContradiction = await runLocalPrePrReview({
      worktree: repo,
      baseSha,
      branch: "feat/gate",
      reviewPrompt: async ({ label }) =>
        label.includes("code review")
          ? {
              transcript:
                "**High Severity**\n\nThis retry loop has no upper bound and can hang the process.",
              result: BUGBOT_CLEAR_TOKEN,
            }
          : { transcript: "", result: BUGBOT_CLEAR_TOKEN },
    });
    assert.equal(legacyContradiction.ok, false);
    assert.equal(legacyContradiction.finding, true);
    assert.match(legacyContradiction.output, /High Severity/);

    const streamedBlockedToken = await runLocalPrePrReview({
      worktree: repo,
      baseSha,
      branch: "feat/gate",
      reviewPrompt: async ({ label }) =>
        label.includes("code review")
          ? {
              transcript: "BUGBOT_BLOCKED",
              result: BUGBOT_CLEAR_TOKEN,
            }
          : { transcript: "", result: BUGBOT_CLEAR_TOKEN },
    });
    assert.equal(streamedBlockedToken.ok, false);
    assert.equal(streamedBlockedToken.finding, true);
    assert.match(streamedBlockedToken.output, /BUGBOT_BLOCKED/);

    const unstructuredContradiction = await runLocalPrePrReview({
      worktree: repo,
      baseSha,
      branch: "feat/gate",
      reviewPrompt: async ({ label }) =>
        label.includes("code review")
          ? {
              transcript: "Critical auth bypass in the callback route",
              result: BUGBOT_CLEAR_TOKEN,
            }
          : { transcript: "", result: BUGBOT_CLEAR_TOKEN },
    });
    assert.equal(unstructuredContradiction.ok, false);
    assert.equal(unstructuredContradiction.finding, true);
    assert.match(unstructuredContradiction.output, /Critical auth bypass/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a concrete finding takes precedence over a sibling infrastructure error", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      reviewPrompt: async ({ label }) => {
        if (label.includes("code review")) return "- Medium: concrete regression";
        return "Unstructured security review output.";
      },
    });
    assert.equal(review.ok, false);
    assert.equal(review.finding, true);
    assert.equal(review.error, false);
    assert.match(review.output, /Medium: concrete regression/);
    assert.match(review.output, /Unstructured security review output/);
    assert.match(review.output, /review protocol error/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("worktree capture withholds untracked files and rejects oversized atomic reviews", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    writeFileSync(path.join(repo, "new-file.txt"), "new\n");
    const base = git(repo, "rev-parse", "main");
    const first = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.match(first.diff, /changed/);
    assert.match(first.diff, /Untracked file: new-file\.txt/);
    assert.match(first.diffStat, /1 untracked file/);
    assert.deepEqual(first.withheldUntrackedFiles, ["new-file.txt"]);
    assert.doesNotMatch(first.reviewDiff, /new\n/);

    appendFileSync(path.join(repo, "new-file.txt"), "again\n");
    const second = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.notEqual(second.fingerprint, first.fingerprint);

    writeFileSync(
      path.join(repo, "large.txt"),
      `${"x".repeat(250_000)}\ndiff --git fake-content\n${"x".repeat(260_000)}\ntail-marker\n`
    );
    git(repo, "add", "new-file.txt", "large.txt");
    const large = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.equal(large.reviewTooLarge, true);
    assert.ok(large.reviewDiff.length > 500_000);
    assert.match(large.reviewDiff, /tail-marker/);

    const timeouts = [];
    const review = await runLocalBugbotReview({
      worktree: repo,
      baseSha: base,
      branch: "feat/gate",
      cursorTimeout: 120_000,
      includeWorktree: true,
      readOnly: true,
      failOn: "medium",
      reviewPrompt: async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, false);
    assert.equal(review.error, true);
    assert.match(review.output, /split the changeset/);
    assert.equal(timeouts.length, 0, "oversized diffs must not reach an isolated reviewer");

    let gateCalls = 0;
    const gated = evaluateLocalBugbotGate({
      repo,
      runReview: () => {
        gateCalls++;
        return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
      },
    });
    assert.equal(gated.status, "error");
    assert.match(gated.reason, /split the changeset/);
    assert.equal(gateCalls, 0, "the lifecycle gate must reject before launching Bugbot");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("all untracked content is withheld and blocked before external review", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const secret = `ghp_${"x".repeat(36)}`;
    writeFileSync(path.join(repo, ".env.local"), `TOKEN=${secret}\n`);
    symlinkSync("missing-target", path.join(repo, "broken-link"));
    const base = git(repo, "rev-parse", "main");
    const captured = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.deepEqual(captured.withheldUntrackedFiles, [".env.local", "broken-link"]);
    assert.doesNotMatch(captured.reviewDiff, new RegExp(secret));

    let calls = 0;
    const review = await runLocalBugbotReview({
      worktree: repo,
      baseSha: base,
      branch: "feat/gate",
      includeWorktree: true,
      reviewPrompt: async () => {
        calls++;
        return BUGBOT_CLEAR_TOKEN;
      },
      secretsPreflight: () => ({ ok: true }),
    });
    assert.equal(review.ok, false);
    assert.equal(review.error, true);
    assert.equal(calls, 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- untracked-file size cap: a large untracked artifact must not stall the gate --------
// statSync happens before readFileSync; above the cap the fingerprint records the apparent
// size instead of hashed content, so hashing a multi-megabyte stray artifact can't block the
// gate on every run while still invalidating the fingerprint when the file's size changes.

test("an oversized untracked file is fingerprinted by size, not read", async () => {
  const repo = fixture();
  try {
    const big = path.join(repo, "big-artifact.bin");
    // Sparse file: truncateSync only sets the apparent length, so this never writes
    // UNTRACKED_HASH_SIZE_CAP bytes of real data to disk.
    writeFileSync(big, "");
    truncateSync(big, UNTRACKED_HASH_SIZE_CAP + 1);
    const base = git(repo, "rev-parse", "main");

    const captured = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.deepEqual(captured.withheldUntrackedFiles, ["big-artifact.bin"]);
    assert.match(captured.diff, /too large to hash/);
    assert.doesNotMatch(captured.diff, /sha256/);

    // Growing the file changes the recorded size, so the fingerprint still invalidates.
    truncateSync(big, UNTRACKED_HASH_SIZE_CAP + 2);
    const grown = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.notEqual(grown.fingerprint, captured.fingerprint);

    // Shrinking back to the same size reproduces the same fingerprint — proof the size
    // marker, not file content, drives it (content was never read either time).
    truncateSync(big, UNTRACKED_HASH_SIZE_CAP + 1);
    const back = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.equal(back.fingerprint, captured.fingerprint);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a small untracked file is still content-hashed", async () => {
  const repo = fixture();
  try {
    writeFileSync(path.join(repo, "small.txt"), "hello\n");
    const base = git(repo, "rev-parse", "main");
    const captured = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.deepEqual(captured.withheldUntrackedFiles, ["small.txt"]);
    assert.match(captured.diff, /sha256 [a-f0-9]{64}/);
    assert.doesNotMatch(captured.diff, /too large to hash/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("skip-worktree and assume-unchanged paths block before external review", async () => {
  const repo = fixture();
  try {
    const base = git(repo, "rev-parse", "main");
    git(repo, "update-index", "--skip-worktree", "tracked.txt");
    appendFileSync(path.join(repo, "tracked.txt"), "hidden skip-worktree edit\n");
    assert.deepEqual(
      captureBranchDiff(repo, base, { includeWorktree: true }).suppressedTrackedFiles,
      ["tracked.txt"]
    );

    git(repo, "update-index", "--no-skip-worktree", "tracked.txt");
    git(repo, "update-index", "--assume-unchanged", "tracked.txt");
    const captured = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.deepEqual(captured.suppressedTrackedFiles, ["tracked.txt"]);
    let calls = 0;
    const review = await runLocalBugbotReview({
      worktree: repo,
      baseSha: base,
      branch: "feat/gate",
      includeWorktree: true,
      reviewPrompt: async () => {
        calls++;
        return BUGBOT_CLEAR_TOKEN;
      },
      secretsPreflight: () => ({ ok: true }),
    });
    assert.equal(review.ok, false);
    assert.equal(review.error, true);
    assert.equal(calls, 0);
    assert.match(review.output, /skip-worktree\/assume-unchanged/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("local secrets preflight blocks staged secrets before external review", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const secret = `ghp_${"z".repeat(36)}`;
    writeFileSync(path.join(repo, "staged-secret.txt"), `TOKEN=${secret}\n`);
    git(repo, "add", "staged-secret.txt");
    let calls = 0;
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      reviewPrompt: async () => {
        calls++;
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, false);
    assert.equal(review.error, true);
    assert.equal(calls, 0, "no external reviewer may run before the scanner clears");
    assert.match(review.output, /local secrets preflight failed/i);
    assert.doesNotMatch(review.output, new RegExp(secret));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("secrets preflight pins bash and its command PATH", () => {
  const repo = fixture();
  try {
    const secret = `ghp_${"q".repeat(36)}`;
    writeFileSync(path.join(repo, "staged-secret.txt"), `TOKEN=${secret}\n`);
    git(repo, "add", "staged-secret.txt");
    const hostileEnv = path.join(repo, "hostile-env.sh");
    writeFileSync(hostileEnv, "exit 0\n");
    const result = runLocalSecretsPreflight(repo, {
      ...process.env,
      PATH: repo,
      BASH_ENV: hostileEnv,
    });
    assert.equal(result.ok, false, "hostile PATH/BASH_ENV must not bypass secret detection");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("canonical base resolution ignores a rewritten local origin/main", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "committed feature change\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "feature change");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const resolved = resolveRequiredBugbotBase(repo, { canonicalUrl: repo });
    assert.equal(resolved.ok, true);
    assert.notEqual(resolved.baseSha, git(repo, "rev-parse", "origin/main"));
    assert.equal(resolved.baseSha, git(repo, "rev-parse", "main"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("canonical base resolution ignores Git replacement objects", () => {
  const repo = fixture();
  try {
    const main = git(repo, "rev-parse", "main");
    appendFileSync(path.join(repo, "tracked.txt"), "feature change\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "feature change");
    const head = git(repo, "rev-parse", "HEAD");
    const tree = git(repo, "rev-parse", "HEAD^{tree}");
    const replacement = git(repo, "commit-tree", tree, "-p", head, "-m", "replacement");
    git(repo, "replace", main, replacement);

    const resolved = resolveRequiredBugbotBase(repo, { canonicalUrl: repo });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.baseSha, main);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("canonical base resolution ignores parent Git helper and config injection", () => {
  const repo = fixture();
  const remotes = mkdtempSync(path.join(tmpdir(), "aios-bugbot-remotes-"));
  const canonical = path.join(remotes, "canonical.git");
  const redirected = path.join(remotes, "redirected.git");
  const previousParameters = process.env.GIT_CONFIG_PARAMETERS;
  const previousExecPath = process.env.GIT_EXEC_PATH;
  try {
    execFileSync("git", ["clone", "-q", "--bare", repo, canonical]);
    const canonicalSha = git(repo, "rev-parse", "main");

    appendFileSync(path.join(repo, "tracked.txt"), "redirected\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "redirected main");
    git(repo, "branch", "-f", "main", "HEAD");
    execFileSync("git", ["clone", "-q", "--bare", repo, redirected]);

    process.env.GIT_CONFIG_PARAMETERS = `'url.file://${redirected}.insteadOf=file://${canonical}'`;
    process.env.GIT_EXEC_PATH = path.join(remotes, "missing-git-exec-path");
    const resolved = resolveRequiredBugbotBase(repo, {
      canonicalUrl: `file://${canonical}`,
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.remoteSha, canonicalSha);
  } finally {
    if (previousParameters === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
    else process.env.GIT_CONFIG_PARAMETERS = previousParameters;
    if (previousExecPath === undefined) delete process.env.GIT_EXEC_PATH;
    else process.env.GIT_EXEC_PATH = previousExecPath;
    rmSync(repo, { recursive: true, force: true });
    rmSync(remotes, { recursive: true, force: true });
  }
});

test("gate never trusts a disk clear cache but caches exact blocked verdict metadata", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change-one\n");
    let calls = 0;
    const models = [];
    const bases = [];
    const clearReview = ({ model, baseSha }) => {
      calls++;
      models.push(model);
      bases.push(baseSha);
      return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
    };
    const env = { AIOS_BUGBOT_BASE: "HEAD" };
    const first = evaluateLocalBugbotGate({ repo, env, runReview: clearReview });
    assert.equal(first.status, "clear");
    assert.equal(first.verified, true);
    assert.equal(evaluateLocalBugbotGate({ repo, env, runReview: clearReview }).cached, false);
    assert.equal(calls, 2, "clear verdicts must be re-reviewed, never trusted from disk");
    assert.equal(models[0], "cursor:composer-2.5");
    assert.ok(bases.every((base) => base === git(repo, "rev-parse", "main")));

    const state = path.resolve(
      repo,
      git(repo, "rev-parse", "--git-path", "aios/local-bugbot-gate.json")
    );
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(
      state,
      `${JSON.stringify({ status: "clear", fingerprint: first.fingerprint })}\n`
    );
    assert.equal(evaluateLocalBugbotGate({ repo, env, runReview: clearReview }).status, "clear");
    assert.equal(calls, 3, "a forged exact-fingerprint clear record must not bypass review");

    const alternateModel = { ...env, AIOS_BUGBOT_MODEL: "cursor:alternate" };
    assert.equal(
      evaluateLocalBugbotGate({ repo, env: alternateModel, runReview: clearReview }).status,
      "clear"
    );
    assert.equal(calls, 4);
    assert.equal(models[3], REQUIRED_BUGBOT_MODEL, "agent env cannot replace the gate reviewer");

    appendFileSync(path.join(repo, "tracked.txt"), "change-two\n");
    assert.equal(evaluateLocalBugbotGate({ repo, env, runReview: clearReview }).status, "clear");
    assert.equal(calls, 5);

    appendFileSync(path.join(repo, "tracked.txt"), "change-three\n");
    const blockedReview = () => {
      calls++;
      return {
        ok: false,
        status: 1,
        output: `${BUGBOT_BLOCKED_MARKER}\nBugbot found Medium+ issues\n- Medium: bug`,
      };
    };
    assert.equal(
      evaluateLocalBugbotGate({ repo, env, runReview: blockedReview }).status,
      "blocked"
    );
    const persisted = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(persisted.status, "blocked");
    assert.equal("output" in persisted, false, "review prose must never be persisted");
    assert.match(persisted.evidenceSha256, /^[a-f0-9]{64}$/);
    const cachedBlocked = evaluateLocalBugbotGate({ repo, env, runReview: blockedReview });
    assert.equal(cachedBlocked.cached, true);
    assert.equal("output" in cachedBlocked, false);
    assert.match(cachedBlocked.reason, /previously found Medium-or-higher findings/);
    assert.equal(calls, 6, "unchanged blocked diff must not spend another model call");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a pushed clean worktree is owned by the PR gates and skips local review", () => {
  const repo = fixture();
  try {
    writeFileSync(path.join(repo, "tracked.txt"), "pushed change\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "pushed change");
    const head = git(repo, "rev-parse", "HEAD");
    let calls = 0;
    const review = () => {
      calls++;
      return { ok: false, status: 1, output: "reviewer ran" };
    };

    const unpushed = evaluateLocalBugbotGate({ repo, env: {}, runReview: review });
    assert.notEqual(unpushed.status, "skipped", "an unpushed head must still be reviewed");
    assert.equal(calls, 1);

    evaluateLocalBugbotGate({
      repo,
      env: {},
      runReview: review,
      resolveBranchHead: () => "f".repeat(40),
    });
    assert.equal(calls, 2, "a canonical head behind local HEAD must still be reviewed");

    const skipped = evaluateLocalBugbotGate({
      repo,
      env: {},
      runReview: review,
      resolveBranchHead: () => head,
    });
    assert.equal(skipped.status, "skipped");
    assert.match(skipped.reason, /canonical remote/);
    assert.equal(calls, 2, "a pushed clean worktree must not spend a model call");

    appendFileSync(path.join(repo, "tracked.txt"), "uncommitted\n");
    const dirty = evaluateLocalBugbotGate({
      repo,
      env: {},
      runReview: review,
      resolveBranchHead: () => head,
    });
    assert.notEqual(dirty.status, "skipped", "worktree edits beyond the pushed head are reviewed");
    assert.equal(calls, 3);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a stale blocked cache stops blocking once the branch head reaches the canonical remote", () => {
  const repo = fixture();
  try {
    writeFileSync(path.join(repo, "tracked.txt"), "in-flight change\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "in-flight change");
    const head = git(repo, "rev-parse", "HEAD");
    let calls = 0;
    const blockedReview = () => {
      calls++;
      return {
        ok: false,
        status: 1,
        output: `${BUGBOT_BLOCKED_MARKER}\nBugbot found Medium+ issues\n- Medium: bug`,
      };
    };
    assert.equal(
      evaluateLocalBugbotGate({ repo, env: {}, runReview: blockedReview }).status,
      "blocked"
    );
    assert.equal(evaluateLocalBugbotGate({ repo, env: {}, runReview: blockedReview }).cached, true);
    assert.equal(calls, 1);

    const afterPush = evaluateLocalBugbotGate({
      repo,
      env: {},
      runReview: blockedReview,
      resolveBranchHead: () => head,
    });
    assert.equal(
      afterPush.status,
      "skipped",
      "PR gates own a pushed changeset, cached verdict or not"
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("canonical branch head resolution reads only the canonical remote", () => {
  const repo = fixture();
  const bare = mkdtempSync(path.join(tmpdir(), "aios-canonical-"));
  try {
    writeFileSync(path.join(repo, "tracked.txt"), "pushed change\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "pushed change");
    git(bare, "init", "-q", "--bare");
    git(repo, "push", "-q", bare, "feat/gate");
    const head = git(repo, "rev-parse", "HEAD");
    assert.equal(resolveCanonicalBranchHead("feat/gate", { canonicalUrl: bare }), head);
    assert.equal(resolveCanonicalBranchHead("missing", { canonicalUrl: bare }), null);
    assert.equal(resolveCanonicalBranchHead("HEAD", { canonicalUrl: bare }), null);
    assert.equal(resolveCanonicalBranchHead("", { canonicalUrl: bare }), null);
    assert.equal(
      resolveCanonicalBranchHead("feat/gate", { canonicalUrl: path.join(bare, "missing") }),
      null,
      "an unreachable canonical remote must read as not-pushed, never as pushed"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
  }
});

test("a skipped sibling stays neutral in a probe sweep", () => {
  const combined = aggregateGateResults([
    { status: "probe", fingerprint: "aa11", worktree: "/wt/active" },
    {
      status: "skipped",
      reason: "branch feat/x head is on the canonical remote",
      worktree: "/wt/pushed",
    },
  ]);
  assert.equal(combined.status, "probe");
  assert.equal(combined.fingerprints.length, 1);
  assert.equal(combined.fingerprints[0].worktree, "/wt/active");
});

test("gate waits through transient lock contention instead of returning a spurious error", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    const state = path.resolve(
      repo,
      git(repo, "rev-parse", "--git-path", "aios/local-bugbot-gate.json")
    );
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(`${state}.lock`, "held\n");
    const remover = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{force:true}),100)",
        `${state}.lock`,
      ],
      { stdio: "ignore" }
    );
    const result = evaluateLocalBugbotGate({
      repo,
      runReview: () => ({ ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT }),
    });
    assert.equal(result.status, "clear");
    assert.equal(remover.exitCode === 0 || remover.exitCode === null, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gate immediately reclaims a lock whose owner process died", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    const state = path.resolve(
      repo,
      git(repo, "rev-parse", "--git-path", "aios/local-bugbot-gate.json")
    );
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(
      `${state}.lock`,
      JSON.stringify({
        pid: 2_147_483_647,
        startedAt: new Date().toISOString(),
      })
    );
    const startedAt = Date.now();
    const result = evaluateLocalBugbotGate({
      repo,
      runReview: () => ({ ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT }),
    });
    assert.equal(result.status, "clear");
    assert.ok(Date.now() - startedAt < 1_000, "dead-owner recovery must not wait for stale age");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gate quickly reclaims a partially initialized ownerless lock", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    const state = path.resolve(
      repo,
      git(repo, "rev-parse", "--git-path", "aios/local-bugbot-gate.json")
    );
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(`${state}.lock`, "");
    const abandonedAt = new Date(Date.now() - 10_000);
    utimesSync(`${state}.lock`, abandonedAt, abandonedAt);
    const startedAt = Date.now();
    const result = evaluateLocalBugbotGate({
      repo,
      runReview: () => ({ ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT }),
    });
    assert.equal(result.status, "clear");
    assert.ok(Date.now() - startedAt < 1_000, "partial-lock recovery must use the short grace");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("fingerprint probe never runs a review and changes after an edit", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "one\n");
    const first = evaluateLocalBugbotGate({
      repo,
      probeOnly: true,
      runReview: () => assert.fail("probe must not run Bugbot"),
    });
    assert.equal(first.status, "probe");
    appendFileSync(path.join(repo, "tracked.txt"), "two\n");
    const second = evaluateLocalBugbotGate({
      repo,
      probeOnly: true,
      runReview: () => assert.fail("probe must not run Bugbot"),
    });
    assert.notEqual(second.fingerprint, first.fingerprint);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("agent-supplied recursion environment cannot bypass review", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    let calls = 0;
    const forged = evaluateLocalBugbotGate({
      repo,
      env: { AIOS_BUGBOT_HOOK_NONCE: "valid-nonce" },
      runReview: () => {
        calls++;
        return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
      },
    });
    assert.equal(forged.status, "clear");
    assert.equal(calls, 1, "hook environment input must never skip the required review");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("deleting the toolkit review CLI fails closed before review", () => {
  const repo = fixture();
  try {
    rmSync(path.join(repo, "scripts", "aios.mjs"));
    const result = evaluateLocalBugbotGate({
      repo,
      runReview: () => assert.fail("missing gate dependency must block before review"),
    });
    assert.equal(result.status, "error");
    assert.match(result.reason, /required local Bugbot dependency is missing/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a clean worktree cannot skip an unverifiable canonical base", () => {
  const repo = fixture();
  try {
    const result = evaluateLocalBugbotGate({
      repo,
      resolveBase: () => ({
        ok: false,
        reason: "canonical base unavailable",
      }),
      runReview: () => assert.fail("base verification must fail before review"),
    });
    assert.equal(result.status, "error");
    assert.match(result.reason, /canonical base unavailable/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("gate rejects malformed success and any worktree change during review", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "before-review\n");
    const malformed = evaluateLocalBugbotGate({
      repo,
      runReview: () => ({ ok: true, status: 0, output: BUGBOT_CLEAR_TOKEN }),
    });
    assert.equal(malformed.status, "error");
    assert.match(malformed.reason, /verified-clear marker/i);

    const changed = evaluateLocalBugbotGate({
      repo,
      runReview: () => {
        appendFileSync(path.join(repo, "tracked.txt"), "changed-during-review\n");
        return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
      },
    });
    assert.equal(changed.status, "error");
    assert.match(changed.reason, /worktree changed while Bugbot was reviewing/i);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

const BLOCKING_SHAPE_KEYS = ["decision", "continue", "stopReason", "followup_message"];

test("AIO-567: Stop adapters emit only advisory shapes — never a blocking shape", () => {
  const summary = summarizeAdvisorySweep([
    { status: "probe", fingerprint: "f1", worktree: "/wt/unreviewed" },
    { status: "probe", fingerprint: "f2", knownBlocked: true, worktree: "/wt/blocked" },
    { status: "error", reason: "canonical remote unreachable", worktree: "/wt/offline" },
    { status: "skipped", reason: "no changes against Bugbot base", worktree: "/wt/idle" },
  ]);
  assert.deepEqual(summary.unreviewed, ["/wt/unreviewed"]);
  assert.deepEqual(summary.knownBlocked, ["/wt/blocked"]);
  assert.deepEqual(summary.attention, ["/wt/offline: canonical remote unreachable"]);
  assert.match(summary.advisory, /Unreviewed changes in: \/wt\/unreviewed/);
  assert.match(summary.advisory, /aios build --merge \/ aios ship/);
  assert.match(summary.advisory, /Known Medium\+ Bugbot findings.*\/wt\/blocked/);
  assert.match(summary.advisory, /WILL block/);
  assert.match(summary.advisory, /non-blocking.*\/wt\/offline/);
  assert.match(summary.fingerprint, /^[a-f0-9]{64}$/);

  // Even a summary carrying a cached Medium+ verdict and a probe error must never produce a
  // blocking key for ANY runtime — blocking verdicts live at merge time only.
  for (const runtime of ["claude", "codex", "cursor", "opencode"]) {
    const shape = formatAdvisoryHookResult(runtime, summary);
    for (const key of BLOCKING_SHAPE_KEYS) {
      assert.equal(key in shape, false, `${runtime} advisory shape must not carry ${key}`);
    }
  }
  assert.match(formatAdvisoryHookResult("claude", summary).systemMessage, /local-bugbot advisory/);
  assert.match(formatAdvisoryHookResult("codex", summary).systemMessage, /local-bugbot advisory/);
  // Cursor's only in-band stop channel (followup_message) would re-engage the agent, so its
  // advisory goes to stderr and stdout stays empty.
  assert.deepEqual(formatAdvisoryHookResult("cursor", summary), {});
  const opencode = formatAdvisoryHookResult("opencode", summary);
  assert.equal(opencode.status, "advisory");
  assert.equal(opencode.fingerprint, summary.fingerprint);
  assert.match(opencode.advisory, /Unreviewed changes/);

  const quiet = summarizeAdvisorySweep([
    { status: "skipped", reason: "no changes against Bugbot base", worktree: "/wt" },
  ]);
  assert.equal(quiet.advisory, null);
  assert.deepEqual(formatAdvisoryHookResult("claude", quiet), {});
  assert.deepEqual(formatAdvisoryHookResult("codex", quiet), {});
  assert.deepEqual(formatAdvisoryHookResult("cursor", quiet), {});
  assert.equal(formatAdvisoryHookResult("opencode", quiet).advisory, null);
  assert.throws(() => formatAdvisoryHookResult("vscode", quiet), /unsupported hook runtime/);
});

test("AIO-567: a cached blocked verdict surfaces as a knownBlocked probe, never a review", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    let calls = 0;
    const blockedReview = () => {
      calls++;
      return {
        ok: false,
        status: 1,
        output: `${BUGBOT_BLOCKED_MARKER}\nBugbot found Medium+ issues\n- Medium: bug`,
      };
    };
    assert.equal(evaluateLocalBugbotGate({ repo, runReview: blockedReview }).status, "blocked");
    assert.equal(calls, 1);

    const probe = evaluateLocalBugbotGate({ repo, runReview: blockedReview, probeOnly: true });
    assert.equal(probe.status, "probe");
    assert.equal(probe.knownBlocked, true);
    assert.equal(calls, 1, "a probe must never spend a model call, even on a blocked cache");

    // The advisory built from that probe still carries no blocking key for any runtime.
    const summary = summarizeAdvisorySweep([{ ...probe, worktree: repo }]);
    for (const runtime of ["claude", "codex", "cursor", "opencode"]) {
      const shape = formatAdvisoryHookResult(runtime, summary);
      for (const key of BLOCKING_SHAPE_KEYS) assert.equal(key in shape, false);
    }
    assert.match(summary.advisory, /Known Medium\+ Bugbot findings/);

    // Changing the diff clears the knownBlocked flag on the next probe.
    appendFileSync(path.join(repo, "tracked.txt"), "another change\n");
    const fresh = evaluateLocalBugbotGate({ repo, runReview: blockedReview, probeOnly: true });
    assert.equal(fresh.status, "probe");
    assert.equal("knownBlocked" in fresh, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("native launchers strip code-injection environment before Node starts", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "aios bugbot launcher "));
  try {
    mkdirSync(path.join(repo, "hooks"));
    const nested = path.join(repo, "nested", "cwd");
    const hostileBin = path.join(repo, "hostile-bin");
    mkdirSync(nested, { recursive: true });
    mkdirSync(hostileBin);
    writeFileSync(path.join(repo, "hostile.sh"), "exit 99\n");
    writeFileSync(
      path.join(hostileBin, "node"),
      `#!/bin/sh\necho hijacked > ${JSON.stringify(path.join(repo, "node-hijacked"))}\n`
    );
    chmodSync(path.join(hostileBin, "node"), 0o755);
    writeFileSync(
      path.join(repo, "hooks", "local-bugbot-gate.mjs"),
      "console.log(JSON.stringify({node:process.env.NODE_OPTIONS,library:process.env.LD_LIBRARY_PATH,bash:process.env.BASH_ENV,git:process.env.GIT_DIR,gitParameters:process.env.GIT_CONFIG_PARAMETERS,gitExec:process.env.GIT_EXEC_PATH,proxy:process.env.HTTPS_PROXY,ca:process.env.SSL_CERT_FILE}))\n"
    );
    const output = execFileSync(
      "/bin/sh",
      [path.join(REPO, "hooks", "run-local-bugbot-gate.sh"), "codex", repo],
      {
        cwd: nested,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: hostileBin,
          NODE_OPTIONS: "--trace-warnings",
          LD_LIBRARY_PATH: path.join(repo, "hostile-libraries"),
          BASH_ENV: path.join(repo, "hostile.sh"),
          GIT_DIR: path.join(repo, "fake-git"),
          GIT_CONFIG_PARAMETERS: "'url.file:///tmp/evil.insteadOf=https://github.com/'",
          GIT_EXEC_PATH: path.join(repo, "hostile-git-exec"),
          HTTPS_PROXY: "https://attacker.invalid",
          SSL_CERT_FILE: path.join(repo, "hostile-ca.pem"),
        },
      }
    );
    assert.deepEqual(JSON.parse(output), {});
    assert.equal(existsSync(path.join(repo, "node-hijacked")), false);
    assert.equal(hardenedGateEnv({ NODE_OPTIONS: "bad", GIT_DIR: "bad", SAFE: "yes" }).SAFE, "yes");
    assert.equal(hardenedGateEnv({ NODE_OPTIONS: "bad" }).NODE_OPTIONS, undefined);
    assert.equal(hardenedGateEnv({ LD_LIBRARY_PATH: "bad" }).LD_LIBRARY_PATH, undefined);
    assert.equal(
      hardenedGateEnv({ GIT_CONFIG_PARAMETERS: "bad" }).GIT_CONFIG_PARAMETERS,
      undefined
    );
    assert.equal(hardenedGateEnv({ GIT_EXEC_PATH: "bad" }).GIT_EXEC_PATH, undefined);
    assert.equal(hardenedGateEnv({ HTTPS_PROXY: "bad" }).HTTPS_PROXY, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("reviewer config roots come from the OS account, not hook environment", () => {
  const env = trustedReviewerEnv({
    HOME: "/tmp/hostile-home",
    XDG_CONFIG_HOME: "/tmp/hostile-config",
    CURSOR_CONFIG_DIR: "/tmp/hostile-cursor",
    CURSOR_RIPGREP_PATH: "/tmp/hostile-rg",
    CURSOR_API_BASE_URL: "https://attacker.invalid",
    HTTPS_PROXY: "https://attacker.invalid",
    NODE_EXTRA_CA_CERTS: "/tmp/hostile-ca.pem",
    LD_LIBRARY_PATH: "/tmp/hostile-libraries",
    CURSOR_API_KEY: "retained-auth",
  });
  assert.notEqual(env.HOME, "/tmp/hostile-home");
  assert.equal(env.XDG_CONFIG_HOME, path.join(env.HOME, ".config"));
  assert.equal(env.CURSOR_CONFIG_DIR, undefined);
  assert.equal(env.CURSOR_RIPGREP_PATH, undefined);
  assert.equal(env.CURSOR_API_BASE_URL, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.NODE_EXTRA_CA_CERTS, undefined);
  assert.equal(env.LD_LIBRARY_PATH, undefined);
  assert.equal(env.CURSOR_API_KEY, "retained-auth");
  assert.equal(env.SHELL, "/bin/sh");
});

test("AIO-567: OpenCode idle handler is advisory — plain gate call, one log, never a re-prompt", async () => {
  const repo = fixture();
  const argvLog = path.join(repo, "gate-argv.log");
  try {
    mkdirSync(path.join(repo, "hooks"));
    writeFileSync(
      path.join(repo, "hooks", "local-bugbot-gate.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
        'console.log(JSON.stringify({ status: "advisory", advisory: "[local-bugbot advisory] Unreviewed changes in: /wt; they will gate at aios build --merge / aios ship", fingerprint: "fp-1" }));',
        "",
      ].join("\n")
    );
    const promptCalls = [];
    const client = {
      session: {
        promptAsync: async (input) => {
          promptCalls.push(input);
          return {};
        },
      },
    };
    const hooks = await AIOSBugbot({ directory: repo, client });
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
      // An unchanged changeset on the next idle logs nothing — one nudge per fingerprint.
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
      // Leaving idle resets the dedup, so the next idle re-nudges.
      await hooks.event({
        event: { type: "session.status", properties: { sessionID: "s1", status: "busy" } },
      });
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    } finally {
      console.error = originalError;
    }
    assert.equal(promptCalls.length, 0, "the idle handler must never re-prompt the session");
    const advisories = logs.filter((line) => /Unreviewed changes/.test(line));
    assert.equal(advisories.length, 2, "one advisory per fingerprint per idle stretch");
    const invocations = readFileSync(argvLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(invocations.length, 3);
    for (const argv of invocations) {
      assert.deepEqual(
        argv,
        ["--runtime", "opencode"],
        "the plugin must use the plain (advisory) invocation — never --json/--check-exit"
      );
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("AIO-567: an OpenCode advisory probe failure is logged, never escalated", async () => {
  const repo = fixture();
  try {
    mkdirSync(path.join(repo, "hooks"));
    writeFileSync(path.join(repo, "hooks", "local-bugbot-gate.mjs"), "process.exit(7);\n");
    const hooks = await AIOSBugbot({ directory: repo, client: { session: {} } });
    const logs = [];
    const originalError = console.error;
    console.error = (...args) => logs.push(args.join(" "));
    try {
      // Must resolve (not reject): a failed probe is advisory noise, not a session block.
      await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } });
    } finally {
      console.error = originalError;
    }
    assert.equal(
      logs.some((line) => /advisory probe failed/.test(line)),
      true
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("native command entry points emit only valid runtime JSON and ignore stdin cwd", () => {
  const gate = path.join(REPO, "hooks", "local-bugbot-gate.mjs");
  const unrelated = mkdtempSync(path.join(tmpdir(), "aios-bugbot-unrelated-"));
  try {
    for (const runtime of ["claude", "codex", "cursor", "opencode"]) {
      const args = [gate, "--runtime", runtime, "--probe"];
      const child = execFileSync(process.execPath, args, {
        cwd: unrelated,
        encoding: "utf8",
        input: JSON.stringify({ cwd: REPO }),
        // --probe is immune to AIOS_BUGBOT_DISABLE today (both the gate's and main()'s disable
        // checks skip while probing) but sanitize anyway for consistency with the other spawn
        // sites in this file, so this test doesn't start depending on ambient config if that
        // guard is ever relaxed.
        env: { ...process.env, AIOS_BUGBOT_DISABLE: "" },
      });
      const output = JSON.parse(child);
      assert.equal(output.status, "error");
      assert.match(output.reason, /not a git repository/i);
    }
  } finally {
    rmSync(unrelated, { recursive: true, force: true });
  }
});

test("all four checked-in runtime adapters point to the shared gate", () => {
  const claude = JSON.parse(readFileSync(path.join(REPO, ".claude", "settings.json"), "utf8"));
  const codex = JSON.parse(readFileSync(path.join(REPO, ".codex", "hooks.json"), "utf8"));
  const cursor = JSON.parse(readFileSync(path.join(REPO, ".cursor", "hooks.json"), "utf8"));
  const openCodeConfig = JSON.parse(
    readFileSync(path.join(REPO, ".opencode", "opencode.json"), "utf8")
  );
  assert.match(JSON.stringify(claude.hooks.Stop), /run-local-bugbot-gate\.sh\\" claude/);
  assert.match(JSON.stringify(codex.hooks.Stop), /run-local-bugbot-gate\.sh\\" codex/);
  assert.match(JSON.stringify(cursor.hooks.stop), /run-local-bugbot-gate\.sh\\" cursor/);
  assert.match(JSON.stringify(claude.hooks.Stop), /\\"\$\{CLAUDE_PROJECT_DIR\}/);
  assert.match(JSON.stringify(cursor.hooks.stop), /\$\{CURSOR_PROJECT_DIR\}/);
  assert.match(JSON.stringify(codex.hooks.Stop), /\/usr\/bin\/env -i/);
  assert.match(JSON.stringify(codex.hooks.Stop), /\/usr\/bin\/git/);
  assert.match(JSON.stringify(codex.hooks.Stop), /\/opt\/homebrew\/bin\/git/);
  assert.ok(claude.hooks.Stop[0].hooks.at(-1).timeout >= 86_400);
  assert.ok(codex.hooks.Stop[0].hooks[0].timeout >= 86_400);
  assert.ok(cursor.hooks.stop[0].timeout >= 86_400);
  assert.deepEqual(openCodeConfig.plugin, ["./plugins/aios-bugbot.mjs"]);

  const openCode = readFileSync(path.join(REPO, ".opencode", "plugins", "aios-bugbot.mjs"), "utf8");
  const hydration = readFileSync(path.join(REPO, "scripts", "link-worktree-env.sh"), "utf8");
  assert.match(openCode, /session\.status/);
  assert.match(openCode, /session\.idle/);
  assert.match(openCode, /lastAdvisoryFingerprint/);
  assert.match(openCode, /local-bugbot-gate\.mjs/);
  assert.match(openCode, /timeout:\s*GATE_TIMEOUT_MS/);
  assert.match(openCode, /required gate script missing/);
  assert.match(openCode, /env:\s*hardenedGateEnv\(\)/);
  // AIO-567: the idle handler is advisory-only — the session-continuation machinery must not
  // creep back into the plugin.
  assert.doesNotMatch(openCode, /promptAsync/);
  assert.match(hydration, /cp -Rn.*scaffold\/\.opencode/s);

  // Assert the gate's BEHAVIOUR, never its source text: source-text matching breaks under
  // the mutation lane (Stryker rewrites the very literals a regex is looking for) and does
  // not actually prove the child is invoked correctly.
  const args = reviewChildArgs({
    repo: "/repo",
    baseSha: "abc123",
    branch: "feat/x",
    model: REQUIRED_BUGBOT_MODEL,
  });
  for (const flag of [
    "--cursor-timeout",
    "--read-only",
    "--hook-protocol",
    "--exclude-generated",
    "--include-worktree",
  ]) {
    assert.ok(args.includes(flag), `the child reviewer is invoked with ${flag}`);
  }
  assert.equal(args[args.indexOf("--model") + 1], REQUIRED_BUGBOT_MODEL);
  assert.equal(args[0], path.join("/repo", "scripts", "aios.mjs"));
  const childEnv = hardenedChildEnv({
    PATH: "/hostile/bin",
    NODE_OPTIONS: "--require /hostile.js",
    GIT_DIR: "/hostile/.git",
    HTTPS_PROXY: "https://attacker.invalid",
    AIOS_BUGBOT_MODEL: "cursor:forged",
    KEEP: "yes",
  });
  assert.equal(childEnv.PATH, "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.GIT_DIR, undefined);
  assert.equal(childEnv.HTTPS_PROXY, undefined);
  assert.equal(childEnv.AIOS_BUGBOT_MODEL, undefined);
  assert.equal(childEnv.KEEP, "yes");
  // The matching assertions that build.mjs/ship.mjs cannot be steered onto a forged reviewer
  // model live in aios-devtools now (AIO-662) — they are source-text checks on devtools files,
  // which core can no longer read. Core keeps the part it owns: that the CHILD is invoked with
  // the required model, asserted behaviourally above via reviewChildArgs().
});

test("manual check-exit mode returns non-zero on an infrastructure failure", () => {
  const repo = fixture();
  try {
    const gate = path.join(REPO, "hooks", "local-bugbot-gate.mjs");
    rmSync(path.join(repo, "scripts", "aios.mjs"));
    const child = spawnSync(
      process.execPath,
      [gate, "--runtime", "opencode", "--json", "--check-exit"],
      {
        cwd: repo,
        encoding: "utf8",
        // A developer's ambient AIOS_BUGBOT_DISABLE=1 must not turn this infrastructure
        // failure into a silent "skipped" — see the in-process wrapper's identical guard above.
        env: { ...process.env, AIOS_BUGBOT_DISABLE: "" },
      }
    );
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).status, "error");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("AIO-567: a plain Stop invocation exits 0 with a non-blocking shape even on a probe hard-error", () => {
  const gate = path.join(REPO, "hooks", "local-bugbot-gate.mjs");
  const unrelated = mkdtempSync(path.join(tmpdir(), "aios-bugbot-advisory-"));
  try {
    for (const runtime of ["claude", "codex", "cursor", "opencode"]) {
      const child = spawnSync(process.execPath, [gate, "--runtime", runtime], {
        cwd: unrelated,
        encoding: "utf8",
        input: "{}",
        env: { ...process.env, AIOS_BUGBOT_DISABLE: "" },
      });
      assert.equal(child.status, 0, `${runtime}: the Stop path must never signal failure`);
      const shape = JSON.parse(child.stdout);
      for (const key of BLOCKING_SHAPE_KEYS) {
        assert.equal(key in shape, false, `${runtime} must not emit ${key} at Stop`);
      }
      if (runtime === "claude" || runtime === "codex") {
        assert.match(shape.systemMessage, /local-bugbot advisory/);
        assert.match(shape.systemMessage, /non-blocking/);
      }
      if (runtime === "cursor") assert.deepEqual(shape, {});
      if (runtime === "opencode") assert.equal(shape.status, "advisory");
      assert.match(child.stderr, /local-bugbot advisory/);
    }
  } finally {
    rmSync(unrelated, { recursive: true, force: true });
  }
});

test("AIO-567: a real-repo probe error at Stop stays advisory — exit 0, no blocking keys", () => {
  const repo = fixture();
  try {
    // Missing review CLI is a hard fail-closed error for the review sweep; at Stop it must
    // degrade to a non-blocking advisory instead of freezing the session.
    rmSync(path.join(repo, "scripts", "aios.mjs"));
    appendFileSync(path.join(repo, "tracked.txt"), "unreviewed change\n");
    const gate = path.join(REPO, "hooks", "local-bugbot-gate.mjs");
    const child = spawnSync(process.execPath, [gate, "--runtime", "claude"], {
      cwd: repo,
      encoding: "utf8",
      input: "{}",
      env: { ...process.env, AIOS_BUGBOT_DISABLE: "" },
    });
    assert.equal(child.status, 0);
    const shape = JSON.parse(child.stdout);
    for (const key of BLOCKING_SHAPE_KEYS) assert.equal(key in shape, false);
    assert.match(shape.systemMessage, /Advisory probe issues \(non-blocking\)/);
    assert.match(shape.systemMessage, /scripts\/aios\.mjs/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("AIO-567: AIOS_BUGBOT_DISABLE=1 keeps the Stop advisory fully inert", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "unreviewed change\n");
    // Canary: any spawned review would execute scripts/aios.mjs, which records itself.
    writeFileSync(
      path.join(repo, "scripts", "aios.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(
        path.join(repo, "reviewer-spawned")
      )}, "1");\n`
    );
    const gate = path.join(REPO, "hooks", "local-bugbot-gate.mjs");
    for (const runtime of ["claude", "codex", "cursor", "opencode"]) {
      const child = spawnSync(process.execPath, [gate, "--runtime", runtime], {
        cwd: repo,
        encoding: "utf8",
        input: "{}",
        env: { ...process.env, AIOS_BUGBOT_DISABLE: "1" },
      });
      assert.equal(child.status, 0);
      const shape = JSON.parse(child.stdout);
      for (const key of BLOCKING_SHAPE_KEYS) assert.equal(key in shape, false);
      if (runtime === "opencode") {
        assert.equal(shape.status, "advisory");
        assert.equal(shape.advisory, null);
      } else {
        assert.deepEqual(shape, {});
      }
      assert.match(child.stderr, /AIOS_BUGBOT_DISABLE=1/);
    }
    assert.equal(existsSync(path.join(repo, "reviewer-spawned")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("AIO-567: merge-time entry points still block on Medium+ evidence", async () => {
  // The Stop hook change must not weaken the merge path: `aios build --merge` / `aios ship`
  // reach runLocalPrePrReview / hasFindingsAtOrAbove, which stay fail-closed on Medium+.
  assert.equal(hasFindingsAtOrAbove("- Medium: stale check", "medium"), true);
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 120_000,
      reviewPrompt: async () => `- Medium: regression\n\n${BUGBOT_CLEAR_TOKEN}`,
    });
    assert.equal(review.ok, false, "Medium+ evidence must still block the merge-time review");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- AIO-468: an unreadable verdict is re-asked once; a FINDING never is ----------------
// The reviewing model nondeterministically prefaces the clear token with narration
// ("Reviewing the diff for bugs."), which `detectBugbotClear` rejects by design (prose
// alongside a verdict may be a hedge). That produced a protocol error, and the hook treats
// a protocol error as a hard block — so the gate false-blocked ~3 runs in 6. The cure is at
// the caller: re-ask ONCE when there is no readable verdict. The verdict predicate itself
// stays strict, and a real finding is never re-asked (that would be a bypass).

function narrationThenToken() {
  return `Reviewing the diff for bugs. I'll check a few areas the diff may have truncated.\n${BUGBOT_CLEAR_TOKEN}`;
}

test("AIO-468: an unreadable verdict is re-asked once and can then clear", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "change");
    const calls = [];
    const review = await runLocalBugbotReview({
      worktree: repo,
      baseSha: "HEAD~1",
      branch: "feat/test",
      failOn: "medium",
      readOnly: true,
      reviewPrompt: async (input) => {
        calls.push(input.label);
        // First attempt of each pass narrates (unreadable); the re-ask answers bare.
        const attempt = calls.filter((label) => label === input.label).length;
        return attempt === 1 ? narrationThenToken() : BUGBOT_CLEAR_TOKEN;
      },
      secretsPreflight: () => ({ ok: true }),
    });
    assert.equal(review.ok, true, "a re-asked, readable clear verdict passes the gate");
    assert.equal(calls.length, 4, "each of the two passes was asked exactly twice");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("AIO-468: a Medium finding is NEVER re-asked (re-asking a finding would be a bypass)", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "change");
    const calls = [];
    const review = await runLocalBugbotReview({
      worktree: repo,
      baseSha: "HEAD~1",
      branch: "feat/test",
      failOn: "medium",
      readOnly: true,
      reviewPrompt: async (input) => {
        calls.push(input.label);
        return "- Medium: real regression";
      },
      secretsPreflight: () => ({ ok: true }),
    });
    assert.equal(review.ok, false, "the finding blocks");
    assert.equal(calls.length, 2, "one call per pass — a finding is a verdict, not a retry");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("AIO-468: two consecutive unreadable verdicts stay blocked and name the failing pass", async () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    git(repo, "add", "tracked.txt");
    git(repo, "commit", "-qm", "change");
    const calls = [];
    const review = await runLocalBugbotReview({
      worktree: repo,
      baseSha: "HEAD~1",
      branch: "feat/test",
      failOn: "medium",
      readOnly: true,
      reviewPrompt: async (input) => {
        calls.push(input.label);
        return narrationThenToken(); // never becomes readable
      },
      secretsPreflight: () => ({ ok: true }),
    });
    assert.equal(review.ok, false, "fail-closed: still no readable verdict after the re-ask");
    assert.equal(calls.length, 4, "exactly one re-ask per pass — bounded, not a loop");
    assert.match(review.output, /protocol error in the .*(code|security) review pass/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("AIO-468: both prompts demand the verdict as a bare final line", () => {
  const shared = {
    branch: "feat/x",
    baseSha: "abc123",
    diffStat: " a | 1 +",
    diff: "+line",
    logOneline: "abc feat",
  };
  const code = buildBugbotPrompt({ skill: "/review-bugbot", ...shared });
  const security = buildSecurityReviewPrompt({ ...shared });
  for (const [name, prompt] of [
    ["code", code],
    ["security", security],
  ]) {
    assert.match(
      prompt,
      /FINAL line of your response/,
      `${name} prompt demands a final-line verdict`
    );
    assert.match(prompt, /no preamble or narration/i, `${name} prompt forbids preamble`);
  }
});

test("AIOS_BUGBOT_DISABLE=1 skips the local gate without running any review", () => {
  const repo = fixture();
  try {
    appendFileSync(path.join(repo, "tracked.txt"), "change\n");
    let calls = 0;
    const review = () => {
      calls++;
      return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
    };
    const gated = evaluateLocalBugbotGate({
      repo,
      env: { AIOS_BUGBOT_BASE: "HEAD", AIOS_BUGBOT_DISABLE: "1" },
      runReview: review,
    });
    // `skipped` is non-blocking in every consumer; the review never runs.
    assert.equal(gated.status, "skipped");
    assert.match(gated.reason, /AIOS_BUGBOT_DISABLE/);
    assert.equal(calls, 0, "no external review may be dispatched while disabled");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("only the literal 1 disables the gate — a stray truthy value still reviews", () => {
  for (const value of ["true", "0", "yes", " ", ""]) {
    const repo = fixture();
    try {
      appendFileSync(path.join(repo, "tracked.txt"), "change\n");
      let calls = 0;
      const review = () => {
        calls++;
        return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
      };
      const gated = evaluateLocalBugbotGate({
        repo,
        env: { AIOS_BUGBOT_BASE: "HEAD", AIOS_BUGBOT_DISABLE: value },
        runReview: review,
      });
      assert.notEqual(gated.status, "skipped", `value ${JSON.stringify(value)} must not disable`);
      assert.equal(calls, 1, `value ${JSON.stringify(value)} must still run the review`);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("check-secrets: anchored Basic Auth pattern ignores URLs but catches real credentials", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-check-secrets-"));
  const script = path.join(REPO, "validation", "check-secrets.sh");
  const run = () => {
    try {
      execFileSync("bash", [script, dir], { encoding: "utf8", stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status ?? 1;
    }
  };
  try {
    // Minified-CSS shape: an at-rule `@` and a `prop:val` colon that the un-anchored pattern used to
    // stitch into a false "user:pass@host" match. Must NOT trip.
    writeFileSync(
      path.join(dir, "app.css"),
      ".a{color:red}@layer p{background:url(https://cdn.tailwindcss.com/x.png)}@media(min-width:1px){b:c}\n"
    );
    assert.equal(run(), 0, "an ordinary URL beside CSS colons/at-rules is not a basic-auth secret");

    // A genuine embedded credential — including an `s`-initial username, which a `\s`-in-bracket
    // pattern would silently miss — must be caught. Assembled at runtime by joining on the `:` so
    // this committed test file never contains a literal `://user:pass@` that check-secrets would
    // (correctly) flag against itself in CI.
    const credentialUrl = ["https://svc", "s3cr3tpass@internal.example.com/x"].join(":");
    writeFileSync(path.join(dir, "leak.txt"), `HOOK=${credentialUrl}\n`);
    assert.equal(run(), 1, "a real basic-auth credential must still be flagged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-secrets treats leading-hyphen private-key patterns as patterns", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-check-secrets-private-key-"));
  const script = path.join(REPO, "validation", "check-secrets.sh");
  try {
    const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    writeFileSync(path.join(dir, "leak.txt"), `${privateKeyHeader}\n`);

    const result = spawnSync("bash", [script, dir], { encoding: "utf8" });
    assert.equal(result.status, 1, "a private-key header must remain a hard failure");
    assert.match(result.stdout, /Private Key Header/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-secrets ignores a gitignored .env but blocks the same file when tracked", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "aios-check-secrets-env-"));
  const script = path.join(REPO, "validation", "check-secrets.sh");
  const run = () => spawnSync("bash", [script, dir], { encoding: "utf8" });
  try {
    git(dir, "init", "-q");
    writeFileSync(path.join(dir, ".gitignore"), ".env\n");
    writeFileSync(path.join(dir, ".env"), `TOGGL_API_TOKEN=${"a".repeat(32)}\n`);

    const ignored = run();
    assert.equal(ignored.status, 0, "a gitignored local .env must not enter the content scan");

    git(dir, "add", "-f", ".env");
    const tracked = run();
    assert.equal(tracked.status, 1, "a tracked .env must remain a hard failure");
    assert.match(tracked.stdout, /\.env file committed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- AIO wall-clock budget: one absolute deadline for the whole review run ---------------
// Before this, the budget was DERIVED (attempts × 3 × per-call timeout), the AIO-468 protocol
// re-ask silently doubled the real worst case, and the parent hook SIGTERMed its own child
// mid-review — producing "Bugbot exited without a status" and no verdict at all. Every test
// below drives an INJECTED clock; none of them waits on real time.

function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    sleep: async (ms) => {
      current += ms;
    },
  };
}

function changedRepo() {
  const repo = fixture();
  appendFileSync(path.join(repo, "tracked.txt"), "changed\n");
  return repo;
}

test("the shared deadline reserves the security pass a full attempt", async () => {
  const repo = changedRepo();
  try {
    const clock = fakeClock();
    const calls = [];
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      // Larger than the code pass's allowance: only the deadline may bound the calls.
      timeoutMs: 400_000,
      now: clock.now,
      sleep: clock.sleep,
      reviewPrompt: async ({ label, timeoutMs, deadlineAt }) => {
        calls.push({ label, timeoutMs, deadlineAt, startedAt: clock.now() });
        clock.advance(deadlineAt - clock.now()); // each pass spends everything it is allowed
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, true);
    assert.equal(calls.length, 2, "both mandatory passes ran, sequentially");
    assert.ok(calls[0].label.includes("code review"));
    assert.ok(calls[1].label.includes("security review"));
    const reserveMs = 400_000 + ATTEMPT_RESERVE_MARGIN_MS;
    assert.equal(
      calls[0].deadlineAt,
      REVIEW_WALL_CLOCK_BUDGET_MS - reserveMs,
      "the code pass may not spend the security pass's reservation"
    );
    assert.equal(calls[1].deadlineAt, REVIEW_WALL_CLOCK_BUDGET_MS);
    assert.equal(calls[1].startedAt, REVIEW_WALL_CLOCK_BUDGET_MS - reserveMs);
    assert.equal(
      calls[1].timeoutMs,
      400_000,
      "the security pass gets a FULL attempt, not just enough to start"
    );
    assert.ok(reserveMs > 400_000, "the reservation exceeds one per-attempt timeout");
    assert.ok(
      clock.now() <= REVIEW_WALL_CLOCK_BUDGET_MS,
      `total elapsed ${clock.now()}ms exceeded the wall-clock budget`
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("each call's timeout is clamped to the smaller of the per-attempt and remaining budget", async () => {
  const repo = changedRepo();
  try {
    const clock = fakeClock();
    const timeouts = [];
    await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 400_000,
      now: clock.now,
      sleep: clock.sleep,
      reviewPrompt: async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        clock.advance(timeoutMs);
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.deepEqual(timeouts, [400_000, 400_000], "the per-attempt timeout wins while it fits");
    assert.ok(clock.now() + 0 <= REVIEW_WALL_CLOCK_BUDGET_MS);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a protocol re-ask is taken with budget and skipped without it", async () => {
  const affordable = changedRepo();
  try {
    const clock = fakeClock();
    let calls = 0;
    const review = await runLocalPrePrReview({
      worktree: affordable,
      baseSha: git(affordable, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 400_000,
      now: clock.now,
      sleep: clock.sleep,
      reviewPrompt: async () => {
        calls++;
        clock.advance(1_000);
        // Narration alongside the token is unreadable by design — a protocol error.
        return calls % 2 === 1 ? `Reviewing the diff.\n${BUGBOT_CLEAR_TOKEN}` : BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, true);
    assert.equal(calls, 4, "with budget left, each pass is re-asked exactly once");
  } finally {
    rmSync(affordable, { recursive: true, force: true });
  }

  const broke = changedRepo();
  try {
    const clock = fakeClock();
    let calls = 0;
    const review = await runLocalPrePrReview({
      worktree: broke,
      baseSha: git(broke, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 5_000_000,
      now: clock.now,
      sleep: clock.sleep,
      reviewPrompt: async ({ timeoutMs }) => {
        calls++;
        clock.advance(timeoutMs); // the first attempt consumes the pass's whole budget
        return `Reviewing the diff.\n${BUGBOT_CLEAR_TOKEN}`;
      },
    });
    assert.equal(review.ok, false, "an unreadable verdict still fails closed");
    assert.equal(review.error, true);
    assert.equal(calls, 2, "no pass may fund a re-ask it cannot pay for");
    assert.match(review.output, /insufficient review budget for protocol retry/);
  } finally {
    rmSync(broke, { recursive: true, force: true });
  }
});

test("an exhausted deadline fails closed instead of skipping the security pass", async () => {
  const repo = changedRepo();
  try {
    const clock = fakeClock();
    let calls = 0;
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 400_000,
      now: clock.now,
      sleep: clock.sleep,
      reviewPrompt: async () => {
        calls++;
        clock.advance(REVIEW_WALL_CLOCK_BUDGET_MS * 2); // the code pass overruns
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(calls, 1, "the security pass must not start past the deadline");
    assert.equal(review.ok, false);
    assert.equal(review.error, true);
    assert.equal(review.reason, "deadline exhausted before security pass");
    assert.equal(review.pass, "security");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a killed review surfaces the signal, elapsed time, and deadline cause", () => {
  const repo = changedRepo();
  try {
    const killed = evaluateLocalBugbotGate({
      repo,
      runReview: () => ({
        ok: false,
        status: null,
        signal: "SIGTERM",
        elapsedMs: 912_000,
        parentDeadlineFired: true,
        output: "",
      }),
    });
    assert.equal(killed.status, "error");
    assert.match(killed.reason, /killed by SIGTERM/);
    assert.match(killed.reason, /912s/);
    assert.match(killed.reason, /wall-clock budget exceeded/);
    assert.match(killed.reason, /not a clear/);
    // Review-mode callers see the raw error (which --check-exit turns into exit 1); the
    // Stop path renders the same result as a non-blocking advisory note.
    const advisoryShape = formatAdvisoryHookResult(
      "claude",
      summarizeAdvisorySweep([{ ...killed, worktree: repo }])
    );
    assert.equal("decision" in advisoryShape, false);
    assert.match(advisoryShape.systemMessage, /non-blocking/);

    // A concurrent waiter reuses the terminal error instead of spawning a duplicate review.
    const waiter = evaluateLocalBugbotGate({
      repo,
      runReview: () => assert.fail("a terminal error handoff must not spawn a duplicate review"),
    });
    assert.equal(waiter.status, "error");
    assert.equal(waiter.cached, true);
    assert.match(waiter.reason, /killed by SIGTERM/);

    // …and it EXPIRES: an error is not evidence about the diff, so it must never harden
    // into a permanent block the way an exact-diff `blocked` finding does.
    const state = path.resolve(
      repo,
      git(repo, "rev-parse", "--git-path", "aios/local-bugbot-gate.json")
    );
    const handoff = JSON.parse(readFileSync(state, "utf8"));
    assert.equal(handoff.status, "error");
    assert.equal(handoff.parentDeadlineFired, true);
    assert.equal(handoff.expiresAt > Date.now(), true);
    assert.ok(
      handoff.expiresAt - Date.now() <= 120_000,
      "the handoff must not lock its own owner out of a retry"
    );
    writeFileSync(state, `${JSON.stringify({ ...handoff, expiresAt: Date.now() - 1 })}\n`);

    let retried = 0;
    const afterExpiry = evaluateLocalBugbotGate({
      repo,
      runReview: () => {
        retried++;
        return { ok: true, status: 0, output: VERIFIED_CLEAR_OUTPUT };
      },
    });
    assert.equal(retried, 1, "an expired handoff must let an independent run retry");
    assert.equal(afterExpiry.status, "clear");
    assert.equal(existsSync(state), false, "a clear never persists a trusted verdict on disk");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("an on-disk error handoff is never laundered into a clear", () => {
  const repo = changedRepo();
  try {
    const state = path.resolve(
      repo,
      git(repo, "rev-parse", "--git-path", "aios/local-bugbot-gate.json")
    );
    const probe = evaluateLocalBugbotGate({ repo, probeOnly: true });
    mkdirSync(path.dirname(state), { recursive: true });
    writeFileSync(
      state,
      `${JSON.stringify({
        status: "error",
        fingerprint: probe.fingerprint,
        expiresAt: Date.now() + 60_000,
        signal: "SIGKILL",
        elapsedMs: 5_000,
      })}\n`
    );
    const result = evaluateLocalBugbotGate({
      repo,
      runReview: () => assert.fail("the live handoff must be returned without a new review"),
    });
    assert.equal(result.status, "error");
    assert.notEqual(result.status, "clear");
    assert.equal(result.verified, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- Lockfile/dist exclusion: PROMPT-only, lifecycle-hook-only, gate-compensated ---------

function lockfileRepo() {
  const repo = fixture();
  writeFileSync(
    path.join(repo, "package-lock.json"),
    `${JSON.stringify({ name: "aios-workspace", lockfileVersion: 3, packages: {} })}\n`
  );
  git(repo, "add", "package-lock.json");
  git(repo, "commit", "-qm", "add lockfile");
  return repo;
}

test("an excluded-only edit still changes the fingerprint and stays out of the prompt", () => {
  const repo = lockfileRepo();
  try {
    const base = git(repo, "rev-parse", "main");
    const lock = path.join(repo, "package-lock.json");
    const first = captureBranchDiff(repo, base, {
      includeWorktree: true,
      excludeFromPrompt: true,
    });
    assert.deepEqual(
      first.excluded.map((file) => file.path),
      ["package-lock.json"]
    );
    assert.match(first.excluded[0].sha256, /^[a-f0-9]{64}$/);
    assert.ok(first.excluded[0].bytes > 0);
    assert.doesNotMatch(first.reviewDiff, /lockfileVersion/);

    appendFileSync(lock, "\n");
    const second = captureBranchDiff(repo, base, {
      includeWorktree: true,
      excludeFromPrompt: true,
    });
    assert.notEqual(
      second.fingerprint,
      first.fingerprint,
      "excluded bytes must still feed the fingerprint"
    );

    // Hook-only: standalone review / aios build / aios ship keep the full atomic diff.
    const unfiltered = captureBranchDiff(repo, base, { includeWorktree: true });
    assert.match(unfiltered.reviewDiff, /lockfileVersion/);
    assert.deepEqual(unfiltered.excluded, []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("both prompts disclose every excluded path with its byte count and digest", () => {
  const excluded = [
    { path: "package-lock.json", bytes: 4242, sha256: "a".repeat(64) },
    { path: "dist/operator-loop/index.js", bytes: 17, sha256: "b".repeat(64) },
  ];
  const shared = {
    branch: "feat/x",
    baseSha: "abc123",
    diffStat: " a | 1 +",
    diff: "+line",
    logOneline: "abc feat",
    excluded,
  };
  for (const [name, prompt] of [
    ["code", buildBugbotPrompt({ skill: "/review-bugbot", ...shared })],
    ["security", buildSecurityReviewPrompt({ ...shared })],
  ]) {
    assert.match(prompt, /Changed, not shown/, `${name} prompt announces the exclusion`);
    for (const file of excluded) {
      assert.ok(
        prompt.includes(`${file.path} — ${file.bytes} bytes, sha256 ${file.sha256}`),
        `${name} prompt lists ${file.path} with its byte count and digest`
      );
    }
  }
});

test("a lockfile change without its manifest blocks", async () => {
  const repo = lockfileRepo();
  try {
    const gates = runExcludedPathGates(
      repo,
      [{ path: "package-lock.json", bytes: 10, sha256: "c".repeat(64) }],
      ["package-lock.json", "tracked.txt"]
    );
    assert.equal(gates.ok, false);
    assert.match(gates.reason, /without a matching package\.json change/);

    appendFileSync(path.join(repo, "package-lock.json"), "\n");
    let calls = 0;
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      excludeFromPrompt: true,
      reviewPrompt: async () => {
        calls++;
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, false);
    assert.equal(review.error, true);
    assert.equal(calls, 0, "a failed compensating gate blocks before any reviewer runs");
    assert.match(review.output, /compensating gate failed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- H3: the lockfile delta is the reviewable form of an excluded lockfile ---------------
// `npm ci --dry-run` resolves the tree FROM the lockfile and never fetches a tarball, so it
// proves lock↔manifest agreement and nothing else: a tampered integrity hash and a `resolved`
// repointed at an attacker mirror both exit 0. These checks are the actual content control.

const NPM_TARBALL = "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz";

function lockWith(entry) {
  return {
    name: "aios-workspace",
    lockfileVersion: 3,
    packages: { "": { name: "aios-workspace" }, "node_modules/left-pad": entry },
  };
}

function lockDelta(before, after) {
  const repo = fixture();
  try {
    const lock = path.join(repo, "package-lock.json");
    writeFileSync(lock, `${typeof before === "string" ? before : JSON.stringify(before)}\n`);
    git(repo, "add", "package-lock.json");
    git(repo, "commit", "-qm", "lockfile");
    const base = git(repo, "rev-parse", "HEAD");
    writeFileSync(lock, `${typeof after === "string" ? after : JSON.stringify(after)}\n`);
    return inspectLockDelta(repo, "package-lock.json", base);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

const PINNED = { version: "1.3.0", resolved: NPM_TARBALL, integrity: "sha512-AAA" };

test("a lockfile entry repointed at a foreign registry host blocks", () => {
  const delta = lockDelta(
    lockWith(PINNED),
    lockWith({ ...PINNED, resolved: "https://evil.example.com/left-pad-1.3.0.tgz" })
  );
  assert.equal(delta.failures.length, 1);
  assert.match(delta.failures[0], /evil\.example\.com.*not an allowed registry host/);
});

test("a tampered integrity hash on an unchanged version blocks", () => {
  const delta = lockDelta(lockWith(PINNED), lockWith({ ...PINNED, integrity: "sha512-EVIL" }));
  assert.equal(delta.failures.length, 1);
  assert.match(delta.failures[0], /without changing version or resolved URL/);
});

test("an entry that loses or never had an integrity hash blocks", () => {
  const dropped = lockDelta(
    lockWith(PINNED),
    lockWith({ version: PINNED.version, resolved: PINNED.resolved })
  );
  assert.match(dropped.failures.join(" "), /lost its integrity hash/);

  const added = lockDelta(
    { name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } },
    lockWith({ version: "1.3.0", resolved: NPM_TARBALL })
  );
  assert.match(added.failures.join(" "), /added with a tarball but no integrity hash/);
});

test("an honest version bump passes and is summarized for the reviewer", () => {
  const delta = lockDelta(
    lockWith(PINNED),
    lockWith({
      version: "1.4.0",
      resolved: "https://registry.npmjs.org/left-pad/-/left-pad-1.4.0.tgz",
      integrity: "sha512-BBB",
    })
  );
  assert.deepEqual(delta.failures, []);
  assert.equal(delta.summary.length, 1);
  assert.match(delta.summary[0], /node_modules\/left-pad 1\.3\.0 → 1\.4\.0/);
  assert.match(delta.summary[0], /registry\.npmjs\.org/);
  assert.match(delta.summary[0], /integrity changed/);

  const removed = lockDelta(lockWith(PINNED), {
    name: "x",
    lockfileVersion: 3,
    packages: { "": { name: "x" } },
  });
  assert.deepEqual(removed.failures, []);
  assert.match(removed.summary.join(" "), /left-pad 1\.3\.0 → \(removed\)/);
});

test("an unparseable or pre-v2 lockfile fails closed", () => {
  const broken = lockDelta(lockWith(PINNED), "{ not json");
  assert.equal(broken.failures.length, 1);
  assert.match(broken.failures[0], /could not be parsed for review/);

  const legacy = lockDelta(lockWith(PINNED), {
    name: "x",
    lockfileVersion: 1,
    dependencies: { "left-pad": { version: "9.9.9" } },
  });
  assert.match(legacy.failures.join(" "), /lockfileVersion 2\+ is required/);
});

test("the summarized lockfile delta reaches both prompts", async () => {
  const repo = lockfileRepo();
  try {
    appendFileSync(path.join(repo, "package-lock.json"), "\n");
    appendFileSync(path.join(repo, "package.json"), "\n");
    const prompts = [];
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      excludeFromPrompt: true,
      // Stand in for the real gates; their own outputs are covered above and below.
      excludedPathGates: () => ({
        ok: true,
        summaries: {
          "package-lock.json": ["node_modules/left-pad 1.3.0 → 1.4.0 [registry.npmjs.org]"],
        },
      }),
      reviewPrompt: async ({ prompt }) => {
        prompts.push(prompt);
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, true);
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) {
      assert.match(prompt, /Changed, not shown in full/);
      assert.match(prompt, /package-lock\.json — \d+ bytes, sha256 [a-f0-9]{64}/);
      assert.match(prompt, /node_modules\/left-pad 1\.3\.0 → 1\.4\.0 \[registry\.npmjs\.org\]/);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ---- H1/M4: the compensating gate runs REAL npm against this repo's own lockfile ---------
// It shipped broken (a sanitized PATH stripped `node`, so npm's `#!/usr/bin/env node`
// shebang died in 34 ms and EVERY lockfile change was hard-blocked) because only stand-ins
// were ever exercised. This test invokes the real thing.

test("the real compensating gate clears this repo's own real lockfile", () => {
  // Seeded from THIS repo's actual manifests, so real npm resolves the real 900-package
  // lock — but in a self-contained fixture, independent of the ambient checkout's git state
  // (the mutation lane runs these tests from a sandbox copy).
  const repo = mkdtempSync(path.join(tmpdir(), "aios-bugbot-real-lock-"));
  try {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "AIOS Test");
    git(repo, "config", "user.email", "test@aios.invalid");
    const seeded = [
      "package.json",
      "package-lock.json",
      ".nvmrc",
      "gui/client/package.json",
      "gui/server/package.json",
    ].filter((rel) => existsSync(path.join(REPO, rel)));
    for (const rel of seeded) {
      mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
      writeFileSync(path.join(repo, rel), readFileSync(path.join(REPO, rel)));
    }
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "seed real manifests");

    const gates = runExcludedPathGates(
      repo,
      [{ path: "package-lock.json", bytes: 0, sha256: "e".repeat(64) }],
      ["package-lock.json", "package.json"],
      { baseSha: git(repo, "rev-parse", "HEAD") }
    );
    assert.equal(gates.ok, true, `real npm verification must succeed, got: ${gates.reason}`);
    assert.deepEqual(gates.summaries["package-lock.json"], []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the compensating gates run before the review clock starts", async () => {
  const repo = lockfileRepo();
  try {
    appendFileSync(path.join(repo, "package-lock.json"), "\n");
    const clock = fakeClock();
    const gateCostMs = 300_000;
    let gateFinishedAt = 0;
    const calls = [];
    await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: 400_000,
      now: clock.now,
      sleep: clock.sleep,
      excludeFromPrompt: true,
      excludedPathGates: () => {
        clock.advance(gateCostMs); // an expensive precondition, e.g. a real `npm ci`
        gateFinishedAt = clock.now();
        return { ok: true, summaries: {} };
      },
      reviewPrompt: async ({ deadlineAt }) => {
        calls.push({ deadlineAt, startedAt: clock.now() });
        clock.advance(1_000);
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(gateFinishedAt, gateCostMs);
    assert.equal(
      calls[1].deadlineAt - gateFinishedAt,
      REVIEW_WALL_CLOCK_BUDGET_MS,
      "gate time must not be charged against the reviewer's budget"
    );
    assert.equal(calls[0].deadlineAt - gateFinishedAt, REVIEW_WALL_CLOCK_BUDGET_MS - 430_000);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a workspace link entry is not judged by the tarball rules", () => {
  // This repo's own lockfile carries `link: true` workspace entries with a RELATIVE
  // `resolved` and no `integrity` — by construction, not by tampering. Judging them with
  // the registry-host and integrity rules would hard-block every real workspace change.
  const linkEntry = { resolved: "gui/client", link: true };
  const added = lockDelta(
    { name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } },
    lockWith(linkEntry)
  );
  assert.deepEqual(added.failures, []);
  assert.match(added.summary.join(" "), /workspace link gui\/client/);

  // A non-registry tarball source is still fail-closed.
  const gitDep = lockDelta(
    lockWith(PINNED),
    lockWith({
      version: "1.3.0",
      resolved: "git+ssh://git@github.com/x/y.git#abc",
      integrity: "sha512-AAA",
    })
  );
  assert.match(gitDep.failures.join(" "), /not a registry tarball/);
});

// ---- L4: a link target must resolve inside the worktree, not just be well-formed --------
// `npm ci` itself refuses an out-of-tree `link` target with an EUSAGE error, but that
// defense lives in npm, not in this inspector — a reviewer reading `inspectLockDelta`'s
// output alone would never see it enforced. The gate must assert containment itself.

test("a relative link target that escapes the worktree blocks", () => {
  const escaped = lockDelta(
    { name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } },
    lockWith({ resolved: "../../evil", link: true })
  );
  assert.equal(escaped.failures.length, 1);
  assert.match(escaped.failures[0], /resolves outside the worktree/);
});

test("an absolute out-of-tree link target blocks", () => {
  const escaped = lockDelta(
    { name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } },
    lockWith({ resolved: "/etc/passwd", link: true })
  );
  assert.equal(escaped.failures.length, 1);
  assert.match(escaped.failures[0], /resolves outside the worktree/);
});

test("legitimate in-tree workspace links still pass containment", () => {
  const client = lockDelta(
    { name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } },
    lockWith({ resolved: "gui/client", link: true })
  );
  assert.deepEqual(client.failures, []);

  const server = lockDelta(
    { name: "x", lockfileVersion: 3, packages: { "": { name: "x" } } },
    lockWith({ resolved: "gui/server", link: true })
  );
  assert.deepEqual(server.failures, []);
});

test("an oversized per-attempt timeout is clamped, never crash-shaped", async () => {
  const repo = changedRepo();
  try {
    // A caller-supplied timeout at or above the whole budget used to leave the code pass a
    // non-positive allowance, so `attemptBudgetMs` threw out of the run — a crash instead of
    // a verdict. The reserve is clamped to half the budget, so both passes stay fundable.
    const clock = fakeClock();
    const timeouts = [];
    const review = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      timeoutMs: REVIEW_WALL_CLOCK_BUDGET_MS * 2,
      now: clock.now,
      sleep: clock.sleep,
      reviewPrompt: async ({ timeoutMs }) => {
        timeouts.push(timeoutMs);
        clock.advance(timeoutMs);
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(review.ok, true);
    assert.deepEqual(timeouts, [REVIEW_WALL_CLOCK_BUDGET_MS / 2, REVIEW_WALL_CLOCK_BUDGET_MS / 2]);
    assert.ok(clock.now() <= REVIEW_WALL_CLOCK_BUDGET_MS);

    // A budget that genuinely cannot fund two passes fails closed and SAYS SO.
    let calls = 0;
    const starved = await runLocalPrePrReview({
      worktree: repo,
      baseSha: git(repo, "rev-parse", "main"),
      branch: "feat/gate",
      wallClockBudgetMs: 60_000,
      now: fakeClock().now,
      reviewPrompt: async () => {
        calls++;
        return BUGBOT_CLEAR_TOKEN;
      },
    });
    assert.equal(starved.ok, false);
    assert.equal(starved.error, true);
    assert.equal(calls, 0, "no reviewer runs on a budget that cannot fund both passes");
    assert.match(starved.output, /review budget too small for two passes/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * AIO-555 — target selection and fail-closed aggregation.
 *
 * The gate used to review whichever directory the session started in, which under the mandated
 * worktree workflow (CLAUDE.md §5) is the primary checkout — the one tree that by construction
 * holds no work. Targets now come from git's worktree registry.
 *
 * Selection deliberately does NO filtering: an earlier revision skipped worktrees that looked
 * clean or pushed, which an agent could forge with one `git update-ref` or `git update-index
 * --skip-worktree`. evaluateLocalBugbotGate already excludes empty diffs against a base resolved
 * from the canonical remote, so exclusion happens against a signal the agent cannot write.
 */

const PRIMARY_ROOT = REPO;
const DIRTY_ROOT = path.join(REPO, "scripts");
const PUSHED_ROOT = path.join(REPO, "test");

function nulListing(roots) {
  return roots.map((root) => `worktree ${root}\0HEAD abc\0`).join("");
}

test("AIO-555: every existing registered worktree is a target, unfiltered", () => {
  const roots = [PRIMARY_ROOT, DIRTY_ROOT, PUSHED_ROOT];
  const selected = listGateTargets(PRIMARY_ROOT, () => nulListing(roots));
  assert.deepEqual(selected, roots);
});

test("AIO-555: a forged origin/main or skip-worktree cannot drop a target", () => {
  // Selection consults no ref, no upstream, and no `git status`, so the writes that emptied the
  // target list in the first revision have nothing to act on: only `worktree list` is read.
  const roots = [PRIMARY_ROOT, DIRTY_ROOT];
  const gitFn = (args) => {
    assert.deepEqual(args, ["worktree", "list", "--porcelain", "-z"]);
    return nulListing(roots);
  };
  assert.deepEqual(listGateTargets(PRIMARY_ROOT, gitFn), roots);
});

test("AIO-555: a stale worktree registration is skipped, not fatal", () => {
  const missing = path.join(tmpdir(), "aios-bugbot-does-not-exist-555");
  rmSync(missing, { recursive: true, force: true });
  const selected = listGateTargets(PRIMARY_ROOT, () => nulListing([missing, DIRTY_ROOT]));
  assert.deepEqual(selected, [DIRTY_ROOT]);
});

test("AIO-555: a worktree path containing a newline survives NUL parsing", () => {
  // `git worktree list --porcelain` does not quote paths; without -z this path would split into
  // two bogus entries and the real worktree would be silently skipped.
  const weird = path.join(REPO, "scripts");
  const listing = `worktree ${weird}\0HEAD abc\0worktree ${PUSHED_ROOT}\0`;
  assert.deepEqual(
    listGateTargets(PRIMARY_ROOT, () => listing),
    [weird, PUSHED_ROOT]
  );
});

test("AIO-555: aggregation is fail-closed — one block outweighs a clear", () => {
  const merged = aggregateGateResults([
    { status: "clear", verified: true, worktree: "/wt/a" },
    {
      status: "blocked",
      cached: false,
      fingerprint: "f1",
      output: "High: boom",
      worktree: "/wt/b",
    },
  ]);
  assert.equal(merged.status, "blocked");
  assert.deepEqual(merged.worktrees, ["/wt/b"]);
  assert.match(merged.output, /\/wt\/b/);
  assert.match(merged.output, /High: boom/);
});

test("AIO-555: an error outweighs a clear but not a block", () => {
  assert.equal(
    aggregateGateResults([
      { status: "clear", verified: true, worktree: "/wt/a" },
      { status: "error", reason: "review died", worktree: "/wt/b" },
    ]).status,
    "error"
  );
  assert.equal(
    aggregateGateResults([
      { status: "error", reason: "review died", worktree: "/wt/a" },
      { status: "blocked", cached: false, output: "High", worktree: "/wt/b" },
    ]).status,
    "blocked"
  );
});

test("AIO-555: an unrecognised status is an error, never a clear", () => {
  const merged = aggregateGateResults([{ status: "weird", worktree: "/wt/a" }]);
  assert.equal(merged.status, "error");
  assert.match(merged.reason, /refusing to treat as clear/);
});

test("AIO-555: a clear that is not verified is an error, never a clear", () => {
  const merged = aggregateGateResults([
    { status: "clear", verified: true, worktree: "/wt/a" },
    { status: "clear", verified: false, worktree: "/wt/b" },
  ]);
  assert.equal(merged.status, "error");
  assert.match(merged.reason, /\/wt\/b/);
});

test("AIO-555: an all-verified-clear sweep clears", () => {
  const merged = aggregateGateResults([
    { status: "clear", verified: true, worktree: "/wt/a" },
    { status: "skipped", reason: "no changes against Bugbot base", worktree: "/wt/b" },
  ]);
  assert.equal(merged.status, "clear");
  assert.equal(merged.verified, true);
});

test("AIO-555: no target reviewed is skipped, not a positive clear", () => {
  const empty = aggregateGateResults([]);
  assert.notEqual(empty.status, "clear");
  assert.equal(empty.status, "skipped");
});

test("AIO-555: a probe aggregates to a probe and keeps a fingerprint for dedup", () => {
  const merged = aggregateGateResults([
    { status: "probe", fingerprint: "aaa", worktree: "/wt/a" },
    { status: "probe", fingerprint: "bbb", worktree: "/wt/b" },
  ]);
  assert.equal(merged.status, "probe");
  assert.match(merged.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(merged.fingerprints.length, 2);
});

/**
 * AIO-564 — a cached blocked verdict must keep its evidence.
 *
 * Regression from AIO-555: the aggregate read only `output`, but cachedResult puts the explanation
 * in `reason`. Every Stop after the first on an unchanged diff therefore rendered a worktree path
 * and nothing else, which reads as a broken gate rather than a real finding.
 */

test("AIO-564: a cached block renders its reason, not an empty entry", () => {
  const merged = aggregateGateResults([
    { status: "blocked", cached: true, fingerprint: "f", reason: "R-CACHED", worktree: "/wt/a" },
  ]);
  assert.equal(merged.status, "blocked");
  assert.match(merged.output, /\/wt\/a/);
  assert.match(merged.output, /R-CACHED/);
  // The exact live failure: evidence that is nothing but a bracketed worktree path.
  assert.notEqual(merged.output.replace(/\[[^\]]*\]/g, "").trim(), "");
});

test("AIO-564: a mixed cached + fresh sweep renders both bodies, each attributed", () => {
  const merged = aggregateGateResults([
    { status: "blocked", cached: true, reason: "R-CACHED", worktree: "/wt/a" },
    { status: "blocked", cached: false, output: "High: fresh finding", worktree: "/wt/b" },
  ]);
  for (const fragment of ["/wt/a", "R-CACHED", "/wt/b", "High: fresh finding"]) {
    assert.match(merged.output, new RegExp(fragment.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")));
  }
  assert.equal(merged.cached, false, "a sweep containing a fresh block is not wholly cached");
});

test("AIO-564: a block with neither output nor reason still names the worktree and a next step", () => {
  const merged = aggregateGateResults([{ status: "blocked", worktree: "/wt/a" }]);
  assert.match(merged.output, /\/wt\/a/);
  assert.match(merged.output, /manual review/);
});

test("AIO-564: the review-mode result carries the finding text, not just worktree paths", () => {
  const merged = aggregateGateResults([
    { status: "blocked", cached: true, reason: "R-CACHED", worktree: "/wt/a" },
  ]);
  // Consumed raw by --json/--check-exit callers (the Stop path never renders a block).
  assert.equal(merged.status, "blocked");
  assert.match(merged.output, /R-CACHED/);
});

test("AIO-564: an errored worktree keeps its reason in the aggregated output too", () => {
  const merged = aggregateGateResults([
    { status: "error", reason: "review died", worktree: "/wt/a" },
  ]);
  assert.equal(merged.status, "error");
  assert.match(merged.output, /\/wt\/a/);
  assert.match(merged.output, /review died/);
});
