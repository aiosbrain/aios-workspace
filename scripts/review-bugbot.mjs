/**
 * review-bugbot.mjs — local Cursor Bugbot review (CLI hook for agents + aios build).
 *
 * Mirrors the Cursor `/review-bugbot` skill: runs the Cursor agent against the real
 * branch diff and blocks on Critical/High findings. Use standalone or via `aios build
 * --merge` (on by default; pass --no-bugbot to skip).
 *
 * Exported:
 *   runLocalBugbotReview({ repo, worktree, baseSha, branch, cursorTimeout, skill })
 *   cmdReviewBugbot(repo, args)
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { c, die, checkPrereqs, callCursorAgent } from "./relay-core.mjs";

export const DEFAULT_BUGBOT_SKILL = "/review-bugbot";
export const BUGBOT_CLEAR_TOKEN = "BUGBOT_CLEAR";
const CURSOR_REVIEW_FLAGS = ["--force", "--trust"];
const DIFF_CAP = 50000;
const DEFAULT_TIMEOUT = 300;

function gitQuiet(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

export function buildBugbotPrompt({ skill, branch, baseSha, diffStat, diff, logOneline }) {
  return [
    skill,
    "",
    `Review branch \`${branch}\` changes (base ${baseSha}..HEAD) per your skill.`,
    "Run tests/validators in this worktree to gather evidence.",
    "",
    "## Commits",
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
    "---",
    "List findings by severity. If there are NO Critical or High findings, place",
    `${BUGBOT_CLEAR_TOKEN} alone on the very last line. Otherwise list blockers for the builder.`,
  ].join("\n");
}

// Structural matchers for a listed Critical/High finding: a leading bullet
// (`- Critical: …`), a leading severity table cell (`| High |`), or the bracket form
// (`[High] file:line — …`) that the consolidated findings report (code-reviewer.md's
// "Output format") emits. Prose such as "no Critical or High findings" matches NONE of
// these — only an actual listed finding. This is the single severity dialect: both the
// Cursor review loop and the consolidator gate on the same matcher.
const CRITICAL_HIGH_BULLET = /^\s*[-*]\s*`?(Critical|High)`?\b/im;
const CRITICAL_HIGH_ROW = /^\s*\|\s*`?(Critical|High)`?\s*\|/im;
const CRITICAL_HIGH_BRACKET = /^\s*\[(Critical|High)\]/im;

// Rank for merging/comparing severities across sources (used by the consolidator).
export const SEVERITY_RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

/** True when review text lists a Critical/High finding (bullet, table row, or bracket). */
export function hasCriticalOrHighFindings(text) {
  const body = text ?? "";
  return (
    CRITICAL_HIGH_BULLET.test(body) ||
    CRITICAL_HIGH_ROW.test(body) ||
    CRITICAL_HIGH_BRACKET.test(body)
  );
}

/** True when the review has no blocking Critical/High findings. */
export function detectBugbotClear(text) {
  const body = text ?? "";
  if (/\bCritical\b/i.test(body) || /\bHigh\b/i.test(body)) {
    // Allow explicit "no Critical" negations in mergeability sections — require CLEAR token.
    const lastLine =
      body
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1) ?? "";
    if (lastLine === BUGBOT_CLEAR_TOKEN) return true;
    // Block if findings section lists Critical/High bullets or table rows.
    if (CRITICAL_HIGH_BULLET.test(body)) return false;
    if (CRITICAL_HIGH_ROW.test(body)) return false;
    return false;
  }
  const lastLine =
    body
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return lastLine === BUGBOT_CLEAR_TOKEN;
}

export function captureBranchDiff(worktree, baseSha) {
  const diffStat = gitQuiet(["diff", "--stat", `${baseSha}..HEAD`], worktree);
  const logOneline = gitQuiet(["log", "--oneline", `${baseSha}..HEAD`], worktree);
  let diff = gitQuiet(["diff", `${baseSha}..HEAD`], worktree);
  if (diff.length > DIFF_CAP) {
    const files = gitQuiet(["diff", "--name-only", `${baseSha}..HEAD`], worktree);
    diff = `(diff truncated at ${DIFF_CAP} chars — files:\n${files})`;
  }
  return { diffStat, logOneline, diff };
}

export async function runLocalBugbotReview({
  worktree,
  baseSha,
  branch,
  cursorTimeout = DEFAULT_TIMEOUT * 1000,
  skill = DEFAULT_BUGBOT_SKILL,
}) {
  checkPrereqs({ requireAnthropic: false, requireClaude: false, requireCursor: true });
  if (!worktree || !existsSync(worktree)) die("worktree path missing for Bugbot review");
  if (!baseSha) die("baseSha required for Bugbot review");

  const { diffStat, logOneline, diff } = captureBranchDiff(worktree, baseSha);
  if (!diffStat && !logOneline) {
    return { ok: true, output: "(no diff to review)" };
  }

  const prompt = buildBugbotPrompt({ skill, branch, baseSha, diffStat, diff, logOneline });
  console.log(c.dim(`[cursor] Bugbot review (${skill})...`));
  const out = await callCursorAgent(prompt, cursorTimeout, {
    cwd: worktree,
    extraArgs: CURSOR_REVIEW_FLAGS,
  });
  const ok = detectBugbotClear(out);
  return { ok, output: out };
}

export async function cmdReviewBugbot(repo, args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      [
        "",
        c.blue("aios review-bugbot — local Cursor Bugbot review on branch changes"),
        "",
        "usage:",
        "  aios review-bugbot [branch] [options]",
        "",
        "options:",
        "  --base <ref>            diff base (default: origin/main)",
        "  --worktree <path>       worktree to review (default: existing or ../<repo>-<branch>)",
        "  --cursor-timeout N      seconds (default: 300)",
        "  --skill /name           default: /review-bugbot",
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
      !["--base", "--worktree", "--cursor-timeout", "--skill"].includes(args[i - 1])
  );
  const branch = positional[0];
  if (!branch) die("branch name required");

  const base = flag("--base") ?? "origin/main";
  const baseSha = gitQuiet(["rev-parse", base], repo) || base;
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

  const timeout = parseInt(flag("--cursor-timeout") ?? String(DEFAULT_TIMEOUT), 10) * 1000;
  const skill = flag("--skill") ?? DEFAULT_BUGBOT_SKILL;

  const { ok, output } = await runLocalBugbotReview({
    repo,
    worktree: worktreePath,
    baseSha,
    branch,
    cursorTimeout: timeout,
    skill,
  });
  if (!ok) {
    console.error(c.red("\n✗ Bugbot found Critical/High issues — merge blocked."));
    console.error(output);
    process.exit(1);
  }
  console.log(c.green(`\n✓ ${BUGBOT_CLEAR_TOKEN} — no blocking Bugbot findings.`));
}
