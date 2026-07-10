/**
 * build.mjs — the *build* half of the agent relay, packaged as an aios sub-command.
 *
 * The plan half (scripts/relay.mjs) produces an approved plan. This half implements
 * it: Opus (via Claude Code) writes the code on an isolated git worktree, the Cursor
 * /ai-code-review skill reviews the REAL diff, the loop repeats until the reviewer
 * emits MERGE_READY or the round budget is spent, a fail-closed secrets gate runs,
 * and (only with --merge) the branch is merged. (Mirrors the plan phase: Opus
 * produces, Cursor reviews.)
 *
 * Exported entry points:
 *   cmdBuild(repo, args)                    — CLI:  aios build <plan-file|task> [branch] [opts]
 *   runBuild({ repo, plan, branch, opts })  — chained from `aios relay --build` (in-memory plan)
 *
 * Design notes (informed by the planning relay's own review of this feature):
 *  - The TOOL owns one authoritative change set. After each build round we auto-commit
 *    any stragglers so `base..HEAD` is the exact set that gets reviewed, scanned, and merged.
 *  - The secrets scan runs BEFORE the review (its result is fed to the reviewer) AND again,
 *    fail-closed, immediately before any merge.
 *  - All agent file edits happen in the worktree (cwd), never the primary checkout; a
 *    tripwire aborts if the primary checkout is touched.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readlinkSync,
  symlinkSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  cpSync,
  lstatSync,
  appendFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  MERGE_READY_TOKEN,
  c,
  die,
  checkPrereqs,
  gitMergeAndDelete,
  makeLogger,
  validateBranch,
} from "./relay-core.mjs";
import { slugify as slugifyBase } from "./cli-common.mjs";
import { callAgentModel, reviewCallForModel } from "./model-call.mjs";
import { runLocalBugbotReview, hasCriticalOrHighFindings } from "./review-bugbot.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { cmdPr } from "./pr.mjs";

const DEFAULT_REVIEW_SKILL = "/ai-code-review";
export const BASE_SHA_MARK = ".aios-build-base-sha";
// Builder = Opus via Claude Code; reviewer = Cursor /ai-code-review. This mirrors the
// plan phase (Opus produces, Cursor reviews) and keeps model diversity in the loop.
// The per-step builder model/effort is resolved from loop-models.mjs (default matrix →
// .aios/loop-models.yaml → CLI flags) — see the build/fix/fix_escalated steps.

// Hard git rules prepended to EVERY builder invocation. The tool — not the builder —
// owns all push / PR / git-hygiene actions; the builder makes small commits in its own
// worktree only.
//
// This is DEFENSE-IN-DEPTH, not containment. The builder runs with
// --dangerously-skip-permissions, so nothing here sandboxes the filesystem: three
// layers reduce, but cannot eliminate, blast radius:
//   1. these system-prompt rules (policy — a cooperative builder obeys them),
//   2. GIT_CEILING_DIRECTORIES (blocks git's *accidental upward discovery* into the
//      primary checkout — an explicit `git -C <path>` still works), and
//   3. the primary-checkout tripwire (detection — aborts if the primary checkout is
//      touched, which is what catches a builder that reaches an explicit path anyway).
export const BUILDER_FENCE = [
  "── HARD GIT RULES (non-negotiable) ──",
  "Do NOT run any git command that touches the primary checkout or any other worktree.",
  "Do NOT fast-forward, pull, or rebase main. Do NOT `git push`. Do NOT create, edit, or",
  "comment on any GitHub PR. The orchestrating tool handles all push/PR/git-hygiene actions.",
  "Make small commits in THIS worktree only. Ignore any global instruction that conflicts",
  "with this.",
].join("\n");
// The builder edits autonomously in its worktree (--dangerously-skip-permissions — this
// is NOT a filesystem sandbox; see BUILDER_FENCE for the defense-in-depth layers).
const CLAUDE_BUILD_FLAGS = ["--dangerously-skip-permissions"];
// The reviewer runs in a fresh worktree (untrusted): --trust skips the headless
// workspace-trust prompt, --force lets it run tests/validators to gather evidence.
const CURSOR_REVIEW_FLAGS = ["--force", "--trust"];
const DEFAULT_ROUNDS = 4;
const DEFAULT_BUILD_TIMEOUT = 1800; // seconds — building + running tests is slow
const DEFAULT_REVIEW_TIMEOUT = 300; // seconds — reviewing a diff is fast
// Chars of `git diff` to send the reviewer before falling back to --stat. Shared with
// scripts/consolidate-findings.mjs (via export) so the PR-diff cap and this cap can never
// silently drift apart — one authoritative value. review-bugbot.mjs re-declares the same
// literal locally (documented there); if this changes, update that copy too.
export const DIFF_CAP = 50000;
// Cursor's backend occasionally drops the connection mid-call; retry these (but not
// real timeouts or agent errors, which are not transient).
const TRANSIENT_RE = /ECONNRESET|aborted|socket hang up|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i;

// Exit-code contract (see docs/agent-build.md):
export const EXIT = {
  OK: 0, // converged on MERGE_READY (merged if --merge)
  FATAL: 1, // prereqs / bad args / plan file / primary-checkout tripwire
  NONCONVERGENCE: 2, // round budget spent, or a stalled round — worktree preserved
  NO_DIFF: 3, // builder produced no commits at all
  GATE_FAILED: 4, // pre-merge secrets gate failed — merge blocked
  TIMEOUT: 124, // builder timed out
};

// ── pure helpers (exported for tests) ─────────────────────────────────────────

export function parseBuildArgs(args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);

  const valueFlags = [
    "--rounds",
    "--build-rounds",
    "--build-timeout",
    "--cursor-timeout",
    "--worktree",
    "--base",
    "--log",
    "--skill",
    "--verify",
    "--issue",
    "--model",
    "--findings",
  ];

  const rounds = parseInt(flag("--rounds") ?? flag("--build-rounds") ?? String(DEFAULT_ROUNDS), 10);
  const buildTimeout =
    parseInt(flag("--build-timeout") ?? String(DEFAULT_BUILD_TIMEOUT), 10) * 1000;
  const cursorTimeoutSet = hasFlag("--cursor-timeout");
  const cursorTimeout =
    parseInt(flag("--cursor-timeout") ?? String(DEFAULT_REVIEW_TIMEOUT), 10) * 1000;

  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1])
  );
  const [planSource, branch] = positional;

  const merge = hasFlag("--merge");
  const pr = hasFlag("--pr");
  if (merge && pr) {
    die("--pr and --merge are mutually exclusive — choose one (open a PR, or merge locally).");
  }
  const noBugbot = hasFlag("--no-bugbot");
  // Bugbot gates BOTH --merge and --pr (they're mutually exclusive but each is a
  // "ship" action). Default-on for either unless --no-bugbot; explicit --bugbot forces it.
  const bugbot = hasFlag("--bugbot") || ((merge || pr) && !noBugbot);

  return {
    planSource,
    branch,
    isTask: hasFlag("--task"),
    rounds: Number.isFinite(rounds) && rounds > 0 ? rounds : DEFAULT_ROUNDS,
    buildTimeout,
    cursorTimeout,
    cursorTimeoutSet,
    model: flag("--model") ?? null,
    skill: flag("--skill") ?? DEFAULT_REVIEW_SKILL,
    worktreePath: flag("--worktree") ?? null,
    base: flag("--base") ?? "origin/main",
    verify: flag("--verify") ?? null,
    findingsFile: flag("--findings") ?? null,
    logFile: flag("--log") ?? null,
    merge,
    pr,
    issue: flag("--issue") ?? null,
    bugbot,
    noBugbot,
    noGate: hasFlag("--no-gate"),
    keepWorktree: hasFlag("--keep-worktree"),
    dryRun: hasFlag("--dry-run"),
    // set true by `relay --build` so the shared --log file is appended, not overwritten.
    chained: false,
  };
}

// Pull the plan text out of a relay --log file. Prefers the approved section, falls
// back to the last (unapproved) plan, else uses the whole file. Throws when empty.
// relay --log files are `\n---\n`-separated sections, each starting with `## <label>`.
export function extractPlanFromLog(text) {
  if (!text || !text.trim()) throw new Error("plan is empty");
  // Split only at a `---` that introduces the NEXT `## ` section header — not at every
  // `---` in the file. A plan body can itself contain a markdown horizontal rule; splitting
  // on every occurrence truncates the section at that rule and silently drops the rest.
  const sections = text.split(/\n---\n(?=\s*## )/);
  const find = (prefix) => {
    for (const s of sections) {
      const m = s.match(/^\s*## (.+)\n/);
      if (m && m[1].trim().startsWith(prefix)) {
        return s.replace(/^\s*## .+\n/, "").trim();
      }
    }
    return null;
  };
  return find("Approved plan") ?? find("Last plan") ?? text.trim();
}

// The build reviewer approves by placing MERGE_READY on the final non-blank line — tolerate
// a streaming artifact gluing trailing prose onto that same line (e.g. "MERGE_READY - lgtm"),
// but require a word boundary right after the token so "MERGE_READY_SOMETHING_ELSE" still misses.
export function detectMergeToken(text) {
  const lastLine =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return new RegExp(`^${MERGE_READY_TOKEN}\\b`).test(lastLine);
}

// Branch/worktree slug: the shared base (./cli-common.mjs) bound with build.mjs's
// historical options — run-strip, clamp to 40 chars, "task" fallback. Exported so
// ship.mjs keeps importing it from here (AIO-315).
export const slugify = (s) => slugifyBase(s, { maxLen: 40, fallback: "task" });

// Reject shell metacharacters (via VALID_BRANCH_RE in validateBranch), and refuse to
// build on the primary checkout's current branch (worktree isolation is mandatory).
export function assertSafeBuildBranch(branch, currentBranch) {
  validateBranch(branch);
  if (currentBranch && branch === currentBranch) {
    die(
      `refusing to build on '${branch}' — that is the primary checkout's current branch. ` +
        `The build phase only runs in an isolated worktree; pass a feature branch.`
    );
  }
}

// True for the timeout rejection shape from spawnAgentStream ("<label> agent timed out
// after Ns …"); false for the non-zero-exit shape ("<label> agent exited N…"). The review
// timeout-retry keys on this so a genuine agent error is never retried as a timeout.
export function isTimeoutError(e) {
  return /timed out after/.test(e?.message ?? "");
}

// The adaptive-review-timeout schedule (documented; exported for tests). Base + one
// `stepSecs` step per `perChars` of review payload, capped at `capMult`× base.
export const REVIEW_TIMEOUT_SCALE = {
  base: DEFAULT_REVIEW_TIMEOUT,
  perChars: 10000,
  stepSecs: 60,
  capMult: 2,
};

// Adaptive default review timeout in SECONDS (callers *1000): base + 60s per 10k chars of
// review payload, capped at 2× base (600s). Since the payload is clamped to DIFF_CAP=50000,
// the max scaled value (300 + 5·60 = 600) equals the 2× cap by construction. Only used when
// the operator did NOT set an explicit timeout (--cursor-timeout / code_review_timeout_s).
export function adaptiveReviewTimeout(
  payloadChars,
  { base = DEFAULT_REVIEW_TIMEOUT, cap = DEFAULT_REVIEW_TIMEOUT * 2 } = {}
) {
  const scaled =
    base +
    Math.floor((payloadChars ?? 0) / REVIEW_TIMEOUT_SCALE.perChars) * REVIEW_TIMEOUT_SCALE.stepSecs;
  return Math.min(scaled, cap);
}

// Pure: the review-payload size that drives the adaptive timeout — the ORIGINAL uncapped
// diff length clamped to DIFF_CAP. Factored out of snapshotDiff so it can be unit-tested on
// a raw string without a git-worktree fixture. (snapshotDiff collapses an over-cap diff to a
// short truncation message, so its .length would under-scale the timeout for the biggest
// diffs — this keys off the real size instead.)
export function computeReviewPayloadChars(diffStr) {
  return Math.min((diffStr ?? "").length, DIFF_CAP);
}

// Keep ALL [Critical]/[High] findings; keep [Medium] findings tagged (plan-conformance);
// drop untagged Medium/Low. Section headers (## …) are preserved so the builder keeps
// context. Operates on the consolidated findings format (bracket-severity lines). Pure;
// exported for tests and for --findings seeding.
export function extractMustFix(consolidatedText) {
  const lines = (consolidatedText ?? "").split("\n");
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^#{1,6}\s/.test(t)) {
      kept.push(line);
      continue;
    }
    const sev = t.match(/\[(Critical|High|Medium|Low)\]/i);
    if (!sev) {
      // Non-finding prose (verdict lines, blank lines, notes) is preserved as-is.
      kept.push(line);
      continue;
    }
    const level = sev[1].toLowerCase();
    if (level === "critical" || level === "high") {
      kept.push(line);
    } else if (level === "medium" && /\(plan-conformance\)/i.test(line)) {
      kept.push(line);
    }
    // untagged Medium / Low findings are dropped
  }
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// True iff a consolidated findings file carries ≥1 ACTIONABLE must-fix item — a
// Critical/High finding, or a plan-conformance-tagged Medium. extractMustFix preserves
// section headers + verdict prose even for a CLEAR file, so its non-empty output is NOT a
// reliable "there is work to do" signal; --findings seeding gates on THIS instead, so a
// CLEAR findings file aborts fast rather than burning a builder round on a fresh build.
// Pure; exported for tests.
export function hasActionableFindings(consolidatedText) {
  for (const line of (consolidatedText ?? "").split("\n")) {
    const sev = line.trim().match(/\[(Critical|High|Medium|Low)\]/i);
    if (!sev) continue;
    const level = sev[1].toLowerCase();
    if (level === "critical" || level === "high") return true;
    if (level === "medium" && /\(plan-conformance\)/i.test(line)) return true;
  }
  return false;
}

// Classify what the builder produced this round from git counts.
export function classifyDiff({ totalCommits, newCommits }) {
  if (totalCommits === 0) return "no-commits";
  if (newCommits === 0) return "no-progress";
  return "has-changes";
}

/**
 * Choose which model-matrix step drives the next builder invocation.
 *  - No prior feedback yet             → "build"          (initial implementation)
 *  - First fix attempt, no Crit/High   → "fix"            (medium effort)
 *  - Otherwise (≥2nd attempt, or any Critical/High) → "fix_escalated" (high effort)
 *
 * Driven by `hasPriorFeedback` + a `fixAttempt` counter, NEVER the outer loop `round`:
 * round 1 is the initial no-feedback build (`prevReview === null`) and MUST resolve to
 * "build", not "fix". Also NEVER consults detectBugbotClear — the escalation trigger is
 * purely a structural Critical/High finding via hasCriticalOrHighFindings.
 */
