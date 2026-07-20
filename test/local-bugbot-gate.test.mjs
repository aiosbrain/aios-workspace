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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateLocalBugbotGate as evaluateProductionGate,
  formatHookResult,
} from "../hooks/local-bugbot-gate.mjs";
import {
  BUGBOT_BLOCKED_MARKER,
  BUGBOT_CLEAR_MARKER,
  BUGBOT_CLEAR_TOKEN,
  captureBranchDiff,
  hasFindingsAtOrAbove,
  REQUIRED_BUGBOT_MODEL,
  resolveRequiredBugbotBase,
  retryReviewTimeoutOnce,
  runLocalSecretsPreflight,
  runLocalPrePrReview,
  runLocalBugbotReview,
  trustedReviewerEnv,
} from "../scripts/review-bugbot.mjs";
import {
  enqueueContinuation,
  hardenedGateEnv,
  isDuplicateIdleResult,
} from "../.opencode/plugins/aios-bugbot.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const VERIFIED_CLEAR_OUTPUT = `${BUGBOT_CLEAR_MARKER}\n${BUGBOT_CLEAR_TOKEN}`;

function evaluateLocalBugbotGate(options = {}) {
  return evaluateProductionGate({
    ...options,
    resolveBase:
      options.resolveBase ??
      ((repo) => ({ ok: true, baseSha: git(repo, "merge-base", "HEAD", "origin/main") })),
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

test("Medium+ matcher is strict while Low remains advisory", async () => {
  assert.equal(hasFindingsAtOrAbove("- Medium: stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("1. [Medium] stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("Medium — stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("Medium - stale status", "medium"), true);
  assert.equal(hasFindingsAtOrAbove("**[Medium]** scripts/x.mjs:1 — stale", "medium"), true);
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
    assert.equal(calls.length, 2);
    assert.match(review.output, /review protocol error/);
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

test("runtime adapters return native blocked result shapes", () => {
  const failure = { status: "blocked", output: "- Medium: bug" };
  assert.match(formatHookResult("claude", failure).reason, /completion.*blocked/i);
  assert.match(formatHookResult("cursor", failure).followup_message, /completion.*blocked/i);
  assert.equal(formatHookResult("codex", failure).continue, false);
  assert.equal(formatHookResult("opencode", failure).status, "blocked");
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

test("OpenCode duplicate-idle suppression requires a verified unchanged clear", () => {
  const previous = {
    completedAt: 1_000,
    fingerprint: "old",
    status: "clear",
    verified: true,
  };
  assert.equal(
    isDuplicateIdleResult(previous, { fingerprint: "old", status: "probe" }, 2_000),
    true
  );
  assert.equal(
    isDuplicateIdleResult(
      { ...previous, verified: false },
      { fingerprint: "old", status: "probe" },
      2_000
    ),
    false,
    "an unverified clear must never suppress the full gate"
  );
  assert.equal(
    isDuplicateIdleResult(
      { ...previous, status: "blocked" },
      { fingerprint: "old", status: "probe" },
      2_000
    ),
    false,
    "a blocked continuation must retry even when the fingerprint is unchanged"
  );
  assert.equal(
    isDuplicateIdleResult(
      { ...previous, status: "error" },
      { fingerprint: "old", status: "probe" },
      2_000
    ),
    false,
    "an infrastructure failure must retry even when the fingerprint is unchanged"
  );
  assert.equal(
    isDuplicateIdleResult(previous, { fingerprint: "new", status: "probe" }, 2_000),
    false,
    "a changed worktree must rerun even inside the duplicate event window"
  );
  assert.equal(
    isDuplicateIdleResult(previous, { fingerprint: "old", status: "probe" }, 4_000),
    false
  );
});

test("OpenCode continuation awaits asynchronous enqueue acknowledgement", async () => {
  let request;
  const accepted = await enqueueContinuation(
    {
      session: {
        promptAsync: async (input) => {
          request = input;
          return { data: undefined };
        },
      },
    },
    "session-1",
    "fix Bugbot"
  );
  assert.deepEqual(accepted, { data: undefined });
  assert.deepEqual(request, {
    path: { id: "session-1" },
    body: { parts: [{ type: "text", text: "fix Bugbot" }] },
  });
  await assert.rejects(
    enqueueContinuation(
      { session: { promptAsync: async () => ({ error: { message: "not delivered" } }) } },
      "session-1",
      "fix Bugbot"
    ),
    /not delivered/
  );
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
        env: process.env,
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
  assert.match(openCode, /lastIdleCompletedAt/);
  assert.match(openCode, /local-bugbot-gate\.mjs/);
  assert.match(openCode, /timeout:\s*GATE_TIMEOUT_MS/);
  assert.match(openCode, /required gate script missing/);
  assert.match(openCode, /env:\s*hardenedGateEnv\(\)/);
  assert.match(hydration, /cp -Rn.*scaffold\/\.opencode/s);

  const gate = readFileSync(path.join(REPO, "hooks", "local-bugbot-gate.mjs"), "utf8");
  const build = readFileSync(path.join(REPO, "scripts", "build.mjs"), "utf8");
  const ship = readFileSync(path.join(REPO, "scripts", "ship.mjs"), "utf8");
  assert.match(gate, /--cursor-timeout/);
  assert.match(gate, /--read-only/);
  assert.match(gate, /--hook-protocol/);
  assert.match(gate, /const model = REQUIRED_BUGBOT_MODEL/);
  assert.match(gate, /reviewTimeoutMs \+ NATIVE_HOOK_GRACE_MS/);
  assert.match(gate, /env\.PATH = "\/usr\/bin:\/bin:/);
  assert.doesNotMatch(build, /AIOS_BUGBOT_MODEL/);
  assert.match(build, /model:\s*REQUIRED_BUGBOT_MODEL/);
  assert.match(ship, /const reviewModel = REQUIRED_BUGBOT_MODEL/);
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
        env: process.env,
      }
    );
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).status, "error");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
