/**
 * review-bugbot.mjs — local Cursor Bugbot review (CLI hook for agents + aios build).
 *
 * Runs code (`/review-bugbot`) and security review passes against the real branch
 * diff, blocking at the configured severity threshold. Use standalone or via
 * `aios build --merge`.
 *
 * AIO-558: this file now ORCHESTRATES a review round on top of four extracted units —
 * the sandboxed provider/trust boundary (`review-bugbot/trusted-env.mjs`), the severity +
 * clear/blocked verdict protocol (`review-bugbot/findings.mjs`), the atomic diff +
 * fingerprint (`review-bugbot/diff-capture.mjs`), and the excluded-path compensating gates
 * (`review-bugbot/lockfile-gate.mjs`). Every symbol those modules used to export directly
 * from this file is re-exported here unchanged, so no consumer (hooks/local-bugbot-gate.mjs,
 * scripts/build.mjs, scripts/ship.mjs, scripts/simplify.mjs,
 * scripts/consolidate-findings.mjs, and the test suite) needs an import-path change. See
 * `docs/v1-operator-loop/domains/safety-unit-extraction.md` for the pattern contract.
 *
 * Exported:
 *   runLocalBugbotReview({ repo, worktree, baseSha, branch, cursorTimeout, skill })
 *   cmdReviewBugbot(repo, args)
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { c, die, callCursorAgent } from "./relay-core.mjs";
import { callPromptModel } from "./model-call.mjs";
import { parseModelRef } from "./model-providers.mjs";
import {
  trustedReviewerEnv,
  gitQuiet,
  resolveRequiredBugbotBase,
  runLocalSecretsPreflight,
  TRUSTED_CURSOR_BIN,
} from "./review-bugbot/trusted-env.mjs";
import {
  canonicalSeverity,
  buildSecurityReviewPrompt,
  buildBugbotPrompt,
  hasFindingsAtOrAbove,
  hasUnstructuredSeverityClaim,
  detectBugbotClear,
  detectBugbotBlocked,
  BUGBOT_CLEAR_TOKEN,
  BUGBOT_BLOCKED_TOKEN,
} from "./review-bugbot/findings.mjs";
import { captureBranchDiff, LOCAL_BUGBOT_DIFF_CAP } from "./review-bugbot/diff-capture.mjs";
import { runExcludedPathGates } from "./review-bugbot/lockfile-gate.mjs";

// Re-exports: the public surface this file has always had is unchanged even though the
// bodies now live in scripts/review-bugbot/*.mjs. See the module header above.
export { trustedReviewerEnv, resolveRequiredBugbotBase, runLocalSecretsPreflight };
export { CANONICAL_BUGBOT_MAIN_URL } from "./review-bugbot/trusted-env.mjs";
export {
  buildSecurityReviewPrompt,
  buildBugbotPrompt,
  hasFindingsAtOrAbove,
  hasUnstructuredSeverityClaim,
  detectBugbotClear,
  detectBugbotBlocked,
  BUGBOT_CLEAR_TOKEN,
  BUGBOT_BLOCKED_TOKEN,
};
export { SEVERITY_RANK, hasCriticalOrHighFindings } from "./review-bugbot/findings.mjs";
export { captureBranchDiff, LOCAL_BUGBOT_DIFF_CAP };
export { UNTRACKED_HASH_SIZE_CAP, PROMPT_EXCLUDED_GLOBS } from "./review-bugbot/diff-capture.mjs";
export { runExcludedPathGates };
export { inspectLockDelta, DEFAULT_LOCK_RESOLVED_HOSTS } from "./review-bugbot/lockfile-gate.mjs";

export const DEFAULT_BUGBOT_SKILL = "/review-bugbot";
export const BUGBOT_CLEAR_MARKER = "AIOS_BUGBOT_RESULT=clear";
export const BUGBOT_BLOCKED_MARKER = "AIOS_BUGBOT_RESULT=blocked";
export const REQUIRED_BUGBOT_FAIL_ON = "medium";
export const REQUIRED_BUGBOT_MODEL = "cursor:composer-2.5";
const CURSOR_REVIEW_FLAGS = ["--force", "--trust"];
const DEFAULT_TIMEOUT = 300;
const CURSOR_RETRIABLE_ATTEMPTS = 2;
const CURSOR_RETRIABLE_BASE_DELAY_MS = 2_000;

/**
 * The ONE wall-clock budget for a whole local review run (both mandatory passes and
 * every nested retry inside them). Before this existed the budget was derived by
 * multiplying the per-attempt timeout by the retry layers, and the AIO-468 protocol
 * re-ask silently doubled the real worst case — so the parent hook SIGTERMed its own
 * child mid-review and produced "Bugbot exited without a status". An absolute deadline
 * cannot be doubled by adding a retry layer: every attempt is clamped against it.
 */