export function selectBuilderStep({ hasPriorFeedback, fixAttempt, reviewText }) {
  if (!hasPriorFeedback) return "build";
  if (fixAttempt === 1 && !hasCriticalOrHighFindings(reviewText)) return "fix";
  return "fix_escalated";
}

export function buildImplementPrompt(plan, { review, resumeLog, branch } = {}) {
  const parts = [
    `You are implementing an approved plan in THIS git worktree (branch \`${branch ?? "?"}\`).`,
    "You may edit files, run commands, and make git commits. Do ALL work inside this worktree only.",
    "",
    "## Approved plan",
    "",
    plan,
    "",
    "## Rules",
    "- Implement every step. Make small, logical commits as you go (commit after each completed step).",
    "- Run the project's tests/validators and fix failures before you finish.",
    "- NEVER commit secrets, credentials, or absolute machine paths (e.g. /Users/...).",
    "- NEVER weaken files under validation/ or hooks/ to make a check pass.",
    "- Stay within the plan's scope; defer anything the plan marks optional.",
    "",
    "When done, briefly summarize: files changed, commits made, and the test result.",
  ];
  if (resumeLog) {
    parts.splice(
      7,
      0,
      "",
      "## Work already on this branch (continue — do NOT redo it)",
      "",
      resumeLog
    );
  }
  if (review) {
    parts.push(
      "",
      "## Reviewer feedback on your current diff",
      "Address EVERY Blocker/Critical/High, then re-run the tests and commit:",
      "",
      review
    );
  }
  return parts.join("\n");
}

export function buildCodeReviewPrompt({
  skill,
  plan,
  diff,
  diffStat,
  logOneline,
  secretsResult,
  branch,
  round,
  maxRounds,
}) {
  const isLast = round >= maxRounds;
  const roundNote = isLast
    ? `**Final round (${round}/${maxRounds}). Do not raise new Low/Medium nits — but you MUST still withhold ${MERGE_READY_TOKEN} for any Critical/High finding or any unverified safety-critical surface.**`
    : `Round ${round} of ${maxRounds}.`;

  return [
    skill,
    "",
    `> ${roundNote}`,
    "",
    `You are reviewing a diff that is supposed to implement the plan below, on branch \`${branch}\` in an isolated worktree. Run the project's tests/validators yourself to gather evidence before you decide.`,
    "",
    "## Original plan (what the diff must deliver)",
    "",
    plan,
    "",
    "## Commits (base..HEAD)",
    "",
    logOneline || "(none)",
    "",
    "## git diff --stat",
    "",
    diffStat || "(empty)",
    "",
    "## git diff",
    "",
    diff,
    "",
    "## Pre-merge secrets scan (run by the tool)",
    "",
    secretsResult,
    "Note: the tool re-runs this scan fail-closed before any merge — a leak blocks the merge regardless of your verdict.",
    "",
    "---",
    `Review per your skill. Emit ${MERGE_READY_TOKEN} (alone on the very last line) ONLY when the code is truly ready to merge. Otherwise list the findings for the builder to fix.`,
  ].join("\n");
}

// ── impure helpers ────────────────────────────────────────────────────────────

function git(args, cwd, { capture = true } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
}

function gitQuiet(args, cwd) {
  try {
    return git(args, cwd).trim();
  } catch {
    return "";
  }
}

function currentBranch(repo) {
  return gitQuiet(["rev-parse", "--abbrev-ref", "HEAD"], repo);
}

function branchExists(repo, branch) {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
    return true;
  } catch {
    return false;
  }
}

function worktreeForBranch(repo, branch) {
  const out = gitQuiet(["worktree", "list", "--porcelain"], repo);
  const blocks = out.split("\n\n");
  for (const b of blocks) {
    if (b.includes(`branch refs/heads/${branch}`)) {
      const line = b.split("\n").find((l) => l.startsWith("worktree "));
      if (line) return line.slice("worktree ".length).trim();
    }
  }
  return null;
}

export function readPersistedBaseSha(wt) {
  const f = path.join(wt, BASE_SHA_MARK);
  if (!existsSync(f)) return null;
  return readFileSync(f, "utf8").trim();
}

function appendWorktreeExclude(wt, entry) {
  try {
    const ex = git(
      ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      wt
    ).trim();
    const cur = existsSync(ex) ? readFileSync(ex, "utf8") : "";
    if (!cur.includes(entry)) appendFileSync(ex, `\n${entry}\n`);
  } catch {
    /* best-effort */
  }
}

/** Share node_modules + exclude markers on every worktree (new or resumed). */
export function hardenWorktree(wt, repo, dryRun) {
  if (dryRun || !wt || !existsSync(wt)) return;
  appendWorktreeExclude(wt, "/node_modules");
  appendWorktreeExclude(wt, `/${BASE_SHA_MARK}`);
  const repoModules = path.join(repo, "node_modules");
  if (existsSync(repoModules) && !existsSync(path.join(wt, "node_modules"))) {
    try {
      symlinkSync(repoModules, path.join(wt, "node_modules"));
    } catch {
      /* best-effort */
    }
  }
}

/** Persist fork SHA on first run; reuse on resume so diff/scan windows stay stable. */
export function resolveBaseSha({ wt, base, resumed, dryRun, repo }) {
  if (!wt || dryRun || !existsSync(wt)) return base;
  hardenWorktree(wt, repo, dryRun);
  const persisted = readPersistedBaseSha(wt);
  if (persisted) return persisted;
  const resolved = gitQuiet(["rev-parse", base], wt) || base;
  const sha = resumed ? gitQuiet(["merge-base", resolved, "HEAD"], wt) || resolved : resolved;
  writeFileSync(path.join(wt, BASE_SHA_MARK), `${sha}\n`);
  return sha;
}

export function primarySnapshot(repo) {
  return {
    status: gitQuiet(["status", "--porcelain"], repo),
    head: gitQuiet(["rev-parse", "HEAD"], repo),
  };
}

export function snapshotsDiffer(before, after) {
  return after.status !== before.status || after.head !== before.head;
}

/**
 * Pure tripwire verdict — true means ABORT. `git` facts are injected so this is table-testable:
 *   originMainSha — `git rev-parse origin/main` at check time
 *   headIsAncestor — whether before.head is an ancestor of after.head
 * ANY working-tree status change (tracked or untracked) still trips — an untracked file escaping
 * into the primary checkout is exactly what this wire exists to catch. The ONLY tolerated change
 * is the HEAD move concurrent `roadmap-run` walkers legitimately cause between issues: an
 * ff-only advance where before.head is an ancestor of after.head AND after.head is exactly
 * origin/main. Anything else (rogue local commit, reset, checkout) still trips.
 */
export function tripwireVerdict(before, after, { originMainSha, headIsAncestor }) {
  if (after.status !== before.status) return true;
  if (after.head === before.head) return false;
  return !(headIsAncestor && originMainSha && after.head === originMainSha);
}