export const REVIEW_WALL_CLOCK_BUDGET_MS = 900_000;

/** Floor a protocol re-ask needs to be worth taking. */
export const MIN_ATTEMPT_MS = 180_000;

/** Headroom added to the security pass's reserved full attempt. */
export const ATTEMPT_RESERVE_MARGIN_MS = 30_000;

/** Real clock + sleeper. Injected in tests so no test ever waits on wall-clock time. */
const REAL_CLOCK = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export async function retryReviewTimeoutOnce(call, timeoutMs, onRetry = () => {}) {
  try {
    return await call(timeoutMs);
  } catch (error) {
    if (!/timed out after/i.test(error?.message ?? "")) throw error;
    const retryTimeoutMs = timeoutMs * 2;
    onRetry(retryTimeoutMs, error);
    return call(retryTimeoutMs);
  }
}

// Transient exhaustion the reviewer can recover from on a retry (rate-limit contention when
// several agents run the gate at once). NOT the same as a timeout (handled above): these fail
// fast, so a bounded backoff is cheap against the child-timeout budget.
const RETRIABLE_REVIEW_RE = /resource_exhausted|RetriableError|\b429\b|rate.?limit/i;

/**
 * Retry `call` with bounded exponential backoff, but ONLY on a retriable-exhaustion error —
 * any other failure (including a timeout, which `retryReviewTimeoutOnce` owns) rethrows
 * immediately. Compose this AROUND the timeout retry, not inside it.
 *
 * Budget contract: there is no separately-derived retry budget any more. Every attempt is
 * clamped against the run's absolute `deadlineAt` (REVIEW_WALL_CLOCK_BUDGET_MS), and the
 * backoff sleep below is clamped to — and skipped past — the same deadline, so no retry
 * layer can push the run beyond the deadline the parent hook sized its child kill against.
 */
export async function retryReviewOnRetriable(
  call,
  { attempts = 2, baseDelayMs = 2_000, deadlineAt = Infinity, now = REAL_CLOCK.now, sleep } = {},
  onRetry = () => {}
) {
  const wait = sleep ?? REAL_CLOCK.sleep;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !RETRIABLE_REVIEW_RE.test(error?.message ?? "")) throw error;
      const remainingMs = deadlineAt - now();
      if (remainingMs <= 0) throw error;
      const delayMs = Math.min(baseDelayMs * 2 ** (attempt - 1), remainingMs);
      onRetry(attempt, delayMs, error);
      await wait(delayMs);
    }
  }
  throw lastError;
}