export function tripwireTripped(before, repo) {
  const after = primarySnapshot(repo);
  let headIsAncestor = false;
  if (before.head && after.head && before.head !== after.head) {
    try {
      git(["merge-base", "--is-ancestor", before.head, after.head], repo, { capture: false });
      headIsAncestor = true;
    } catch {
      headIsAncestor = false;
    }
  }
  return tripwireVerdict(before, after, {
    originMainSha: gitQuiet(["rev-parse", "origin/main"], repo),
    headIsAncestor,
  });
}

/**
 * Classify HOW the primary checkout changed during a build round (AIO-239 R1a).
 * `headMoved` alone is the NORMAL parallel-workstream signal — other agents merging PRs to main
 * advances HEAD without touching the working tree, and a worktree-isolated build is unaffected.
 * `statusChanged` (new dirty/untracked state) is the one worth an operator's eyes: it can mean a
 * builder escaped the worktree — but aborting cannot undo such damage, it only discards finished
 * work, so callers WARN + audit instead of aborting.
 */
export function tripwireReport(before, repo) {
  const after = primarySnapshot(repo);
  const headMoved = !!before.head && !!after.head && after.head !== before.head;
  let headIsAncestor = false;
  if (headMoved) {
    try {
      git(["merge-base", "--is-ancestor", before.head, after.head], repo, { capture: false });
      headIsAncestor = true;
    } catch {
      headIsAncestor = false;
    }
  }
  // `suspicious` reuses AIO-241's pure verdict: a status change, or a HEAD move that is NOT the
  // benign concurrent-walker ff to origin/main (rogue commit / reset / checkout). Suspicious
  // changes get the LOUD warning; benign ff moves get a note. Nothing aborts either way.
  const suspicious = tripwireVerdict(before, after, {
    originMainSha: gitQuiet(["rev-parse", "origin/main"], repo),
    headIsAncestor,
  });
  return {
    headMoved,
    statusChanged: after.status !== before.status,
    suspicious,
    after,
  };
}

function resolveWorktree({ repo, branch, base, worktreePath, dryRun }) {
  assertSafeBuildBranch(branch, currentBranch(repo));

  const wt = worktreePath
    ? path.resolve(worktreePath)
    : path.resolve(repo, "..", `${path.basename(repo)}-${slugify(branch)}`);

  if (path.resolve(wt) === path.resolve(repo)) {
    die("refusing to build inside the primary checkout — choose a separate --worktree path");
  }

  const existing = worktreeForBranch(repo, branch);
  if (existing) {
    console.log(c.dim(`Reusing existing worktree for ${branch}: ${existing}`));
    if (!dryRun) hardenWorktree(existing, repo, dryRun);
    return { worktreePath: existing, resumed: true };
  }

  const branchPreExisted = branchExists(repo, branch);
  if (dryRun) {
    console.log(c.dim(`[dry-run] git worktree add for ${branch} at ${wt}`));
  } else if (branchPreExisted) {
    git(["worktree", "add", wt, branch], repo);
    hardenWorktree(wt, repo, dryRun);
  } else {
    try {
      git(["worktree", "add", "-b", branch, wt, base], repo);
    } catch {
      gitQuiet(["fetch", "origin"], repo);
      git(["worktree", "add", "-b", branch, wt, base], repo);
    }
    hardenWorktree(wt, repo, dryRun);
  }
  return { worktreePath: wt, resumed: branchPreExisted };
}

function snapshotDiff(worktree, baseSha) {
  // Auto-commit any stragglers so baseSha..HEAD is the authoritative change set.
  // NOTE: --no-verify skips repo commit hooks for this straggler commit; the
  // secrets gate runs separately (fail-closed), but hook-only checks are skipped.
  git(["add", "-A"], worktree);
  const staged = gitQuiet(["diff", "--cached", "--name-only"], worktree);
  if (staged) {
    git(["commit", "-m", "build: auto-commit working changes", "--no-verify"], worktree);
  }
  // Two-dot against the frozen baseSha everywhere, so the reviewer and the secrets
  // scanner (runSecretsScan) operate on the exact same change set even after rebases.
  const totalCommits = parseInt(
    gitQuiet(["rev-list", "--count", `${baseSha}..HEAD`], worktree) || "0",
    10
  );
  const diffStat = gitQuiet(["diff", "--stat", `${baseSha}..HEAD`], worktree);
  const logOneline = gitQuiet(["log", "--oneline", `${baseSha}..HEAD`], worktree);
  let diff = gitQuiet(["diff", `${baseSha}..HEAD`], worktree);
  // Real (pre-truncation) payload size, clamped to DIFF_CAP — the adaptive review timeout
  // keys off THIS, not diff.length, because the diff below collapses to a short message
  // when over cap (which would under-scale the timeout for exactly the biggest diffs).
  const reviewPayloadChars = computeReviewPayloadChars(diff);
  if (diff.length > DIFF_CAP) {
    const files = gitQuiet(["diff", "--name-only", `${baseSha}..HEAD`], worktree);
    diff = `(diff is ${diff.length} chars — truncated. Files changed:\n${files}\n\nReview the worktree directly: git -C ${worktree} diff ${baseSha}..HEAD)`;
  }
  return { totalCommits, diffStat, logOneline, diff, reviewPayloadChars };
}