async function runReviewPrompt({
  label,
  prompt,
  worktree,
  timeoutMs,
  model = "deepseek-v4-pro",
  readOnly = false,
  deadlineAt = Infinity,
  now = REAL_CLOCK.now,
  sleep = REAL_CLOCK.sleep,
}) {
  const ref = parseModelRef(model);
  // Every attempt — first try, doubled timeout retry, exhaustion retry — is clamped to
  // what is left of the absolute deadline. This is what makes the retry layers additive
  // to a FIXED ceiling instead of multiplicative.
  const attemptBudgetMs = (requestedMs) => {
    const budgetMs = Math.min(requestedMs, deadlineAt - now());
    if (budgetMs <= 0) {
      throw new Error(`local review wall-clock budget exhausted before the ${label} attempt`);
    }
    return budgetMs;
  };
  // Read-only review needs only the supplied diff. Every provider runs outside the
  // checkout so project config and lifecycle hooks cannot mutate or recurse.
  const reviewCwd = readOnly ? mkdtempSync(path.join(tmpdir(), "aios-bugbot-review-")) : worktree;
  try {
    if (ref.provider === "cursor") {
      if (!TRUSTED_CURSOR_BIN) die("trusted Cursor CLI binary not found");
      console.log(c.dim(`[cursor] ${label} (${model})...`));
      const invoke = (attemptTimeoutMs) =>
        callCursorAgent(prompt, attemptBudgetMs(attemptTimeoutMs), {
          cwd: reviewCwd,
          bin: TRUSTED_CURSOR_BIN,
          env: trustedReviewerEnv(),
          // Cursor may stream progress narration before its terminal result event. Keep
          // both: the transcript is scanned for findings and the terminal payload must
          // independently satisfy the exact machine-verdict protocol.
          resultEventBundle: true,
          extraArgs: [
            ...CURSOR_REVIEW_FLAGS,
            ...(readOnly ? ["--mode", "ask"] : []),
            ...(ref.modelId ? ["--model", ref.modelId] : []),
          ],
        });
      return await retryReviewOnRetriable(
        () =>
          retryReviewTimeoutOnce(invoke, timeoutMs, (retryTimeoutMs) => {
            console.warn(
              c.yellow(
                `[cursor] ${label} timed out after ${timeoutMs / 1000}s; retrying once with ${retryTimeoutMs / 1000}s`
              )
            );
          }),
        {
          attempts: CURSOR_RETRIABLE_ATTEMPTS,
          baseDelayMs: CURSOR_RETRIABLE_BASE_DELAY_MS,
          deadlineAt,
          now,
          sleep,
        },
        (attempt, delayMs) => {
          console.warn(
            c.yellow(
              `[cursor] ${label} hit transient exhaustion (attempt ${attempt}); backing off ${delayMs / 1000}s before retry`
            )
          );
        }
      );
    }
    console.log(c.dim(`[${ref.provider}] ${label} (${model})...`));
    return await callPromptModel({
      model,
      prompt,
      timeoutMs: attemptBudgetMs(timeoutMs),
      opts: { cwd: reviewCwd },
    });
  } finally {
    if (readOnly) rmSync(reviewCwd, { recursive: true, force: true });
  }
}

/** Pre-PR local pass: code (/review-bugbot persona) + security, via DeepSeek when keyed. */
export async function runLocalPrePrReview({
  worktree,
  baseSha,
  branch,
  timeoutMs = DEFAULT_TIMEOUT * 1000,
  model = REQUIRED_BUGBOT_MODEL,
  reviewPrompt = runReviewPrompt,
  failOn = REQUIRED_BUGBOT_FAIL_ON,
  includeWorktree = true,
  readOnly = true,
  skill = DEFAULT_BUGBOT_SKILL,
  secretsPreflight = runLocalSecretsPreflight,
  excludeFromPrompt = false,
  excludedPathGates = runExcludedPathGates,
  wallClockBudgetMs = REVIEW_WALL_CLOCK_BUDGET_MS,
  now = REAL_CLOCK.now,
  sleep = REAL_CLOCK.sleep,
}) {
  if (!worktree || !existsSync(worktree)) {
    return { ok: true, skipped: true, output: "(worktree missing — pre-PR review skipped)" };
  }
  if (!baseSha) die("baseSha required for pre-PR review");

  const secrets = secretsPreflight(worktree);
  if (!secrets.ok) {
    return { ok: false, error: true, output: secrets.reason };
  }

  const promptOnly = parseModelRef(model).provider !== "cursor" || readOnly;
  const {
    diffStat,
    logOneline,
    reviewDiff,
    reviewTooLarge,
    withheldUntrackedFiles,
    suppressedTrackedFiles,
    fingerprint,
    excluded,
    changedFiles,
  } = captureBranchDiff(worktree, baseSha, { includeWorktree, excludeFromPrompt });
  if (suppressedTrackedFiles.length) {
    return {
      ok: false,
      error: true,
      output: `refusing full-worktree review while tracked paths use skip-worktree/assume-unchanged: ${suppressedTrackedFiles.join(", ")}`,
    };
  }
  if (withheldUntrackedFiles.length) {
    return {
      ok: false,
      error: true,
      output: `refusing to send untracked content to Bugbot; stage the files you intend to have reviewed, or gitignore them if they are machine-local (build output, runtime/session state): ${withheldUntrackedFiles.join(", ")}`,
    };
  }
  if (reviewTooLarge) {
    return {
      ok: false,
      error: true,
      output: `changeset exceeds the ${LOCAL_BUGBOT_DIFF_CAP}-character local Bugbot limit; split the changeset so code and security reviewers can inspect it atomically`,
    };
  }
  if (!diffStat && !logOneline) {
    return { ok: true, output: "(no diff to review)" };
  }
  // Compensating gates are preconditions, not review work: they run BEFORE the clock starts
  // so their (separately bounded) cost is never charged to the reviewer's budget.
  let disclosed = excluded;
  if (excluded.length) {
    const gates = excludedPathGates(worktree, excluded, changedFiles, { baseSha });
    if (!gates.ok) {
      return {
        ok: false,
        error: true,
        output: `compensating gate failed for a path excluded from the review prompt: ${gates.reason}`,
      };
    }
    disclosed = excluded.map((file) => ({ ...file, summary: gates.summaries?.[file.path] ?? [] }));
  }

  // ONE absolute deadline for the whole review, computed once. Everything below — each
  // attempt, each retry, each backoff, the protocol re-ask, and the second pass —
  // is scheduled against it, so the run cannot outlive the parent hook's child kill.
  const deadlineAt = now() + wallClockBudgetMs;
  if (wallClockBudgetMs < 2 * MIN_ATTEMPT_MS) {
    return {
      ok: false,
      error: true,
      output: `review budget too small for two passes: ${wallClockBudgetMs}ms cannot fund the mandatory code and security passes (${2 * MIN_ATTEMPT_MS}ms minimum)`,
    };
  }
  // Reserve a FULL attempt (plus margin) for the mandatory security pass. Reserving less
  // than one attempt only guarantees that pass starts, which turns a slow-but-healthy run
  // into a false block on the security pass specifically. Clamped to half the budget: a
  // caller-supplied timeout at or above the budget would otherwise leave the code pass a
  // non-positive allowance, and `attemptBudgetMs` would THROW — a crash-shaped block
  // instead of a legible fail-closed verdict.
  const securityReserveMs = Math.min(
    timeoutMs + ATTEMPT_RESERVE_MARGIN_MS,
    Math.floor(wallClockBudgetMs / 2)
  );

  const runPass = async (label, makePrompt, passDeadlineAt) => {
    const classify = (response) => {
      const bundled =
        response && typeof response === "object" && !Array.isArray(response)
          ? {
              transcript: String(response.transcript ?? ""),
              terminals: [response.result, response.eventResult]
                .filter((value) => value != null)
                .map(String),
            }
          : { transcript: String(response ?? ""), terminals: [String(response ?? "")] };
      const evidence = [bundled.transcript, ...bundled.terminals]
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join("\n\n--- terminal result ---\n\n");
      // Findings FIRST: streamed or terminal Medium+ evidence blocks even if another terminal
      // shape says clear. Only the exact terminal protocol can clear an otherwise clean pass.
      const finding =
        detectBugbotBlocked(bundled.transcript) ||
        bundled.terminals.some(detectBugbotBlocked) ||
        hasFindingsAtOrAbove(evidence, failOn) ||
        hasUnstructuredSeverityClaim(evidence, failOn);
      const error = !finding && !bundled.terminals.some(detectBugbotClear);
      return {
        finding,
        error,
        output: finding || error ? evidence : BUGBOT_CLEAR_TOKEN,
      };
    };
    const once = async () => {
      const response = await reviewPrompt({
        label,
        prompt: makePrompt(reviewDiff),
        worktree,
        timeoutMs: Math.min(timeoutMs, Math.max(0, passDeadlineAt - now())),
        model,
        readOnly,
        deadlineAt: passDeadlineAt,
        now,
        sleep,
      });
      return classify(response);
    };

    let pass = await once();
    // Retry ONCE on a protocol error only — NEVER on a finding. This is the fix for
    // AIO-468, and it is deliberately at the caller rather than in `detectBugbotClear`:
    // a protocol error is the ABSENCE of a readable verdict, so re-asking is not a second
    // chance to pass. A real finding is captured by `finding` and short-circuits here
    // untouched — re-asking after a finding WOULD be a bypass, and must never be added.
    // Same precedent as `retryReviewTimeoutOnce` above. Without this, one malformed
    // response hard-blocks a merge (observed ~3 runs in 6), which pressures operators
    // toward bypassing the one gate that must never be bypassed.
    // …and only when the remaining budget can still fund a real attempt. A re-ask costs a
    // full attempt; taking one on an empty budget is how the run used to overrun its
    // deadline and get SIGTERMed with no verdict at all.
    let budgetNote = "";
    if (pass.error && passDeadlineAt - now() > MIN_ATTEMPT_MS) {
      process.stderr.write(
        `[local-bugbot] ${label}: unreadable verdict — re-asking once (protocol error, not a finding)\n`
      );
      pass = await once();
    } else if (pass.error) {
      budgetNote = "\n\n(insufficient review budget for protocol retry)";
    }
    return {
      ok: !pass.finding && !pass.error,
      finding: pass.finding,
      error: pass.error,
      output: pass.error
        ? `${pass.output}\n\n(review protocol error in the ${label} pass: expected terminal result to be exactly ${BUGBOT_CLEAR_TOKEN}, ${BUGBOT_BLOCKED_TOKEN}, or a structured finding)${budgetNote}`
        : pass.output,
    };
  };

  const shared = { branch, baseSha, diffStat, logOneline, failOn, excluded: disclosed };
  // Both passes are mandatory, and they run SEQUENTIALLY. Running them concurrently on the
  // same reviewer account manufactured `resource_exhausted` against itself, burning the
  // retry budget on self-inflicted contention. The first pass may spend at most the budget
  // minus MIN_ATTEMPT_MS, so the mandatory security pass always gets a real attempt.
  const code = await runPass(
    "pre-PR code review",
    (diff) => buildBugbotPrompt({ skill, promptOnly, diff, ...shared }),
    deadlineAt - securityReserveMs
  );
  if (deadlineAt - now() <= 0) {
    return {
      ok: false,
      finding: code.finding,
      error: !code.finding,
      output: `${code.output}\n\n--- security pass ---\n\n(deadline exhausted before security pass)`,
      reason: "deadline exhausted before security pass",
      pass: "security",
    };
  }
  const security = await runPass(
    "pre-PR security review",
    (diff) => buildSecurityReviewPrompt({ diff, promptOnly, ...shared }),
    deadlineAt
  );
  const current = captureBranchDiff(worktree, baseSha, { includeWorktree, excludeFromPrompt });
  if (current.suppressedTrackedFiles.length) {
    return {
      ok: false,
      error: true,
      output: `tracked paths gained skip-worktree/assume-unchanged while Bugbot was reviewing: ${current.suppressedTrackedFiles.join(", ")}`,
    };
  }
  if (current.fingerprint !== fingerprint) {
    return {
      ok: false,
      error: true,
      output: "worktree changed while Bugbot was reviewing; run a fresh review before completing",
    };
  }
  const finding = code.finding || security.finding;
  return {
    ok: code.ok && security.ok,
    // A concrete Medium+ finding is already a deterministic block even when the
    // sibling pass also suffers an infrastructure error. Preserve that evidence as
    // the primary verdict; pure infrastructure failures remain errors.
    finding,
    error: !finding && (code.error || security.error),
    output: [code.output, security.output].join("\n\n--- security pass ---\n\n"),
    pass: !code.ok ? "code" : !security.ok ? "security" : "both",
  };
}