// Fail-closed secrets scan over EXACTLY the change set. Copies the changed files
// into a throwaway dir and runs the repo's gates on that — never the whole worktree.
// (Scanning the worktree false-fails: its `.git` file embeds the primary checkout's
// absolute path, leak-gate.sh embeds the denylist itself, and examples/ is synthetic.)
// Uses leak-gate.sh + validate-all.sh --critical (OGR03 secrets only — the full
// validator suite checks OKF workspace structure and would false-fail a code repo).
function runSecretsScan(repo, worktree, baseSha) {
  const changed = gitQuiet(["diff", "--name-only", `${baseSha}..HEAD`], worktree)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!changed.length) return { ok: true, output: "(no changed files to scan)" };

  const tmp = mkdtempSync(path.join(os.tmpdir(), "aios-scan-"));
  try {
    let ok = true;
    const chunks = [`Scanned ${changed.length} changed file(s).`];
    for (const f of changed) {
      const src = path.join(worktree, f);
      if (!existsSync(src)) continue;
      let st;
      try {
        st = lstatSync(src);
      } catch {
        continue;
      }
      const dst = path.join(tmp, f);
      mkdirSync(path.dirname(dst), { recursive: true });
      if (st.isSymbolicLink()) {
        let target;
        try {
          target = readlinkSync(src);
        } catch {
          ok = false;
          chunks.push(`[FAIL unreadable symlink ${f}]`);
          continue;
        }
        const resolved = path.resolve(path.dirname(src), target);
        if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
          ok = false;
          chunks.push(`[FAIL symlink ${f} -> ${target} (not a regular file)]`);
          continue;
        }
        cpSync(resolved, dst);
        continue;
      }
      if (!st.isFile()) {
        ok = false;
        chunks.push(`[FAIL non-file path in change set: ${f}]`);
        continue;
      }
      cpSync(src, dst);
    }
    // Absolute machine paths (e.g. /Users/<name>/…, /home/<name>/…) leak the
    // builder's environment and are forbidden by the build prompt. The shared
    // OGR03 scanner deliberately tolerates dummy paths in committed test code, so
    // we enforce this on the BUILT change set here — never on the whole repo.
    for (const f of changed) {
      const dst = path.join(tmp, f);
      if (!existsSync(dst)) continue;
      let body;
      try {
        body = readFileSync(dst, "utf8");
      } catch {
        continue;
      }
      const hit = body.match(/\/(Users|home)\/[A-Za-z0-9._-]+\//);
      if (hit) {
        ok = false;
        chunks.push(`[FAIL absolute machine path in ${f}] matched: ${hit[0]}`);
      }
    }
    const checks = [
      { script: path.join(repo, "scripts", "leak-gate.sh"), args: [tmp] },
      { script: path.join(repo, "validation", "validate-all.sh"), args: [tmp, "--critical"] },
    ];
    for (const { script, args } of checks) {
      if (!existsSync(script)) {
        // Fail closed: a missing gate script means the change set is unscanned.
        ok = false;
        chunks.push(`[MISSING ${path.basename(script)} — cannot scan; failing closed]`);
        continue;
      }
      try {
        const out = execFileSync("bash", [script, ...args], {
          cwd: repo,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        chunks.push(`[PASS ${path.basename(script)}]\n${out.trim()}`);
      } catch (e) {
        ok = false;
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
        chunks.push(`[FAIL ${path.basename(script)}]\n${out}`);
      }
    }
    return { ok, output: chunks.join("\n\n") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Optional verification gate (e.g. `--verify "npm test"`). Runs the user's command
// in the worktree and captures pass/fail + a tail of output. The command is supplied
// by the operator (same trust as running it themselves), so a shell is acceptable.
function runVerification(worktree, cmd) {
  try {
    const out = execFileSync(cmd, {
      cwd: worktree,
      shell: true,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: out.slice(-3000) };
  } catch (e) {
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    return { ok: false, output: out.slice(-3000) };
  }
}

// Call an agent (Claude builder or Cursor reviewer), retrying transient backend
// drops (ECONNRESET etc.) — but never real timeouts or agent errors.
async function withRetry(callFn, prompt, timeoutMs, opts, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await callFn(prompt, timeoutMs, opts);
    } catch (e) {
      const transient = TRANSIENT_RE.test(e.message) && !/timed out/.test(e.message);
      if (!transient || i >= attempts) throw e;
      console.log(
        c.yellow(
          `agent call failed (transient): ${e.message.slice(0, 100)} — retry ${i}/${attempts - 1}`
        )
      );
    }
  }
}

// Retry a REVIEW call exactly once on timeout, with a doubled timeout. A non-timeout error
// ("agent exited N") propagates immediately; a second timeout also propagates (fails the
// round). callFn is injected so tests exercise the retry with a fake agent — no live cursor.
// The retry decision lands in both the console and the --log trail.
export async function reviewWithTimeoutRetry(
  callFn,
  prompt,
  timeoutMs,
  opts = {},
  { log, logLabel } = {}
) {
  try {
    return await callFn(prompt, timeoutMs, opts);
  } catch (e) {
    if (!isTimeoutError(e)) throw e;
    const doubled = timeoutMs * 2;
    const msg = `review timed out after ${timeoutMs / 1000}s — retrying once with ${doubled / 1000}s (attempt 2/2)`;
    console.log(c.yellow(msg));
    log?.(logLabel ?? "review timeout retry", msg);
    return await callFn(prompt, doubled, opts); // a second timeout throws → round fails
  }
}

// ── core loop ─────────────────────────────────────────────────────────────────

export async function runBuild({ repo, plan, branch, opts }) {
  // Builder = Claude Code (Opus); reviewer = Cursor. Claude Code uses its own auth,
  // so ANTHROPIC_API_KEY is not required here.
  checkPrereqs({ requireAnthropic: false, requireClaude: true, requireCursor: true });

  if (!plan || !plan.trim()) die("no plan to build — pass a plan file or task.");
  if (!branch) {
    branch = `feat/aios-build-${slugify(plan.split("\n")[0] || "task")}`;
  }

  const {
    rounds,
    buildTimeout,
    cursorTimeout,
    cursorTimeoutSet,
    model: modelOverride,
    skill,
    base,
    verify,
    findingsFile,
    worktreePath,
    logFile,
    merge,
    pr,
    issue,
    noGate,
    keepWorktree,
    dryRun,
    bugbot,
  } = opts;

  // Per-step model/effort/timeout matrix: default → .aios/loop-models.yaml → CLI flags.
  // A --model applies to every builder step; --cursor-timeout (when explicit) overrides
  // the reviewer timeout. The diversity guard (build vs code_review family) runs here
  // and fails closed on a bad config.
  const cliOverrides = {};
  if (modelOverride) {
    for (const step of ["build", "fix", "fix_escalated"])
      cliOverrides[step] = { model: modelOverride };
  }
  if (cursorTimeoutSet) cliOverrides.code_review = { timeoutMs: cursorTimeout };
  const models = resolveLoopModels({ repo, cliOverrides });
  // Explicit wins, never scale: models.code_review.timeoutMs is non-null iff the operator set
  // --cursor-timeout OR code_review_timeout_s. When it's null we adapt per round off the real
  // review payload size (§ adaptiveReviewTimeout); when set, adaptation is bypassed entirely.
  const explicitReviewTimeoutMs = models.code_review.timeoutMs ?? null;

  // --pr needs an AIO issue to drive the Linear PR-in-review → Done automations. It can
  // come from --issue or be derived from a branch that already names one. Fail fast.
  if (pr && !issue && !/AIO-\d+/.test(branch)) {
    die("--pr requires an issue: pass --issue AIO-<n>, or use a branch name containing AIO-<n>.");
  }

  const { worktreePath: wt, resumed } = resolveWorktree({
    repo,
    branch,
    base,
    worktreePath,
    dryRun,
  });

  const baseSha = resolveBaseSha({ wt, base, resumed, dryRun, repo });

  // Create the log first, THEN snapshot the tripwire baseline — so a --log file
  // written inside the repo is part of the baseline (our write, not the agent's)
  // and doesn't trip the "primary checkout changed" guard below.
  // Append by default: makeLogger only writes the header when the file is absent, so a
  // second standalone `aios build --log X` adds a fresh header + sections instead of
  // clobbering the first run. `chained` (relay --build) already relied on append.
  const log = makeLogger(logFile, `# aios build\n\nBranch: ${branch}\nWorktree: ${wt}\n`, {
    append: true,
  });

  // Tripwire baseline: movement of the primary checkout is CLASSIFIED per round (non-fatal;
  // see tripwireReport) — head-only movement is normal under parallel agents.
  let primaryBefore = primarySnapshot(repo);

  console.log("\n── aios build ───────────────────────────────────────────────");
  console.log(`Branch:     ${branch}`);
  console.log(`Worktree:   ${wt}${resumed ? c.dim(" (resumed)") : ""}`);
  console.log(`Review:     ${skill}`);
  console.log(`Max rounds: ${rounds}`);
  console.log(`Merge:      ${merge ? "yes (on approval)" : c.dim("no (review diff yourself)")}`);
  if (bugbot && (merge || pr))
    console.log(`Bugbot:     ${c.dim("local /review-bugbot before merge/PR")}`);
  if (logFile) console.log(`Log:        ${logFile}`);
  if (dryRun) console.log(c.yellow("Mode:       dry-run (no merge)"));
  console.log("─────────────────────────────────────────────────────────────");

  if (dryRun && !existsSync(wt)) {
    console.log(
      c.yellow("\n[dry-run] worktree not created — nothing to build. Re-run without --dry-run.")
    );
    return EXIT.OK;
  }

  let prevReview = null;
  // The must-fix subset seeded from --findings, kept for the WHOLE run: a gate failure
  // replaces prevReview with the gate text, so without a separate handle the outstanding
  // must-fix items would vanish from every later round (M1). null when not seeding.
  let seededFindings = null;
  // Seed prior feedback from a consolidated findings file (aios consolidate-findings). This
  // makes round 1 a fix round (hasPriorFeedback === true) that resolves through the
  // fix/fix_escalated ladder exactly like a Cursor review — the consolidated must-fix subset
  // IS the reviewer feedback replacing a hand-pasted fix file. Seeding pre-loop is intended.
  if (findingsFile) {
    if (!existsSync(findingsFile)) die(`--findings file not found: ${findingsFile}`);
    const raw = readFileSync(findingsFile, "utf8");
    // Seed ONLY when ≥1 actionable finding survives extraction (Critical/High or a
    // plan-conformance Medium). A CLEAR findings file's leftover headers/verdict prose is
    // NOT actionable — abort fast instead of burning a builder round on a fresh build (M3).
    if (!hasActionableFindings(raw)) {
      die(
        `--findings ${findingsFile}: nothing to fix — no actionable findings ` +
          `(Critical/High, or a plan-conformance Medium) in the file. A CLEAR findings ` +
          `file does not seed a fix round; re-run without --findings to build from scratch.`
      );
    }
    const mustFix = extractMustFix(raw);
    prevReview = mustFix;
    seededFindings = mustFix;
    console.log(c.dim(`[findings] seeding round 1 from must-fix subset of ${findingsFile}`));
    log("Seeded findings (must-fix)", mustFix.slice(-4000));
  }
  let blockedOnGate = false; // true when the last round failed verify/secrets, not review
  let prevCommits = parseInt(gitQuiet(["rev-list", "--count", `${baseSha}..HEAD`], wt) || "0", 10);
  // Counts builder invocations that consume prior feedback (a Cursor review OR a gate
  // failure). Deliberately separate from the outer `round` — the fix-escalation ladder
  // keys on this, never on `round` (round 1 is the no-feedback initial build).
  let fixAttempt = 0;

  for (let round = 1; round <= rounds; round++) {
    console.log(`\n══ Build round ${round}/${rounds} ${"═".repeat(46 - String(round).length)}`);

    // 1. BUILD — pick the model-matrix step (build / fix / fix_escalated) from feedback.
    const hasPriorFeedback = prevReview !== null;
    if (hasPriorFeedback) fixAttempt++;
    const step = selectBuilderStep({ hasPriorFeedback, fixAttempt, reviewText: prevReview });
    const cfg = models[step];
    const buildPrompt = buildImplementPrompt(plan, {
      review: prevReview,
      resumeLog:
        round === 1 && prevCommits > 0
          ? gitQuiet(["log", "--oneline", `${baseSha}..HEAD`], wt)
          : null,
      branch,
    });
    // Every builder call carries the git rules (no push/PR, worktree-only) at the prompt
    // layer AND GIT_CEILING_DIRECTORIES = the worktree's parent dir, which blocks git's
    // accidental upward *discovery* into the primary checkout (an explicit `git -C <path>`
    // is NOT blocked — the primary-checkout tripwire is what catches that). Defense-in-
    // depth, not containment. --effort is a Claude-CLI knob
    // (build/fix/fix_escalated only); the relay plan step uses SDK output_config instead.
    const fencedPrompt = BUILDER_FENCE + "\n\n" + buildPrompt;
    const extraArgs = cfg.effort
      ? [...CLAUDE_BUILD_FLAGS, "--effort", cfg.effort]
      : CLAUDE_BUILD_FLAGS;
    const builderEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(wt) };
    console.log(
      c.dim(
        `[claude] building (${cfg.model}, step=${step}${cfg.effort ? `, effort=${cfg.effort}` : ""})...`
      )
    );
    try {
      const builderOut = await withRetry(
        (p, t, o) => callAgentModel({ model: cfg.model, prompt: p, timeoutMs: t, opts: o }),
        fencedPrompt,
        buildTimeout,
        {
          cwd: wt,
          extraArgs,
          env: builderEnv,
        }
      );
      log(`Build round ${round} — builder`, builderOut.slice(-4000));
    } catch (e) {
      if (/timed out/.test(e.message)) {
        console.error(
          c.red(
            `\nerror: builder timed out after ${buildTimeout / 1000}s — increase with --build-timeout <seconds>.`
          )
        );
        console.error(c.dim(`Partial work may be uncommitted: git -C ${wt} status`));
        return EXIT.TIMEOUT;
      }
      die(`builder failed: ${e.message}`);
    }

    // 2. CAPTURE the authoritative change set (auto-commit stragglers)
    const snap = snapshotDiff(wt, baseSha);
    const newCommits = snap.totalCommits - prevCommits;
    prevCommits = snap.totalCommits;
    console.log(c.dim(`→ ${snap.totalCommits} commit(s) on branch (${newCommits} new this round)`));
    if (snap.diffStat) console.log(snap.diffStat);

    // 3. TRIPWIRE (non-fatal since AIO-239): classify primary-checkout movement instead of
    // aborting. main advancing under parallel agents is the expected steady state and must not
    // destroy a finished build; a working-tree change gets a loud warning + log entry (aborting
    // would not undo it anyway). The baseline re-arms each round so a single event warns once.
    {
      const trip = tripwireReport(primaryBefore, repo);
      if (trip.suspicious) {
        const what = trip.statusChanged
          ? "working tree changed (possible out-of-worktree write)"
          : "HEAD moved in a non-fast-forward way (rogue commit / reset / checkout?)";
        console.error(
          c.yellow(
            `\nWARNING — the primary checkout at ${repo}: ${what} during this build round. ` +
              `The build itself is worktree-isolated and continues; inspect: git -C ${repo} status`
          )
        );
        log(
          `Build round ${round} — tripwire WARNING`,
          `${what}\n` +
            `before: head=${primaryBefore.head}\n${primaryBefore.status || "(clean)"}\n` +
            `after: head=${trip.after.head}\n${trip.after.status || "(clean)"}`
        );
      } else if (trip.headMoved) {
        console.log(
          c.dim(
            `note: the primary checkout fast-forwarded during this round (concurrent walkers) — build unaffected.`
          )
        );
      }
      if (trip.statusChanged || trip.headMoved) primaryBefore = trip.after;
    }

    // 4. Did the builder produce anything?
    const klass = classifyDiff({ totalCommits: snap.totalCommits, newCommits });
    if (klass === "no-commits") {
      console.error(c.red("\nerror: builder made no commits — nothing to review."));
      console.error(c.dim(`Inspect: git -C ${wt} status`));
      return EXIT.NO_DIFF;
    }
    // A feedback round that produced no new commits is a stall — don't spin.
    if (round > 1 && newCommits === 0) {
      console.error(
        c.yellow(`\nBuilder made no new commits this round and the diff is not approved.`)
      );
      console.error(c.dim(`Worktree preserved: ${wt}. Resume: aios build <plan> ${branch}`));
      return EXIT.NONCONVERGENCE;
    }

    // 5. GATES (run BEFORE review so the reviewer has evidence; a failing gate sends
    //    feedback to the builder and loops WITHOUT spending a review round).
    let gateFeedback = null;
    if (verify) {
      const v = runVerification(wt, verify);
      console.log(v.ok ? c.green("✓ verify passed") : c.red("✗ verify failed"));
      log(`Build round ${round} — verify`, v.output);
      if (!v.ok) gateFeedback = `Verification command failed (\`${verify}\`):\n\n${v.output}`;
    }
    const secrets = runSecretsScan(repo, wt, baseSha);
    console.log(secrets.ok ? c.green("✓ secrets scan clean") : c.red("✗ secrets scan FAILED"));
    log(`Build round ${round} — secrets scan`, secrets.output);
    if (!secrets.ok) {
      gateFeedback =
        (gateFeedback ? gateFeedback + "\n\n" : "") +
        `Secrets/leak scan FAILED — remove these before continuing:\n\n${secrets.output}`;
    }
    if (gateFeedback) {
      console.log(
        c.yellow("gate failed — sending feedback to the builder; skipping review this round")
      );
      // Carry the still-outstanding seeded must-fix findings ALONGSIDE the gate output, so a
      // gate failure never drops them from later rounds (M1). Without this, a --findings-seeded
      // round that then trips a gate would replace prevReview with the gate text alone and the
      // Critical/High items would silently vanish.
      prevReview = seededFindings
        ? `${gateFeedback}\n\n## Still-outstanding must-fix findings (address these too)\n\n${seededFindings}`
        : gateFeedback;
      blockedOnGate = true;
      continue;
    }
    blockedOnGate = false;

    // 6. REVIEW the real diff
    const reviewPrompt = buildCodeReviewPrompt({
      skill,
      plan,
      diff: snap.diff,
      diffStat: snap.diffStat,
      logOneline: snap.logOneline,
      secretsResult: secrets.output || "(scan produced no output)",
      branch,
      round,
      maxRounds: rounds,
    });
    // Per-round review timeout: explicit (operator-set) wins; otherwise adapt to this round's
    // real review payload size. Logged so the choice is visible in the console + --log trail.
    const reviewTimeoutMs =
      explicitReviewTimeoutMs != null
        ? explicitReviewTimeoutMs
        : adaptiveReviewTimeout(snap.reviewPayloadChars) * 1000;
    const why =
      explicitReviewTimeoutMs != null ? "explicit" : `adaptive (${snap.reviewPayloadChars} chars)`;
    console.log(c.dim(`[cursor] review timeout ${reviewTimeoutMs / 1000}s — ${why}`));
    log(`Build round ${round} — review timeout`, `${reviewTimeoutMs / 1000}s (${why})`);
    console.log(c.dim(`[cursor] reviewing diff (${skill})...`));
    const reviewCallFn = reviewCallForModel(models.code_review.model);
    // Auto-retry once on timeout (doubled), with transient-drop retries INSIDE each attempt.
    const review = await reviewWithTimeoutRetry(
      (p, t, o) => withRetry(reviewCallFn, p, t, o),
      reviewPrompt,
      reviewTimeoutMs,
      {
        cwd: wt,
        extraArgs: [...CURSOR_REVIEW_FLAGS],
      },
      { log, logLabel: `Build round ${round} — review timeout retry` }
    );
    log(`Build round ${round} — review`, review);
    console.log("\n── review done ─────────────────────────────────────────────");

    // 7. CONVERGENCE
    if (detectMergeToken(review)) {
      console.log(c.green(`\n✓ ${MERGE_READY_TOKEN} received after round ${round}.`));
      const approvedHeadSha = gitQuiet(["rev-parse", "HEAD"], wt);
      return finish({
        repo,
        branch,
        wt,
        baseSha,
        merge,
        pr,
        issue,
        noGate,
        keepWorktree,
        dryRun,
        log,
        approvedHeadSha,
        verify,
        bugbot,
        // Bugbot (finish) uses the explicit timeout when set, else the plain default —
        // it reviews the whole branch diff, not the per-round diff, so it doesn't adapt.
        cursorTimeout: explicitReviewTimeoutMs ?? DEFAULT_REVIEW_TIMEOUT * 1000,
      });
    }

    prevReview = review;
  }

  // Round budget spent — preserve the branch for a human (never force-merge code).
  if (blockedOnGate) {
    console.error(c.red(`\n✗ Build blocked by the secrets/verify gate after ${rounds} round(s).`));
    console.error(
      c.dim(`Branch '${branch}' preserved. Fix the gate failure, then re-run. Worktree: ${wt}`)
    );
    return EXIT.GATE_FAILED;
  }
  console.error(c.yellow(`\nReached max build rounds (${rounds}) without ${MERGE_READY_TOKEN}.`));
  console.error(c.dim(`Branch '${branch}' preserved with work. Worktree: ${wt}`));
  console.error(
    c.dim(
      `Resume: aios build <plan> ${branch}   ·   Inspect: git -C ${wt} log --oneline ${baseSha}..HEAD`
    )
  );
  return EXIT.NONCONVERGENCE;
}

async function finish({
  repo,
  branch,
  wt,
  baseSha,
  merge,
  pr,
  issue,
  noGate,
  keepWorktree,
  dryRun,
  log,
  approvedHeadSha,
  verify,
  bugbot,
  cursorTimeout,
}) {
  // Re-capture: reviewer (--force) may have committed after MERGE_READY was emitted.
  snapshotDiff(wt, baseSha);
  const headNow = gitQuiet(["rev-parse", "HEAD"], wt);
  if (approvedHeadSha && headNow !== approvedHeadSha) {
    console.error(
      c.red(
        "\n✗ worktree HEAD moved after review approval — merge blocked. Re-run build to re-review."
      )
    );
    log("Merge blocked — HEAD drift", `approved ${approvedHeadSha} → now ${headNow}`);
    return EXIT.GATE_FAILED;
  }

  if (verify) {
    const v = runVerification(wt, verify);
    log("Pre-merge verify", v.output);
    if (!v.ok) {
      console.error(c.red("\n✗ pre-merge verify FAILED — merge blocked."));
      return EXIT.GATE_FAILED;
    }
    console.log(c.green("✓ pre-merge verify passed"));
  }

  // Fail-closed secrets gate immediately before merge.
  if (!noGate) {
    const gate = runSecretsScan(repo, wt, baseSha);
    log("Pre-merge secrets gate", gate.output);
    if (!gate.ok) {
      console.error(c.red("\n✗ pre-merge secrets gate FAILED — merge blocked."));
      console.error(gate.output);
      console.error(
        c.dim(`\nBranch '${branch}' preserved. Remove the leak, then re-run. (CLAUDE.md §7)`)
      );
      return EXIT.GATE_FAILED;
    }
    console.log(c.green("✓ pre-merge secrets gate clean"));
  } else {
    console.log(c.yellow("⚠ --no-gate: skipping the pre-merge secrets gate (not recommended)"));
  }

  // Bugbot runs before ANY ship action (merge OR push/PR) — never after code leaves.
  if ((merge || pr) && bugbot && !dryRun) {
    const bb = await runLocalBugbotReview({
      repo,
      worktree: wt,
      baseSha,
      branch,
      cursorTimeout,
    });
    log("Pre-merge Bugbot review", bb.output.slice(-8000));
    if (!bb.ok) {
      console.error(c.red("\n✗ local Bugbot found Critical/High issues — merge blocked."));
      console.error(c.dim("Fix findings or pass --no-bugbot to skip (not recommended)."));
      return EXIT.GATE_FAILED;
    }
    console.log(c.green("✓ local Bugbot clear (BUGBOT_CLEAR)"));
  }

  // The merge lands in the PRIMARY checkout's current branch (--base only seeds the
  // worktree). Make the target explicit so an unexpected checkout can't be merged into.
  const target = currentBranch(repo) || "(detached HEAD)";

  if (merge && !dryRun) {
    console.log(
      c.dim(`Merging ${branch} into '${target}' (the primary checkout's current branch).`)
    );
    // Remove the worktree BEFORE deleting the branch — git refuses to delete a
    // branch that is still checked out in a worktree.
    if (!keepWorktree) {
      try {
        git(["worktree", "remove", "--force", wt], repo);
        console.log(c.dim(`Removed worktree ${wt}`));
      } catch {
        rmSync(wt, { recursive: true, force: true });
        try {
          git(["worktree", "prune"], repo);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      // keepWorktree leaves the branch checked out, so only delete it when we removed
      // the worktree (gitMergeAndDelete does merge + branch -d).
      if (keepWorktree) {
        git(["merge", "--no-ff", "-m", "chore: merge via aios build", "--", branch], repo, {
          capture: false,
        });
        console.log(c.green(`\n✓ Merged: ${branch} (worktree kept)`));
      } else {
        gitMergeAndDelete(repo, branch, false, "chore: merge via aios build");
      }
    } catch (e) {
      console.error(c.red(`\nmerge failed (likely a conflict): ${e.message}`));
      console.error(c.dim(`Branch '${branch}' preserved. Resolve and merge manually.`));
      return EXIT.NONCONVERGENCE;
    }
  } else if (merge && dryRun) {
    gitMergeAndDelete(repo, branch, true, "chore: merge via aios build");
  } else if (pr) {
    // --pr: push the branch and open a PR (never merge, never remove the worktree/branch
    // — the branch must survive for the PR). Runs ONLY after the pre-merge gates above.
    // throwOnError: a PR failure (push/create/undeterminable number) must surface as a
    // gate-failure exit code here — NOT abort the build via cmdPr's own process.exit, and
    // NEVER report success (exit 0) without a PR_NUMBER.
    const prArgs = ["--branch", branch, ...(issue ? ["--issue", issue] : [])];
    if (dryRun) prArgs.push("--dry-run");
    let prNumber;
    try {
      prNumber = await cmdPr(repo, prArgs, { throwOnError: true });
    } catch (e) {
      console.error(c.red(`\n✗ opening the PR failed: ${e.message}`));
      log("PR failed", e.message);
      return EXIT.GATE_FAILED;
    }
    // dry-run legitimately returns null; a real run that yields no number is a failure.
    if (!dryRun && !prNumber) {
      console.error(c.red("\n✗ PR step returned no PR number — treating as failure."));
      log("PR failed", "no PR number returned");
      return EXIT.GATE_FAILED;
    }
    if (!dryRun) log("PR opened", `PR_NUMBER=${prNumber}`);
  } else {
    console.log(c.yellow("\nCode approved. Review the diff before merging:"));
    console.log(c.dim(`  git -C ${repo} diff ${branch}`));
    console.log(c.dim(`  git -C ${repo} merge --no-ff -- ${branch}   # lands in '${target}'`));
    console.log(c.dim("Re-run with --merge to have aios build merge automatically."));
  }
  return EXIT.OK;
}

// ── CLI entry point ─────────────────────────────────────────────────────────────

export async function cmdBuild(repo, args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      [
        "",
        c.blue(
          "aios build — implement an approved plan with Opus (Claude Code), reviewed by Cursor"
        ),
        "",
        "usage:",
        "  aios build <plan-file|task> [branch] [options]",
        "",
        "arguments:",
        "  plan-file   Path to an approved plan (a relay --log file). If it is not a",
        "              readable file it is treated as an inline task (skips plan review).",
        "  branch      Worktree branch to build on (optional; auto-derived if omitted).",
        "",
        "options:",
        "  --task                  treat the first argument as an inline task, not a file",
        "  --rounds N              max build/review cycles (default: 4)",
        "  --build-timeout N       seconds before killing a stalled builder call (default: 1800)",
        "  --cursor-timeout N      seconds before killing a stalled review call (default: 300)",
        "  --skill /name           Cursor review skill (default: /ai-code-review)",
        '  --verify "<cmd>"        run this command in the worktree before each review;',
        '                          a failure loops feedback to the builder (e.g. "npm test")',
        "  --findings <file>       seed round 1 from a consolidated findings file (the must-fix",
        "                          subset: all Critical/High + plan-conformance Medium) so the",
        "                          builder fixes them first (see aios consolidate-findings)",
        "  --base <ref>            base ref for a new worktree branch (default: origin/main)",
        "  --worktree <path>       worktree directory (default: ../<repo>-<branch>)",
        "  --merge                 merge the branch on approval (off by default)",
        "  --pr                    push + open a PR on approval (mutually exclusive with --merge)",
        "  --issue AIO-<n>         issue key for --pr (required unless the branch names one)",
        "  --model <id>            override the builder model for every build/fix step",
        "  --bugbot                run local /review-bugbot before merge/PR (default with --merge or --pr)",
        "  --no-bugbot             skip the local Bugbot gate even when --merge/--pr is set",
        "  --no-gate               skip the pre-merge secrets gate (NOT recommended)",
        "  --keep-worktree         keep the worktree after a successful merge",
        "  --log <file>            save build rounds + reviews to a Markdown file (appends)",
        "  --dry-run               run the loop but never merge / open a PR",
        "",
        "examples:",
        "  aios build plan.md feat/my-feature",
        "  aios build plan.md feat/my-feature --merge",
        "  aios build plan.md feat/AIO-42-x --pr --issue AIO-42",
        '  aios build "Add a --version flag to aios.mjs" --task feat/version',
      ].join("\n")
    );
    return;
  }

  const opts = parseBuildArgs(args);
  if (!opts.planSource) die("a plan file (or --task <task>) is required.");

  let plan;
  if (!opts.isTask && existsSync(opts.planSource)) {
    try {
      plan = extractPlanFromLog(readFileSync(opts.planSource, "utf8"));
    } catch (e) {
      die(`could not read plan from ${opts.planSource}: ${e.message}`);
    }
  } else {
    if (!opts.isTask) {
      console.log(
        c.yellow(
          `'${opts.planSource}' is not a file — treating it as an inline task (no plan review).`
        )
      );
    }
    plan = opts.planSource;
  }

  const code = await runBuild({ repo, plan, branch: opts.branch, opts });
  process.exit(code);
}