export async function runLocalBugbotReview({
  worktree,
  baseSha,
  branch,
  cursorTimeout = DEFAULT_TIMEOUT * 1000,
  skill = DEFAULT_BUGBOT_SKILL,
  model = REQUIRED_BUGBOT_MODEL,
  reviewPrompt = runReviewPrompt,
  failOn = REQUIRED_BUGBOT_FAIL_ON,
  includeWorktree = false,
  readOnly = false,
  secretsPreflight = runLocalSecretsPreflight,
  excludeFromPrompt = false,
}) {
  if (!worktree || !existsSync(worktree)) die("worktree path missing for Bugbot review");
  if (!baseSha) die("baseSha required for Bugbot review");
  return runLocalPrePrReview({
    worktree,
    baseSha,
    branch,
    timeoutMs: cursorTimeout,
    model,
    reviewPrompt,
    failOn,
    includeWorktree,
    readOnly,
    skill,
    secretsPreflight,
    excludeFromPrompt,
  });
}

export async function cmdReviewBugbot(repo, args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      [
        "",
        c.blue("aios review-bugbot — local code + security review on branch changes"),
        "",
        "usage:",
        "  aios review-bugbot [branch] [options]",
        "",
        "options:",
        "  --base <ref>            explicit diff base (default: verified canonical main)",
        "  --worktree <path>       worktree to review (default: existing or ../<repo>-<branch>)",
        "  --cursor-timeout N      seconds per review call (default: 300)",
        "  --skill /name           default: /review-bugbot",
        `  --model provider:model  reviewer model (default: ${REQUIRED_BUGBOT_MODEL})`,
        `  --fail-on severity      threshold (default: ${REQUIRED_BUGBOT_FAIL_ON})`,
        "  --include-worktree      include staged, unstaged, and untracked changes",
        "  --read-only             review supplied diff without running commands",
        "  --exclude-generated     lifecycle-hook mode: keep lockfile/dist content out of the",
        "                          prompt (still fingerprinted + verified by compensating gates)",
        "",
        "Requires a checked-out worktree for the branch. Exits 0 on BUGBOT_CLEAR / no blockers.",
      ].join("\n")
    );
    return;
  }

  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const positional = args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      !["--base", "--worktree", "--cursor-timeout", "--skill", "--model", "--fail-on"].includes(
        args[i - 1]
      )
  );
  const branch = positional[0];
  if (!branch) die("branch name required");

  const worktreePath =
    flag("--worktree") ??
    path.resolve(
      repo,
      "..",
      `${path.basename(repo)}-${branch.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`
    );

  if (!existsSync(worktreePath)) {
    die(`worktree not found: ${worktreePath} — run aios build first or pass --worktree`);
  }

  const explicitBase = flag("--base");
  let baseSha;
  if (explicitBase) {
    baseSha = gitQuiet(["rev-parse", explicitBase], worktreePath) || explicitBase;
  } else {
    const verifiedBase = resolveRequiredBugbotBase(worktreePath);
    if (!verifiedBase.ok) die(verifiedBase.reason);
    baseSha = verifiedBase.baseSha;
  }

  const timeout = parseInt(flag("--cursor-timeout") ?? String(DEFAULT_TIMEOUT), 10) * 1000;
  const skill = flag("--skill") ?? DEFAULT_BUGBOT_SKILL;
  const model = flag("--model") ?? REQUIRED_BUGBOT_MODEL;
  const failOn = flag("--fail-on") ?? REQUIRED_BUGBOT_FAIL_ON;
  if (!canonicalSeverity(failOn)) {
    die("--fail-on must be one of: critical, high, medium, low");
  }

  const {
    ok,
    output,
    error: reviewError,
  } = await runLocalBugbotReview({
    repo,
    worktree: worktreePath,
    baseSha,
    branch,
    cursorTimeout: timeout,
    skill,
    model,
    failOn,
    includeWorktree: args.includes("--include-worktree"),
    readOnly: args.includes("--read-only"),
    excludeFromPrompt: args.includes("--exclude-generated"),
  });
  if (!ok) {
    if (reviewError) {
      console.error(c.red("\n✗ Bugbot could not complete — merge blocked."));
      console.error(output);
      process.exit(1);
    }
    if (args.includes("--hook-protocol")) console.error(`\n${BUGBOT_BLOCKED_MARKER}`);
    console.error(c.red(`\n✗ Bugbot found ${canonicalSeverity(failOn)}+ issues — merge blocked.`));
    console.error(output);
    process.exit(1);
  }
  // Cursor streams review text without guaranteeing a trailing newline. Prefix the
  // machine marker so the parent can require an exact standalone protocol line.
  if (args.includes("--hook-protocol")) console.log(`\n${BUGBOT_CLEAR_MARKER}`);
  console.log(c.green(`\n✓ ${BUGBOT_CLEAR_TOKEN} — no blocking Bugbot findings.`));
}
