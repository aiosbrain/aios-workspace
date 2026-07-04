/**
 * ship.mjs — `aios ship <AIO-nnn>`: the whole gated loop for one Linear issue.
 *
 * Composes the merged pipeline surfaces — never re-implements them:
 *   recon (Linear + git-tracked files) → plan (loop) → follow-up capture → build (runBuild)
 *   → PR (cmdPr) → review (waitForBots + GPT review + cmdConsolidateFindings) → fix loop
 *   → merge gate (CI + consolidator + path-gated safety review + operator) → cleanup.
 *
 * Every stage maps to a distinct, documented SHIP_EXIT code (§ SHIP_EXIT below). Gates default
 * ON; in a non-TTY context without the matching --auto flag they exit with a *_GATE_BLOCKED
 * code rather than hanging (cron safety). Recon reads ONLY git-tracked, deny-filtered files
 * (extractRepoFileRefs) so untrusted Linear text can never exfiltrate secrets/paths.
 *
 * The orchestration (runShip/cmdShip) takes injected deps so the whole pipeline is testable
 * without touching the network, git, gh, claude, or cursor.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  c,
  callClaudeAgent,
  callCursorAgent,
  callDeepSeekDirect,
  PLAN_READY_TOKEN,
} from "./relay-core.mjs";
import { EXIT as BUILD_EXIT, runBuild, slugify } from "./build.mjs";
import { cmdPr, detectRepo } from "./pr.mjs";
import {
  cmdConsolidateFindings,
  parseCheckResults,
  defaultOutPath,
} from "./consolidate-findings.mjs";
import { resolveLoopModels, modelFamily } from "./loop-models.mjs";
import { createLinearClient, resolveLinearApiKey, extractRepoFileRefs } from "./linear-client.mjs";

// ── SHIP_EXIT — stable, documented exit-code table (docs/agent-build.md) ─────────────────────
export const SHIP_EXIT = {
  OK: 0, // plan→merge→cleanup completed
  USAGE: 1, // bad args / prereqs / unresolved issue id
  RECON_FAILED: 10, // issue fetch or recon model step failed
  PLAN_UNAPPROVED: 20, // plan loop spent its round budget without PLAN_READY
  PLAN_REJECTED: 21, // operator rejected the plan at the plan gate
  PLAN_GATE_BLOCKED: 22, // plan gate active in a non-TTY context without --auto (never hang)
  BUILD_FAILED: 30, // runBuild returned a non-recoverable code (NO_DIFF/FATAL/TIMEOUT/GATE)
  BUILD_NONCONVERGENCE: 31, // runBuild spent its rounds (worktree preserved)
  PR_FAILED: 40, // cmdPr push/create failed
  REVIEW_NONCONVERGENCE: 50, // fix loop hit --max-fix-rounds still BLOCKED (no partial merge)
  MERGE_BLOCKED: 60, // merge gate: CI red/pending/unavailable or unresolved Critical/High
  SAFETY_BLOCKED: 61, // path-gated safety review withheld approval
  MERGE_GATE_BLOCKED: 62, // merge gate active in a non-TTY context without --auto-merge
  MERGE_REJECTED: 63, // operator rejected at the merge gate
  CLEANUP_FAILED: 70, // post-merge ff-only failed / primary checkout dirty (never reset/clobber)
};

export const SAFETY_APPROVED_TOKEN = "SAFETY_APPROVED";

// Steps that only *synthesize* over content already injected into their prompt (recon reads the
// pre-vetted `allowed` file blobs; safety_review reads the diff) must run with NO tools. The
// prompt carries untrusted, external text (Linear issue bodies/comments; PR diffs), so a
// prompt-injection payload must not be able to make the agent read arbitrary repo files — e.g.
// `.env`/`.aios/` — outside the tracked-only allow list. We hand the CLI a default-deny stance:
// `--permission-mode plan` (no writes) plus an explicit `--disallowedTools` blocking every
// filesystem / exec / network / delegation tool. Everything these steps need is already inline,
// so removing tool access changes nothing but the injection blast radius.
export const NO_TOOLS = [
  "Bash",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "NotebookEdit",
];
// argv fragment applied to any `callClaudeAgent` step that must not touch the filesystem.
// `--disallowedTools` takes one space-separated string (the CLI's documented list form).
export const NO_TOOLS_ARGS = ["--permission-mode", "plan", "--disallowedTools", NO_TOOLS.join(" ")];

// Diff surfaces where an approval requires an explicit safety review over the diff. A changed
// path matches if it equals a listed file or starts with a listed directory prefix.
export const SAFETY_PATHS = [
  "hooks/",
  "validation/",
  "scripts/leak-gate.sh",
  "scaffold/.claude/",
  "docs/brain-api.md",
  "scripts/brain-client.mjs",
  "scripts/brain-config.mjs",
  "scripts/workspace-parse.mjs",
];

const DEFAULT_REVIEWERS = ["bugbot", "gpt-5.5"];
// The gating reviewers ship actually knows how to run. "bugbot" → wait on the cursor[bot]
// check via wait-for-bots; "gpt-5.5" → run the Cursor GPT PR review. Unknown names are a
// usage error rather than a silently-ignored flag.
const KNOWN_REVIEWERS = new Set(["bugbot", "gpt-5.5"]);
const DEFAULT_MAX_FIX_ROUNDS = 3;
const ISSUE_RE = /^AIO-\d+$/;

// The repo verify chain runBuild runs in the worktree before each review round and pre-merge.
// Wired into every build/fix round so `aios ship` can never merge code that hasn't passed it.
export const SHIP_VERIFY_CMD =
  "npm run build:loop && npm test && npm run lint && npm run format:check";

// Default plan-stage timeout. An Opus-xhigh planner with tool access empirically needs
// 15-40 minutes (every AIO-156 epic plan round exceeded 10); the original 600s default
// killed the first real-world run mid-work (AIO-194). Override per-run with
// `plan_timeout_s` in .aios/loop-models.yaml.
export const DEFAULT_PLAN_TIMEOUT_MS = 1800 * 1000;

// A stage runner that dies (timeout or nonzero exit) must fail LOUDLY into the audit
// trail — an aborted run whose directory just stops is indistinguishable from one that
// never ran (AIO-194: the first real `aios ship` died at the plan stage leaving nothing).
export function failedArtifact(stage, error, startedAt) {
  const elapsed = startedAt ? `${Math.round((Date.now() - startedAt) / 1000)}s elapsed` : "";
  return [
    `# ${stage} FAILED`,
    "",
    `- error: ${error?.message ?? error}`,
    ...(elapsed ? [`- ${elapsed}`] : []),
    `- at: ${new Date().toISOString()}`,
    "",
    "The run aborted at this stage. See the SHIP_EXIT table in scripts/ship.mjs for the",
    "exit code, and .aios/loop-models.yaml (`<step>_timeout_s`) to raise a step timeout.",
  ].join("\n");
}

// ── checkpoint state + async gates (AIO-239) ────────────────────────────────────────────────
// Ship persists per-stage progress to `.aios/loop/<issue>/state.json` so an aborted or
// gate-blocked run is RESUMABLE (`--resume`): completed stages are skipped, the run re-enters at
// the first incomplete one. A blocked gate writes `GATE-<name>.pending.md` with the material to
// judge and exits with the gate code; `--resume --approve-plan` / `--approve-merge` satisfy it.

export const SHIP_STATE_VERSION = 1;

export function defaultReadState(repo, issue) {
  try {
    const raw = readFileSync(path.join(repo, ".aios", "loop", issue, "state.json"), "utf8");
    const st = JSON.parse(raw);
    return st && st.v === SHIP_STATE_VERSION ? st : null;
  } catch {
    return null;
  }
}

export function defaultWriteState(repo, issue, state) {
  try {
    const dir = path.join(repo, ".aios", "loop", issue);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify(
        { ...state, v: SHIP_STATE_VERSION, updatedAt: new Date().toISOString() },
        null,
        2
      ) + "\n"
    );
  } catch {
    /* best-effort — state loss degrades to a fresh run, never a crash */
  }
}

function defaultWriteGate(repo, issue, name, text) {
  try {
    const dir = path.join(repo, ".aios", "loop", issue);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `GATE-${name}.pending.md`), text); // overwrite, not append
  } catch {
    /* best-effort */
  }
}

function defaultRemoveGate(repo, issue, name) {
  try {
    unlinkSync(path.join(repo, ".aios", "loop", issue, `GATE-${name}.pending.md`));
  } catch {
    /* absent is fine */
  }
}

/** Expand a leading `~/` against the home directory. `path.join` (NOT `path.resolve`) keeps the
 *  home prefix even though the slice leaves a leading slash — pinned by a unit test because a
 *  review claimed otherwise (AIO-239 r1: declined-with-evidence). */
export function expandHomePath(p, home = homedir()) {
  return p.startsWith("~/") || p === "~" ? path.join(home, p.slice(1)) : p;
}

/** Find a `~/.claude/plans/<name>.md` (or absolute) path in planner stdout — the CLI plan runner
 *  writes the FULL plan there and only summarizes on stdout. Capturing the full text into the
 *  pipeline kills a pointer-chasing indirection for the builder and reviewers (AIO-239 R5b). */
export function findPlanFilePath(text) {
  const m = (text ?? "").match(/(?:~|\/[^\s"'`)\]]*)\/\.claude\/plans\/[^\s"'`)\]]+\.md/);
  return m ? m[0] : null;
}

// ── pure helpers (exported for tests) ───────────────────────────────────────────────────────

export function parseShipArgs(args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);

  const valueFlags = ["--reviewers", "--max-fix-rounds", "--plan-runner"];
  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !valueFlags.includes(args[i - 1])
  );
  const issue = positional[0] ?? null;

  const reviewersRaw = flag("--reviewers");
  const reviewers = reviewersRaw
    ? reviewersRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_REVIEWERS];

  const maxFixRaw = parseInt(flag("--max-fix-rounds") ?? String(DEFAULT_MAX_FIX_ROUNDS), 10);
  const maxFixRounds =
    Number.isFinite(maxFixRaw) && maxFixRaw > 0 ? maxFixRaw : DEFAULT_MAX_FIX_ROUNDS;

  const planRunner = flag("--plan-runner") ?? "cli";

  return {
    help: hasFlag("--help") || hasFlag("-h"),
    issue,
    auto: hasFlag("--auto"),
    autoMerge: hasFlag("--auto-merge"),
    reviewers,
    maxFixRounds,
    planRunner,
    dryRun: hasFlag("--dry-run"),
    resume: hasFlag("--resume"),
    approvePlan: hasFlag("--approve-plan"),
    approveMerge: hasFlag("--approve-merge"),
  };
}

// Validate parsed args, returning an error string (→ USAGE) or null.
export function validateShipArgs(opts) {
  if (!opts.issue) return "an issue id is required: aios ship AIO-<n>";
  if (!ISSUE_RE.test(opts.issue))
    return `invalid issue id '${opts.issue}' — expected AIO-<number>.`;
  // Two plan-stage runners (§3.4): `cli` (default) drives the planner via callClaudeAgent, which
  // strips ANTHROPIC_API_KEY and uses Claude Code login auth. `sdk` drives Opus through the
  // Anthropic SDK (relay.mjs's callOpus) and REQUIRES a funded ANTHROPIC_API_KEY — documented
  // caveat, and why cli is the default (the operator/Hermes dotenvx key has no API credits).
  if (opts.planRunner !== "cli" && opts.planRunner !== "sdk")
    return `unsupported --plan-runner '${opts.planRunner}' — expected 'cli' or 'sdk'.`;
  // An explicitly-emptied reviewer list (e.g. `--reviewers ","` or `--reviewers " "`) would
  // silently disable BOTH gating reviewers and wave the PR through — reject it. (A bare
  // `--reviewers ""` still falls back to the defaults in parseShipArgs; this catches the case
  // where a non-empty raw value normalizes to zero names.)
  if (!opts.reviewers.length)
    return `no reviewers resolved — --reviewers must name at least one of ${[...KNOWN_REVIEWERS].join(", ")}.`;
  const unknown = opts.reviewers.filter((r) => !KNOWN_REVIEWERS.has(r));
  if (unknown.length)
    return `unknown reviewer(s) ${unknown.join(", ")} — expected one of ${[...KNOWN_REVIEWERS].join(", ")}.`;
  return null;
}

// Gate decision per phase: 'skip' (auto flag), 'approved' (--approve-* after inspecting a
// pending gate), 'prompt' (interactive TTY), or 'blocked' (non-TTY: run UP TO the gate, persist
// a GATE-<name>.pending.md + state, and exit with the gate code — resumable, never hanging).
export function resolveGates({ auto, autoMerge, approvePlan, approveMerge, isTty }) {
  const decide = (autoFlag, approveFlag) =>
    autoFlag ? "skip" : approveFlag ? "approved" : isTty ? "prompt" : "blocked";
  return { plan: decide(auto, approvePlan), merge: decide(autoMerge, approveMerge) };
}

// build.mjs EXIT → ship codes. Pure; exported.
export function mapBuildExit(buildCode) {
  if (buildCode === BUILD_EXIT.OK) return SHIP_EXIT.OK;
  if (buildCode === BUILD_EXIT.NONCONVERGENCE) return SHIP_EXIT.BUILD_NONCONVERGENCE;
  // NO_DIFF / FATAL / TIMEOUT / GATE_FAILED → non-recoverable build failure.
  return SHIP_EXIT.BUILD_FAILED;
}

// The safety reviewer approves by placing SAFETY_APPROVED alone on the final non-blank line.
export function detectSafetyToken(text) {
  const lastLine =
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  return lastLine === SAFETY_APPROVED_TOKEN;
}

// True iff any changed path equals a listed file or starts with a listed directory prefix.
export function touchesSafetySurface(paths, safetyPaths = SAFETY_PATHS) {
  const list = paths ?? [];
  return list.some((p) => safetyPaths.some((s) => (s.endsWith("/") ? p.startsWith(s) : p === s)));
}

// Parse the plan's `## Deferred (out of scope)` section into a list of normalized titles.
// Tolerates `## Deferred` without the parenthetical; strips checkbox markers; stops at the next
// heading or EOF; drops a lone `none`/empty. Pure; exported.
export function parseDeferredScope(planText, { maxLen = 200 } = {}) {
  const lines = String(planText ?? "").split("\n");
  let inSection = false;
  const titles = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      if (inSection) break; // next heading ends the section
      if (/^#{1,6}\s+deferred\b/i.test(line)) {
        inSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+(.*)$/);
    if (!m) continue;
    let item = m[1].replace(/^\[[ xX]\]\s*/, "").trim();
    if (!item) continue;
    if (/^none\.?$/i.test(item)) continue;
    if (item.length > maxLen) item = item.slice(0, maxLen).trimEnd();
    titles.push(item);
  }
  return titles;
}

// A normalized title for dedup (lowercase, collapsed whitespace, trimmed trailing punctuation).
export function normalizeTitle(t) {
  return String(t ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}

// ── readChecks — survives a non-zero `gh pr checks` exit ─────────────────────────────────────
// `gh pr checks` exits non-zero when checks are pending (8) or failing (1). ghExec must capture
// stdout even on non-zero exit and NEVER throw for this call. Returns a fail-closed verdict:
//   { ok, red, pending, unavailable, raw }. Empty/unparseable stdout → unavailable (→ MERGE_BLOCKED).
export function readChecks(pr, { ghExec, slug } = {}) {
  const argv = [
    "pr",
    "checks",
    String(pr),
    ...(slug ? ["--repo", slug] : []),
    "--json",
    "name,state,bucket",
  ];
  let res;
  try {
    res = ghExec(argv);
  } catch (e) {
    // A ghExec that throws despite the contract is treated as unavailable (fail closed).
    return {
      ok: false,
      unavailable: true,
      red: false,
      pending: false,
      raw: String(e?.message ?? ""),
    };
  }
  const stdout = res?.stdout ?? "";
  const parsed = parseCheckResults(stdout);
  if (!parsed.parsed) {
    // No usable check data (auth/network/no checks yet/malformed) → fail closed.
    return { ok: false, unavailable: true, red: false, pending: false, raw: stdout };
  }
  // An empty check set with no red/pending signal (e.g. `gh pr checks --json` returns `[]`)
  // means CI has reported NO checks — it is NOT proof of green. Treat it as unavailable so the
  // merge gate fails closed rather than waving a PR through on the absence of any CI data.
  if (parsed.checks.length === 0 && !parsed.ciRed && !parsed.ciPending) {
    return { ok: false, unavailable: true, red: false, pending: false, raw: stdout };
  }
  const ok = !parsed.ciRed && !parsed.ciPending;
  return { ok, unavailable: false, red: parsed.ciRed, pending: parsed.ciPending, raw: stdout };
}

// ── dry-run report ───────────────────────────────────────────────────────────────────────────
export function buildShipDryRunReport({
  issue,
  issueTitle,
  resolvedModels,
  gates,
  reviewers,
  planRunner,
  maxFixRounds,
}) {
  const stepLine = (name) => {
    const cfg = resolvedModels?.[name];
    if (!cfg) return `  ${name.padEnd(14)} (no model config)`;
    const bits = [cfg.model];
    if (cfg.effort) bits.push(`effort=${cfg.effort}`);
    if (cfg.timeoutMs) bits.push(`timeout=${cfg.timeoutMs / 1000}s`);
    return `  ${name.padEnd(14)} ${bits.join(" · ")}`;
  };
  const lines = [
    "",
    c.blue(`aios ship — dry-run for ${issue}${issueTitle ? `: ${issueTitle}` : ""}`),
    "",
    "Stages (plan → build → PR → review → fix → merge → cleanup):",
    "  1. recon         Linear + git-tracked files → context pack",
    "  2. plan          plan loop → operator plan gate",
    "  3. follow-up     file `## Deferred` items as Linear children",
    "  4. build         runBuild on an isolated worktree",
    "  5. PR            cmdPr push + open PR",
    "  6. review        wait-for-bots (Bugbot) + GPT review + consolidate",
    "  7. fix loop      re-build until CLEAR or --max-fix-rounds",
    "  8. merge gate    CI + consolidator + path-gated safety review + operator",
    "  9. cleanup       ff-only main → worktree remove → branch delete",
    "",
    "Per-step models:",
    stepLine("recon"),
    stepLine("plan"),
    stepLine("plan_review"),
    stepLine("build"),
    stepLine("code_review"),
    stepLine("consolidate"),
    stepLine("safety_review"),
    "",
    `Plan runner:  ${planRunner}`,
    `Reviewers:    ${(reviewers ?? []).join(", ")} (CodeRabbit swept, never gated on)`,
    `Max fix rounds: ${maxFixRounds}`,
    `Gates:        plan=${gates.plan}  merge=${gates.merge}`,
    "",
    "SHIP_EXIT codes:",
    ...Object.entries(SHIP_EXIT).map(([k, v]) => `  ${String(v).padStart(3)}  ${k}`),
    "",
  ];
  return lines.join("\n");
}

// ── prompt builders ──────────────────────────────────────────────────────────────────────────

const DEFERRED_CONTRACT = [
  "",
  "End your plan with this exact section (empty is allowed — use a single `- none` bullet):",
  "",
  "## Deferred (out of scope)",
  "- <one deferred follow-up per bullet, or `- none`>",
].join("\n");

export function buildReconPrompt(issue, { allowedFiles }) {
  return [
    `You are preparing a recon context pack for Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    "## Issue description",
    "",
    issue.description || "(no description)",
    "",
    "## Referenced repo files (git-tracked only)",
    "",
    allowedFiles.length ? allowedFiles.map((f) => `- ${f}`).join("\n") : "(none)",
    "",
    "Read the referenced files (read-only) and summarize the concrete implementation context a",
    "planner needs: the surfaces involved, the invariants to preserve, and the acceptance criteria.",
    "Do NOT write files. Output the context pack as markdown.",
  ].join("\n");
}

export function buildPlanPrompt(issue, contextPack, prevReview) {
  const parts = [
    `You are a senior software architect. Produce a clear, numbered implementation plan for`,
    `Linear issue ${issue.identifier}: ${issue.title}`,
    "",
    "## Task",
    "",
    issue.description || "(no description)",
    "",
    "## Recon context pack",
    "",
    contextPack || "(none)",
    "",
    "The context pack above was built from the live repo minutes ago — treat it as trusted",
    "ground truth. Do NOT re-explore surfaces it already covers; verify beyond it only where",
    "the plan hinges on a detail it does not settle. Budget your time for writing the plan.",
    DEFERRED_CONTRACT,
  ];
  if (prevReview) {
    parts.push(
      "",
      "## Reviewer feedback on your previous plan (address every Blocker/Major)",
      "",
      prevReview
    );
  }
  return parts.join("\n");
}

export function buildPlanReviewPrompt(plan, round, maxRounds, prevReview = null) {
  const isLast = round >= maxRounds;
  const roundNote = isLast
    ? `**Final round (${round}/${maxRounds}). Approve unless there is a Blocker.**`
    : `Round ${round} of ${maxRounds}.`;
  return [
    "/review-plan",
    "",
    `> ${roundNote}`,
    "",
    "## Plan to review",
    "",
    plan,
    "",
    // Regression guard (AIO-239 R5a): a revision round can silently revert a fix the previous
    // review already demanded and got — the reviewer must re-verify prior acceptances, not just
    // hunt new issues. (Observed live: round 3 reverted two accepted round-1 fixes.)
    ...(prevReview
      ? [
          "## Previously required changes (from the prior review round)",
          "",
          prevReview,
          "",
          "**Regression check: verify EVERY previously required change above is still honored in",
          "this revision. A silently reverted prior fix is a Blocker.**",
          "",
        ]
      : []),
    "---",
    "Review the plan. List any Blockers or approach-level Majors. Minor issues do not block.",
    `When the plan is ready to implement, place this token alone on the very last line:`,
    PLAN_READY_TOKEN,
  ].join("\n");
}

export function buildGptReviewPrompt(plan, prDiff, pr) {
  return [
    "/ai-code-review",
    "",
    `You are reviewing PR #${pr} against the approved plan below. Emit findings as`,
    "`- \\`severity\\` \\`file\\`: …` lines (Critical/High/Medium/Low).",
    "",
    "## Approved plan",
    "",
    plan,
    "",
    "## PR diff",
    "",
    prDiff || "(no diff)",
  ].join("\n");
}

export function buildSafetyPrompt(diff, changedPaths) {
  return [
    "You are a safety reviewer for the AIOS workspace toolkit. The diff below touches a",
    "safety-critical surface (tier model, sync contract, secrets/leak gate, hooks, validators,",
    "or scaffold governance). Confirm EVERY tier/sync/secrets/hook invariant is preserved.",
    "",
    "## Changed safety-surface paths",
    "",
    changedPaths.map((p) => `- ${p}`).join("\n"),
    "",
    "## Diff",
    "",
    diff || "(no diff)",
    "",
    "---",
    `If (and ONLY if) every invariant is preserved, emit ${SAFETY_APPROVED_TOKEN} alone on the`,
    "very last line. Otherwise list what is unsafe and do NOT emit the token.",
  ].join("\n");
}

// ── default dep impls (real side effects) ────────────────────────────────────────────────────

function defaultGitLsFiles(repo) {
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

// gitExec: returns stdout (trimmed); throws on non-zero exit. Used for status/merge/worktree.
function defaultGitExec(argv, cwd) {
  return execFileSync("git", argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// ghExec: returns { code, stdout, stderr } and NEVER throws on non-zero (mirrors readChecks'
// contract — a red/pending `gh pr checks` is data, not a crash).
function defaultGhExec(argv) {
  try {
    const stdout = execFileSync("gh", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return {
      code: e.status ?? 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

// SDK plan-runner deps (--plan-runner sdk). Lazily imported so the default `cli` path never pays
// for (or requires) the Anthropic SDK — only an actual sdk run constructs the client. `callOpus`
// is the same Opus↔SDK planner `aios relay` uses; `makeAnthropic` needs a funded ANTHROPIC_API_KEY.
async function defaultMakeAnthropic() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  return new Anthropic();
}
async function defaultCallOpus(anthropic, messages, planCfg) {
  const { callOpus } = await import("./relay.mjs");
  return callOpus(anthropic, messages, planCfg);
}

function defaultWriteAudit(repo, issue, name, text) {
  try {
    const dir = path.join(repo, ".aios", "loop", issue);
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, name), `${text}\n`);
  } catch {
    /* best-effort — audit never blocks a run */
  }
}

function defaultConfirm(promptText) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${promptText} [y/N] `, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// wait-for-bots exit codes are the interface (see runShip's Bugbot gate): 0 = Bugbot posted,
// 2 = timeout. A real SPAWN failure (script missing, ENOENT, killed by signal) has NO numeric
// exit status — it must NOT be reported as `2` (which runShip treats as a benign timeout and
// proceeds). Return `1` (gate could not run) so the caller fails closed and blocks merge.
// fileURLToPath (not new URL(...).pathname) is used so the path is correct on every platform and
// with spaces/encoded chars in the repo path.
function defaultWaitForBots(argv) {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "wait-for-bots.mjs");
  try {
    execFileSync(process.execPath, [script, ...argv], { stdio: "inherit" });
    return 0;
  } catch (e) {
    // Only a genuine non-zero child exit carries a numeric `status`. Anything else is a spawn
    // failure → surface as `1` (could-not-run), never as the `2` timeout code.
    return typeof e.status === "number" ? e.status : 1;
  }
}

// ── cleanup (exported for the ordering test) ──────────────────────────────────────────────────
// Correct ordering: git refuses to delete a branch checked out in a worktree, so ff-only main
// → worktree remove → prune → THEN branch delete. A dirty primary or a failed ff-only returns
// CLEANUP_FAILED and NEVER issues a reset/merge/clobber.
// Cleanup is BEST-EFFORT since AIO-239: the merge already happened, so nothing here may fail the
// run. Worktree/branch removal always proceeds; the ff-only of the primary checkout is attempted
// only when it cannot clobber operator state (someone else's working files must never turn a
// successful ship into CLEANUP_FAILED — the operator can ff later). Always returns SHIP_EXIT.OK
// with `reason` describing what was done and `ffSkipped`/`ffDone` for callers/tests.
export function runCleanup(deps, { repo, branch, worktreePath }) {
  const { gitExec } = deps;
  const notes = [];

  // Remove the worktree BEFORE deleting the branch (git blocks deleting a checked-out branch).
  try {
    gitExec(["worktree", "remove", "--force", worktreePath], repo);
  } catch {
    notes.push("worktree remove skipped");
  }
  try {
    gitExec(["worktree", "prune"], repo);
  } catch {
    /* best-effort */
  }
  try {
    gitExec(["branch", "-D", branch], repo);
  } catch {
    notes.push("local branch delete skipped (remote deleted at merge)");
  }

  // ff-only the primary checkout — convenience, not a requirement.
  let ffDone = false;
  let ffSkipped = null;
  let status = "";
  try {
    status = gitExec(["status", "--porcelain"], repo) ?? "";
  } catch (e) {
    ffSkipped = `could not read primary status (${e.message})`;
  }
  if (ffSkipped == null && status.trim()) {
    // Dirty primary: git's own checkout safety would refuse an ff that touches modified files,
    // but we skip proactively — never risk another agent's / the operator's in-flight work.
    ffSkipped =
      "primary checkout has local changes — run `git merge --ff-only origin/main` when ready";
  }
  if (ffSkipped == null) {
    try {
      gitExec(["fetch", "origin", "main"], repo);
      gitExec(["merge", "--ff-only", "origin/main"], repo);
      ffDone = true;
    } catch (e) {
      ffSkipped = `ff-only not possible (${e.message}) — resolve manually`;
    }
  }
  if (ffSkipped) notes.push(`ff skipped: ${ffSkipped}`);

  return {
    code: SHIP_EXIT.OK,
    ffDone,
    ffSkipped,
    reason: notes.length ? notes.join("; ") : "cleaned up (worktree, branch, ff)",
  };
}

// ── build opts ─────────────────────────────────────────────────────────────────────────────
function makeBuildOpts({ branch, issue, logFile, findingsFile, verify = SHIP_VERIFY_CMD }) {
  return {
    planSource: null,
    branch,
    isTask: false,
    rounds: 4,
    buildTimeout: 1800 * 1000,
    cursorTimeout: 300 * 1000,
    cursorTimeoutSet: false,
    model: null,
    skill: "/ai-code-review",
    worktreePath: null,
    base: "origin/main",
    verify,
    findingsFile: findingsFile ?? null,
    logFile: logFile ?? null,
    merge: false,
    pr: false,
    issue,
    bugbot: false,
    noBugbot: true,
    noGate: false,
    keepWorktree: true,
    dryRun: false,
    chained: true,
  };
}

const lastNonBlankLine = (text) =>
  (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? "";

// ── orchestration ─────────────────────────────────────────────────────────────────────────────

/**
 * runShip — the testable pipeline core. Every dep is injectable; returns { code, records }.
 * @returns {Promise<{code:number, records:object}>}
 */
export async function runShip({ repo, issue: issueId, opts, deps }) {
  const {
    linear,
    resolveModels,
    runBuild: runBuildDep,
    cmdPr: cmdPrDep,
    cmdConsolidateFindings: consolidateDep,
    callClaudeAgent: claude,
    callCursorAgent: cursor,
    callDeepSeekDirect: deepseek,
    waitForBots,
    gitExec,
    ghExec,
    gitLsFiles,
    statFile,
    readFile,
    confirm,
    isTty,
    writeAudit,
    slug,
    callOpus = defaultCallOpus,
    makeAnthropic = defaultMakeAnthropic,
    readState = () => null,
    writeState = () => {},
    writeGate = () => {},
    removeGate = () => {},
  } = deps;

  const records = { issue: issueId, stages: [] };
  const record = (stage, detail) => records.stages.push({ stage, ...detail });
  const models = resolveModels({ repo });

  // A reviewer model resolves to either the Cursor CLI (cursor-agent --model <x>) or
  // DeepSeek's own API — the dispatch is by model family, not a hardcoded backend.
  const reviewCall =
    (model) =>
    (prompt, timeoutMs, opts = {}) =>
      modelFamily(model) === "deepseek"
        ? deepseek(prompt, timeoutMs, { model })
        : cursor(prompt, timeoutMs, opts);
  const gates = resolveGates({
    auto: opts.auto,
    autoMerge: opts.autoMerge,
    approvePlan: opts.approvePlan,
    approveMerge: opts.approveMerge,
    isTty,
  });

  // Checkpoint state (AIO-239): `--resume` re-enters at the first incomplete stage. A blocked
  // gate no longer exits before recon — ship runs UP TO the gate, persists everything needed to
  // judge it (audit dir + GATE-<name>.pending.md + state.json), and exits with the gate code.
  const state = (opts.resume ? readState(issueId) : null) ?? {};
  const saveState = (patch) => {
    Object.assign(state, patch);
    writeState(issueId, state);
  };
  const progress = (msg) => console.log(c.blue(`ship: ${msg}`));

  // ── 1. RECON ───────────────────────────────────────────────────────────────
  let issue;
  try {
    issue = await linear.getIssue(issueId, { full: true });
    if (!issue) throw new Error(`issue not found: ${issueId}`);
  } catch (e) {
    record("recon", { error: e.message });
    console.error(c.red(`recon: could not fetch ${issueId}: ${e.message}`));
    return { code: SHIP_EXIT.RECON_FAILED, records };
  }
  writeAudit(
    issueId,
    "task.md",
    `# ${issue.identifier}: ${issue.title}\n\n${issue.description || ""}`
  );

  const trackedFiles = gitLsFiles(repo);
  const commentText = (issue.comments ?? []).map((cm) => cm.body).join("\n");
  const CONTRACT_CHECKLIST = ["docs/brain-api.md", "docs/ENGINEERING-CONSTITUTION.md"];
  const issueText = `${issue.description || ""}\n${commentText}\n${CONTRACT_CHECKLIST.map((f) => `\`${f}\``).join(" ")}`;
  const { allowed, skipped } = extractRepoFileRefs(issueText, {
    trackedFiles,
    statFile: (rel) => {
      try {
        return statFile(path.join(repo, rel)).size;
      } catch {
        return 0;
      }
    },
  });
  writeAudit(
    issueId,
    "recon-skipped.md",
    `# Skipped file references (path + reason only; contents never read)\n\n` +
      (skipped.length ? skipped.map((s) => `- \`${s.raw}\` — ${s.reason}`).join("\n") : "(none)")
  );

  let recon = "";
  if (state.recon) {
    recon = state.recon;
    record("recon", { resumed: true });
    progress("recon: resumed from checkpoint");
  }
  const reconStartedAt = Date.now();
  if (!state.recon)
    try {
      // Read ONLY allowed (tracked, non-denied) files — audit the rest by path+reason only.
      const fileBlobs = allowed.map((rel) => {
        let body = "";
        try {
          body = readFile(path.join(repo, rel));
        } catch {
          body = "(unreadable)";
        }
        return `### ${rel}\n\n${body.slice(0, 8000)}`;
      });
      const reconPrompt =
        buildReconPrompt(issue, { allowedFiles: allowed }) +
        (fileBlobs.length ? `\n\n## File contents\n\n${fileBlobs.join("\n\n")}` : "");
      const cfg = models.recon;
      // Recon runs with NO tools: the untrusted Linear text is in the prompt, and the only files it
      // may see are the pre-vetted `allowed` blobs already injected above. A prompt-injection payload
      // therefore cannot make recon read anything outside the tracked-only allow list.
      recon = await claude(reconPrompt, cfg.timeoutMs ?? 300 * 1000, {
        model: cfg.model,
        extraArgs: [...NO_TOOLS_ARGS, ...(cfg.effort ? ["--effort", cfg.effort] : [])],
      });
      writeAudit(issueId, "recon.md", recon);
      record("recon", { allowed: allowed.length, skipped: skipped.length });
      saveState({ recon });
      progress("recon: done");
    } catch (e) {
      record("recon", { error: e.message });
      writeAudit(issueId, "recon-FAILED.md", failedArtifact("recon", e, reconStartedAt));
      if (e?.partial) writeAudit(issueId, "recon-PARTIAL.md", e.partial); // AIO-239 R4a
      console.error(c.red(`recon: model step failed: ${e.message}`));
      return { code: SHIP_EXIT.RECON_FAILED, records };
    }

  // ── 2. PLAN ────────────────────────────────────────────────────────────────
  const PLAN_ROUNDS = 3;
  let plan = null;
  let approved = false;
  let prevReview = null;
  const planCfg = models.plan;
  const planReviewCfg = models.plan_review;
  // Plan-stage runner (§3.4). `cli` (default): callClaudeAgent under --permission-mode plan; it
  // strips ANTHROPIC_API_KEY so the CLI uses Claude Code login auth. `sdk`: Opus via the Anthropic
  // SDK (relay.mjs's callOpus), which requires a funded ANTHROPIC_API_KEY. The Cursor plan review
  // (below) is identical for both runners. The Anthropic client is constructed once, lazily, only
  // when the sdk runner is selected — the cli path never touches the SDK.
  let generatePlan;
  if (opts.planRunner === "sdk") {
    const anthropic = await makeAnthropic();
    generatePlan = (prompt) => callOpus(anthropic, [{ role: "user", content: prompt }], planCfg);
  } else {
    generatePlan = (prompt) =>
      claude(prompt, planCfg.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS, {
        model: planCfg.model,
        extraArgs: [
          "--permission-mode",
          "plan",
          ...(planCfg.effort ? ["--effort", planCfg.effort] : []),
        ],
      });
  }
  if (state.plan && state.planReviewed) {
    plan = state.plan;
    approved = true;
    record("plan", { resumed: true });
    progress("plan: resumed from checkpoint (reviewer-approved)");
  } else {
    progress("plan: loop started");
    for (let round = 1; round <= PLAN_ROUNDS; round++) {
      const planPrompt = buildPlanPrompt(issue, recon, prevReview);
      const planStartedAt = Date.now();
      try {
        plan = await generatePlan(planPrompt);
      } catch (e) {
        record("plan", { error: e.message });
        writeAudit(issueId, `plan-r${round}-FAILED.md`, failedArtifact("plan", e, planStartedAt));
        if (e?.partial) writeAudit(issueId, `plan-r${round}-PARTIAL.md`, e.partial); // AIO-239 R4a
        console.error(c.red(`plan: builder failed: ${e.message}`));
        return { code: SHIP_EXIT.PLAN_UNAPPROVED, records };
      }
      // The cli plan runner writes the FULL plan to ~/.claude/plans/<name>.md and only summarizes
      // on stdout. Capture the full text INLINE so the reviewer, the plan gate, and the builder
      // all see the real plan instead of chasing a pointer (AIO-239 R5b).
      const planFilePath = findPlanFilePath(plan);
      if (planFilePath) {
        try {
          const abs = expandHomePath(planFilePath);
          const full = readFile(abs);
          if (full && full.trim()) {
            plan += `\n\n## Full plan (captured from ${planFilePath})\n\n${full}`;
          }
        } catch {
          /* pointer without a readable file — the summary still stands */
        }
      }
      writeAudit(issueId, `plan-r${round}.md`, plan);
      const reviewPrompt = buildPlanReviewPrompt(plan, round, PLAN_ROUNDS, prevReview);
      const reviewStartedAt = Date.now();
      let review;
      try {
        review = await reviewCall(planReviewCfg.model)(
          reviewPrompt,
          planReviewCfg.timeoutMs ?? 300 * 1000,
          {
            extraArgs: [
              "--force",
              "--trust",
              ...(planReviewCfg.model ? ["--model", planReviewCfg.model] : []),
            ],
          }
        );
      } catch (e) {
        record("plan", { error: e.message });
        writeAudit(
          issueId,
          `plan-review-r${round}-FAILED.md`,
          failedArtifact("plan review", e, reviewStartedAt)
        );
        console.error(c.red(`plan: reviewer failed: ${e.message}`));
        return { code: SHIP_EXIT.PLAN_UNAPPROVED, records };
      }
      writeAudit(issueId, `plan-review-r${round}.md`, review);
      if (lastNonBlankLine(review) === PLAN_READY_TOKEN) {
        approved = true;
        break;
      }
      prevReview = review;
    }
    if (!approved) {
      record("plan", { unapproved: true });
      console.error(c.yellow(`plan: spent ${PLAN_ROUNDS} rounds without ${PLAN_READY_TOKEN}.`));
      return { code: SHIP_EXIT.PLAN_UNAPPROVED, records };
    }
    writeAudit(issueId, "plan.md", `## Approved plan\n\n${plan}`);
    saveState({ plan, planReviewed: true, planApproved: false });
    progress("plan: reviewer approved (PLAN_READY)");
  }

  // Plan gate — 'skip' (--auto), 'approved' (--approve-plan on a resumed run), 'prompt'
  // (interactive), or 'blocked' (non-TTY: persist the gate + state and exit resumable).
  if (!state.planApproved) {
    if (gates.plan === "blocked" || (gates.plan === "approved" && !state.planGatePending)) {
      // "approved" without a pending gate (fresh run with --approve-plan, or stale state) must
      // NOT wave the plan through: there was nothing inspected to approve (review r1, Medium).
      if (gates.plan === "approved") {
        console.error(
          c.yellow(
            "plan gate: --approve-plan given but no pending gate exists — treating as pending; " +
              "inspect it, then resume with --resume --approve-plan."
          )
        );
      }
      record("plan-gate", { blocked: true });
      saveState({ planGatePending: true });
      console.log("SHIP_GATE plan pending"); // machine-greppable marker (AIO-239 R7c)
      writeGate(
        issueId,
        "plan",
        [
          `# PLAN gate pending — ${issueId}`,
          "",
          "The reviewer-approved plan is below (also at plan.md in this directory).",
          "",
          "To approve and continue:  aios ship " + issueId + " --resume --approve-plan",
          "To reject: discard the worktree/state or re-run without --resume for a fresh plan.",
          "",
          "---",
          "",
          plan,
        ].join("\n")
      );
      console.error(
        c.yellow(
          `plan gate: pending operator approval — inspect .aios/loop/${issueId}/GATE-plan.pending.md, ` +
            `then resume with --resume --approve-plan.`
        )
      );
      return { code: SHIP_EXIT.PLAN_GATE_BLOCKED, records };
    }
    if (gates.plan === "prompt") {
      console.log("SHIP_GATE plan pending"); // marker precedes the prompt (AIO-239 R7c)
      const ok = await confirm("Approve this plan and proceed to build?");
      if (!ok) {
        record("plan-gate", { rejected: true });
        return { code: SHIP_EXIT.PLAN_REJECTED, records };
      }
    } else if (gates.plan === "approved") {
      record("plan-gate", { approvedViaFlag: true });
      progress("plan gate: approved via --approve-plan");
    }
    saveState({ planApproved: true, planGatePending: false });
    removeGate(issueId, "plan");
  }

  // ── 3. FOLLOW-UP CAPTURE ─────────────────────────────────────────────────────
  if (state.followUpDone) {
    record("follow-up", { resumed: true });
  } else {
    const deferred = parseDeferredScope(plan);
    const existingChildTitles = new Set(
      (issue.children ?? []).map((ch) => normalizeTitle(ch.title))
    );
    const created = [];
    for (const title of deferred) {
      if (existingChildTitles.has(normalizeTitle(title))) continue;
      try {
        const child = await linear.createIssue({
          title,
          description: `Deferred from ${issue.identifier} during \`aios ship\`.`,
          parentIdentifier: issue.identifier,
        });
        created.push(child.identifier);
        existingChildTitles.add(normalizeTitle(title));
      } catch (e) {
        console.error(c.yellow(`follow-up: could not file '${title}': ${e.message}`));
      }
    }
    writeAudit(
      issueId,
      "deferred.md",
      `# Deferred follow-ups\n\n` +
        (deferred.length ? deferred.map((t) => `- ${t}`).join("\n") : "(none)") +
        `\n\nCreated: ${created.join(", ") || "(none)"}`
    );
    record("follow-up", { deferred: deferred.length, created: created.length });
    saveState({ followUpDone: true });
  }

  // ── 4. BUILD ─────────────────────────────────────────────────────────────────
  // On resume, the CHECKPOINTED branch/worktree win: recomputing from the Linear title would
  // silently retarget every later stage if the title was edited between runs (review r1, High).
  const branch = state.branch ?? `feat/${issue.identifier}-${slugify(issue.title)}`;
  const worktreePath =
    state.worktreePath ?? path.resolve(repo, "..", `${path.basename(repo)}-${slugify(branch)}`);
  const auditDir = path.join(repo, ".aios", "loop", issueId);
  const buildLog = path.join(auditDir, "build.md");
  if (state.buildDone) {
    record("build", { resumed: true, branch });
    progress(`build: resumed from checkpoint (branch ${branch})`);
  } else {
    progress("build: started");
    let buildCode;
    try {
      buildCode = await runBuildDep({
        repo,
        plan,
        branch,
        opts: makeBuildOpts({ branch, issue: issueId, logFile: buildLog }),
      });
    } catch (e) {
      record("build", { error: e.message });
      writeAudit(issueId, "build-FAILED.md", failedArtifact("build", e));
      console.error(c.red(`build: ${e.message}`));
      return { code: SHIP_EXIT.BUILD_FAILED, records };
    }
    const mapped = mapBuildExit(buildCode);
    if (mapped !== SHIP_EXIT.OK) {
      record("build", { buildCode, mapped });
      return { code: mapped, records };
    }
    record("build", { branch });
    saveState({ buildDone: true, branch, worktreePath });
    progress("build: done");
  }

  // ── 5. PR ────────────────────────────────────────────────────────────────────
  let prNumber;
  if (state.prNumber) {
    prNumber = state.prNumber;
    record("pr", { resumed: true, pr: prNumber });
    progress(`pr: resumed from checkpoint (#${prNumber})`);
  } else {
    try {
      prNumber = await cmdPrDep(repo, ["--branch", branch, "--issue", issue.identifier], {
        throwOnError: true,
      });
    } catch (e) {
      record("pr", { error: e.message });
      writeAudit(issueId, "pr-FAILED.md", failedArtifact("pr", e));
      console.error(c.red(`pr: ${e.message}`));
      return { code: SHIP_EXIT.PR_FAILED, records };
    }
    if (!prNumber) {
      record("pr", { error: "no PR number" });
      return { code: SHIP_EXIT.PR_FAILED, records };
    }
    record("pr", { pr: prNumber });
    saveState({ prNumber });
    progress(`pr: opened #${prNumber}`);
  }

  // ── 6 + 7. REVIEW + FIX LOOP ──────────────────────────────────────────────────
  // --reviewers selects which gating reviewers actually run (validated against KNOWN_REVIEWERS).
  const wantBugbot = opts.reviewers.includes("bugbot");
  const wantGpt = opts.reviewers.includes("gpt-5.5");
  let round = state.reviewRound ?? 1;
  // A resumed CLEAR is honored only if the branch head hasn't moved since the review round that
  // cleared it — new commits after the checkpoint must re-run the reviewers (review r1, Medium).
  if (state.reviewClear) {
    let headNow = null;
    try {
      headNow = (gitExec(["rev-parse", branch], repo) ?? "").trim() || null;
    } catch {
      headNow = null;
    }
    if (!headNow || headNow !== state.reviewHead) {
      progress("review: checkpointed CLEAR is stale (branch moved) — re-running the review round");
      saveState({ reviewClear: false, reviewHead: null });
      state.reviewClear = false;
    }
  }
  if (state.reviewClear) {
    record("review", { resumed: true, clear: true });
    progress("review: resumed from checkpoint (already CLEAR)");
  } else
    for (;;) {
      saveState({ reviewRound: round });
      progress(`review: round ${round} started`);
      // (a) Bugbot gate. Skipped ONLY if the operator explicitly dropped "bugbot" from --reviewers.
      // Pass the resolved GitHub slug so wait-for-bots targets the right repo even under `ship
      // --repo <path>` (its own git-remote detection runs in the primary checkout, not the slug).
      // Exit codes (wait-for-bots.mjs): 0 = Bugbot posted; 2 = timeout; anything else = the gate
      // could not run. A requested reviewer whose evidence is NOT present must fail closed — a
      // timeout means the consolidator would otherwise CLEAR without Bugbot's findings and merge
      // before a late Critical/High appears. So ANY non-zero (timeout INCLUDED) blocks merge.
      if (wantBugbot) {
        const wfbCode = waitForBots([
          "--pr",
          String(prNumber),
          ...(slug ? ["--repo", slug] : []),
          "--bots",
          "cursor[bot]",
          "--timeout",
          "10",
        ]);
        if (wfbCode !== 0) {
          record("review", { round, bugbotUnavailable: wfbCode });
          const why = wfbCode === 2 ? "timed out" : `exited ${wfbCode} (gate could not run)`;
          console.error(
            c.red(
              `review: Bugbot review unavailable — wait-for-bots ${why}; blocking merge ` +
                `(drop it via --reviewers to skip it intentionally).`
            )
          );
          return { code: SHIP_EXIT.MERGE_BLOCKED, records };
        }
      }

      // (b) GPT-5.5 PR review via Cursor. Skipped ONLY if the operator dropped "gpt-5.5". A
      // requested GPT review that fails (or has no diff to review) is missing reviewer evidence —
      // fail closed rather than consolidate without it.
      let gptReviewFile = null;
      if (wantGpt) {
        try {
          const diffRes = ghExec([
            "pr",
            "diff",
            String(prNumber),
            ...(slug ? ["--repo", slug] : []),
          ]);
          const prDiff = diffRes?.stdout ?? "";
          if (diffRes?.code !== 0 || !prDiff.trim()) {
            record("review", { round, gptDiffUnavailable: true, code: diffRes?.code });
            console.error(
              c.red(
                "review: PR diff unavailable for the GPT review — blocking merge (fail closed)."
              )
            );
            return { code: SHIP_EXIT.MERGE_BLOCKED, records };
          }
          const gptCfg = models.code_review;
          const gptReview = await reviewCall(gptCfg.model)(
            buildGptReviewPrompt(plan, prDiff, prNumber),
            gptCfg.timeoutMs ?? 300 * 1000,
            {
              extraArgs: ["--force", "--trust", ...(gptCfg.model ? ["--model", gptCfg.model] : [])],
            }
          );
          writeAudit(issueId, `review-gpt-r${round}.md`, gptReview);
          gptReviewFile = path.join(auditDir, `review-gpt-r${round}.md`);
        } catch (e) {
          record("review", { round, gptReviewError: e.message });
          writeAudit(issueId, `review-gpt-r${round}-FAILED.md`, failedArtifact("GPT review", e));
          console.error(
            c.red(`review: GPT review failed (${e.message}) — blocking merge (requested reviewer).`)
          );
          return { code: SHIP_EXIT.MERGE_BLOCKED, records };
        }
      }

      // (c) Consolidate.
      const consolidateArgs = [
        "--pr",
        String(prNumber),
        "--issue",
        issue.identifier,
        "--round",
        String(round),
      ];
      if (gptReviewFile) consolidateArgs.push("--gpt-review", gptReviewFile);
      if (slug) consolidateArgs.push("--repo", slug);
      const verdictCode = await consolidateDep(repo, consolidateArgs);
      record("review", { round, verdictCode });

      if (verdictCode === 0) {
        let reviewHead = null;
        try {
          reviewHead = (gitExec(["rev-parse", branch], repo) ?? "").trim() || null;
        } catch {
          reviewHead = null; // unknown head → a resume will conservatively re-review
        }
        saveState({ reviewClear: true, reviewHead });
        progress(`review: round ${round} CLEAR`);
        break; // CLEAR → merge gate
      }
      if (verdictCode !== 3) {
        // 1 (error) or unknown → cannot proceed to merge.
        console.error(c.red(`review: consolidator returned ${verdictCode} — blocking merge.`));
        return { code: SHIP_EXIT.MERGE_BLOCKED, records };
      }
      // BLOCKED → fix, unless we're out of rounds. `round` counts review passes starting at 1, so
      // the guard is `round > maxFixRounds`: with --max-fix-rounds 1 the first BLOCKED review (round
      // 1) still gets ONE fix attempt; nonconvergence only trips once we've spent all N fix rounds.
      if (round > opts.maxFixRounds) {
        record("fix", { nonconvergence: true, round });
        console.error(
          c.red(`review: still BLOCKED after ${opts.maxFixRounds} fix round(s) — no partial merge.`)
        );
        return { code: SHIP_EXIT.REVIEW_NONCONVERGENCE, records };
      }
      const findingsFile = defaultOutPath(repo, issue.identifier, round);
      let fixCode;
      try {
        fixCode = await runBuildDep({
          repo,
          plan,
          branch,
          opts: makeBuildOpts({ branch, issue: issueId, logFile: buildLog, findingsFile }),
        });
      } catch (e) {
        record("fix", { error: e.message });
        writeAudit(issueId, `fix-r${round}-FAILED.md`, failedArtifact("fix build", e));
        return { code: SHIP_EXIT.BUILD_FAILED, records };
      }
      const fixMapped = mapBuildExit(fixCode);
      if (fixMapped !== SHIP_EXIT.OK) {
        record("fix", { fixCode, mapped: fixMapped });
        return { code: fixMapped, records };
      }
      // Re-push the fixes onto the existing PR.
      try {
        await cmdPrDep(repo, ["--branch", branch, "--issue", issue.identifier], {
          throwOnError: true,
        });
      } catch (e) {
        record("fix", { error: e.message });
        writeAudit(issueId, `fix-push-r${round}-FAILED.md`, failedArtifact("fix push", e));
        return { code: SHIP_EXIT.PR_FAILED, records };
      }
      round++;
    }

  // ── 8. MERGE GATE ──────────────────────────────────────────────────────────────
  // (AIO-239) A dirty primary checkout no longer blocks the merge: the merge happens on GitHub,
  // and the post-merge ff-only is best-effort convenience (see runCleanup) — another agent's or
  // the operator's in-flight working files must never veto a reviewed, CI-green PR.
  // A checkpointed `merged` short-circuits the gate AND the merge: re-attempting `gh pr merge`
  // on an already-merged PR fails and would block cleanup (review r1, High).
  if (state.merged) {
    record("merge", { resumed: true, pr: prNumber });
    progress(`merge: resumed from checkpoint (PR #${prNumber} already merged)`);
  } else {
    // CI green.
    const checks = readChecks(prNumber, { ghExec, slug });
    if (!checks.ok) {
      record("merge-gate", { ci: checks });
      console.error(
        c.red(
          `merge gate: CI not green (${checks.unavailable ? "unavailable" : checks.red ? "red" : "pending"}).`
        )
      );
      return { code: SHIP_EXIT.MERGE_BLOCKED, records };
    }

    // Path-gated safety review. Changed-path metadata is REQUIRED to decide whether the safety
    // surface is touched — if `gh pr diff --name-only` fails (non-zero code or empty stdout) we
    // cannot rule the surface out, so we fail closed rather than treat "no data" as "no safety
    // surface". ghExec returns {code,stdout,stderr} without throwing; check code explicitly.
    let nameRes;
    try {
      nameRes = ghExec([
        "pr",
        "diff",
        String(prNumber),
        ...(slug ? ["--repo", slug] : []),
        "--name-only",
      ]);
    } catch (e) {
      nameRes = { code: 1, stdout: "", stderr: String(e?.message ?? "") };
    }
    const nameStdout = nameRes?.stdout ?? "";
    if (nameRes?.code !== 0 || !nameStdout.trim()) {
      record("merge-gate", { changedPathsUnavailable: true, code: nameRes?.code });
      console.error(
        c.red(
          "merge gate: changed-path metadata unavailable — cannot verify safety surface; blocking."
        )
      );
      return { code: SHIP_EXIT.MERGE_BLOCKED, records };
    }
    const changedPaths = nameStdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (touchesSafetySurface(changedPaths)) {
      try {
        const diffRes = ghExec(["pr", "diff", String(prNumber), ...(slug ? ["--repo", slug] : [])]);
        // The safety reviewer's ENTIRE input is this diff. If the full `gh pr diff` failed (non-zero)
        // or returned empty content, we would be asking it to approve `(no diff)` as green — fail
        // closed instead. `--name-only` succeeding above does NOT prove the full diff fetch works.
        if (diffRes?.code !== 0 || !(diffRes.stdout ?? "").trim()) {
          record("merge-gate", { safetyDiffUnavailable: true, code: diffRes?.code });
          console.error(
            c.red(
              "merge gate: safety-surface diff unavailable — cannot run the safety review; blocking."
            )
          );
          return { code: SHIP_EXIT.SAFETY_BLOCKED, records };
        }
        const cfg = models.safety_review;
        const safety = await claude(
          buildSafetyPrompt(diffRes.stdout, changedPaths),
          cfg.timeoutMs ?? 300 * 1000,
          {
            model: cfg.model,
            // Same no-tools stance as recon: the diff is fully injected, so the safety reviewer
            // never needs (and must not have) filesystem access over untrusted diff content.
            extraArgs: [...NO_TOOLS_ARGS, ...(cfg.effort ? ["--effort", cfg.effort] : [])],
          }
        );
        writeAudit(issueId, "safety-review.md", safety);
        if (!detectSafetyToken(safety)) {
          record("merge-gate", { safetyBlocked: true });
          console.error(c.red("merge gate: safety review withheld approval."));
          return { code: SHIP_EXIT.SAFETY_BLOCKED, records };
        }
      } catch (e) {
        record("merge-gate", { safetyError: e.message });
        writeAudit(issueId, "safety-review-FAILED.md", failedArtifact("safety review", e));
        console.error(c.red(`merge gate: safety review failed (${e.message}) — failing closed.`));
        return { code: SHIP_EXIT.SAFETY_BLOCKED, records };
      }
    }

    // Operator OK — 'skip' (--auto-merge), 'approved' (--approve-merge on a resumed run), 'prompt'
    // (interactive), or 'blocked' (non-TTY: persist the gate + state and exit resumable).
    if (gates.merge === "blocked" || (gates.merge === "approved" && !state.mergeGatePending)) {
      if (gates.merge === "approved") {
        console.error(
          c.yellow(
            "merge gate: --approve-merge given but no pending gate exists — treating as pending; " +
              "inspect PR #" +
              prNumber +
              ", then resume with --resume --approve-merge."
          )
        );
      }
      record("merge-gate", { blocked: true });
      saveState({ mergeGatePending: true });
      console.log("SHIP_GATE merge pending"); // machine-greppable marker (AIO-239 R7c)
      writeGate(
        issueId,
        "merge",
        [
          `# MERGE gate pending — ${issueId} (PR #${prNumber})`,
          "",
          "CI is green, the consolidator is CLEAR, and the safety review (if triggered) approved.",
          "",
          "To merge and clean up:  aios ship " + issueId + " --resume --approve-merge",
          "To reject: close the PR (gh pr close " + prNumber + ") and remove the worktree.",
        ].join("\n")
      );
      console.error(
        c.yellow(
          `merge gate: pending operator approval — inspect PR #${prNumber}, then resume with ` +
            `--resume --approve-merge.`
        )
      );
      return { code: SHIP_EXIT.MERGE_GATE_BLOCKED, records };
    }
    if (gates.merge === "prompt") {
      console.log("SHIP_GATE merge pending"); // marker precedes the prompt (AIO-239 R7c)
      const ok = await confirm(`Merge PR #${prNumber} for ${issue.identifier}?`);
      if (!ok) {
        record("merge-gate", { rejected: true });
        return { code: SHIP_EXIT.MERGE_REJECTED, records };
      }
    } else if (gates.merge === "approved") {
      record("merge-gate", { approvedViaFlag: true });
      progress("merge gate: approved via --approve-merge");
    }
    saveState({ mergeGatePending: false });
    removeGate(issueId, "merge");

    // Merge (squash + delete remote branch). ghExec returns {code,stdout,stderr} WITHOUT throwing,
    // so a failed `gh pr merge` must be caught by checking code — never assume success. A failed
    // merge blocks and, critically, never advances to cleanup (which would remove the worktree/branch).
    let mergeRes;
    try {
      mergeRes = ghExec([
        "pr",
        "merge",
        String(prNumber),
        ...(slug ? ["--repo", slug] : []),
        "--squash",
        "--delete-branch",
      ]);
    } catch (e) {
      mergeRes = { code: 1, stdout: "", stderr: String(e?.message ?? "") };
    }
    if (mergeRes?.code !== 0) {
      record("merge", { error: mergeRes?.stderr || "gh pr merge failed", code: mergeRes?.code });
      console.error(
        c.red(`merge: gh pr merge failed (code ${mergeRes?.code}): ${mergeRes?.stderr || ""}`)
      );
      return { code: SHIP_EXIT.MERGE_BLOCKED, records };
    }
    record("merge", { pr: prNumber });
    saveState({ merged: true });
  } // end !state.merged

  // ── 9. CLEANUP (best-effort — the ship already succeeded; see runCleanup) ───────
  const cleanup = runCleanup(deps, { repo, branch, worktreePath });
  record("cleanup", cleanup);
  if (cleanup.ffSkipped) console.log(c.yellow(`cleanup: ${cleanup.reason}`));
  else progress(`cleanup: ${cleanup.reason}`);

  writeAudit(
    issueId,
    "ship-transcript.md",
    `# ship ${issue.identifier}\n\n` +
      records.stages.map((s) => `- ${JSON.stringify(s)}`).join("\n")
  );
  console.log(c.green(`\n✓ shipped ${issue.identifier} (PR #${prNumber}).`));
  return { code: SHIP_EXIT.OK, records };
}

// ── CLI entry point ─────────────────────────────────────────────────────────────────────────

function usage() {
  console.log(
    [
      "",
      c.blue("aios ship — run the whole gated loop for one Linear issue"),
      "",
      "usage:",
      "  aios ship AIO-<n> [options]",
      "",
      "options:",
      "  --auto                 skip the plan gate (plan proceeds without operator OK)",
      "  --auto-merge           skip the merge gate (merge proceeds without operator OK)",
      "  --reviewers <list>     gating reviewers (default: bugbot,gpt-5.5; CodeRabbit advisory)",
      "  --max-fix-rounds N     outer review→fix cycles (default: 3)",
      "  --plan-runner cli|sdk  plan-stage runner (default: cli — Claude Code login auth; sdk drives",
      "                         Opus via the Anthropic SDK and needs a funded ANTHROPIC_API_KEY)",
      "  --dry-run              print the resolved step plan; no side effects (a resolvable",
      "                         LINEAR_API_KEY only enables a best-effort issue-title fetch)",
      "  --resume               re-enter at the first incomplete stage (state.json checkpoint)",
      "  --approve-plan         satisfy a pending PLAN gate (use with --resume after inspecting",
      "                         .aios/loop/<issue>/GATE-plan.pending.md)",
      "  --approve-merge        satisfy a pending MERGE gate (use with --resume)",
      "",
      "Gates default ON. In a non-TTY context without the matching flag, ship runs UP TO the",
      "gate, persists GATE-<name>.pending.md + state.json, and exits with the gate code —",
      "resumable, never hanging. See docs/agent-build.md for the full SHIP_EXIT table.",
    ].join("\n")
  );
}

/**
 * cmdShip(repo, args, deps={}) → numeric exit code (SHIP_EXIT). Dispatch owns process.exit.
 */
export async function cmdShip(repo, args, deps = {}) {
  const opts = parseShipArgs(args);
  if (opts.help) {
    usage();
    return SHIP_EXIT.OK;
  }
  const err = validateShipArgs(opts);
  if (err) {
    console.error(c.red(`error: ${err}`));
    return SHIP_EXIT.USAGE;
  }

  let models;
  try {
    models = resolveLoopModels({ repo });
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return SHIP_EXIT.USAGE;
  }
  const isTty = deps.isTty ?? Boolean(process.stdout.isTTY);
  const gates = resolveGates({
    auto: opts.auto,
    autoMerge: opts.autoMerge,
    approvePlan: opts.approvePlan,
    approveMerge: opts.approveMerge,
    isTty,
  });

  // --dry-run: no side effects, no required network. A resolvable key makes fetching the issue
  // title a best-effort nicety.
  if (opts.dryRun) {
    let issueTitle = null;
    const apiKey = resolveLinearApiKey(repo);
    if (apiKey) {
      try {
        const linear = createLinearClient({ apiKey });
        const iss = await linear.getIssue(opts.issue);
        issueTitle = iss?.title ?? null;
      } catch {
        /* best-effort — dry-run works offline */
      }
    }
    console.log(
      buildShipDryRunReport({
        issue: opts.issue,
        issueTitle,
        resolvedModels: models,
        gates,
        reviewers: opts.reviewers,
        planRunner: opts.planRunner,
        maxFixRounds: opts.maxFixRounds,
      })
    );
    return SHIP_EXIT.OK;
  }

  // (AIO-239) Blocked gates no longer short-circuit before recon: a non-TTY run without the
  // matching --auto/--approve-* flag runs UP TO the gate, persists the audit trail + a
  // GATE-<name>.pending.md + state.json, and exits with the gate code — resumable via
  // `--resume --approve-plan` / `--approve-merge`. Unattended callers that want no gates at all
  // keep using --auto/--auto-merge (the cron/roadmap-run pattern, unchanged).

  // The sdk plan runner drives Opus through the Anthropic SDK, which needs a funded
  // ANTHROPIC_API_KEY. A missing key is detectable up front — fail cleanly here rather than let the
  // SDK throw mid-plan. (Credit exhaustion on a present key can only surface at call time.)
  if (opts.planRunner === "sdk" && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      c.red(
        "error: --plan-runner sdk requires a funded ANTHROPIC_API_KEY (Opus via the Anthropic SDK). " +
          "Use the default --plan-runner cli (Claude Code login auth) or set ANTHROPIC_API_KEY."
      )
    );
    return SHIP_EXIT.USAGE;
  }

  // Real run: build the default dep set (each overridable via deps).
  const apiKey = resolveLinearApiKey(repo);
  if (!apiKey && !deps.linear) {
    console.error(
      c.red(
        "error: LINEAR_API_KEY is not set — required for `aios ship` (use --dry-run to preview offline)."
      )
    );
    return SHIP_EXIT.USAGE;
  }
  const slug = deps.slug ?? detectRepo(repo);
  const fullDeps = {
    linear: deps.linear ?? createLinearClient({ apiKey }),
    resolveModels: deps.resolveModels ?? resolveLoopModels,
    runBuild: deps.runBuild ?? runBuild,
    cmdPr: deps.cmdPr ?? cmdPr,
    cmdConsolidateFindings: deps.cmdConsolidateFindings ?? cmdConsolidateFindings,
    callClaudeAgent: deps.callClaudeAgent ?? callClaudeAgent,
    callCursorAgent: deps.callCursorAgent ?? callCursorAgent,
    callDeepSeekDirect: deps.callDeepSeekDirect ?? callDeepSeekDirect,
    waitForBots: deps.waitForBots ?? defaultWaitForBots,
    gitExec: deps.gitExec ?? defaultGitExec,
    ghExec: deps.ghExec ?? defaultGhExec,
    gitLsFiles: deps.gitLsFiles ?? defaultGitLsFiles,
    statFile: deps.statFile ?? ((p) => statSync(p)),
    readFile: deps.readFile ?? ((p) => readFileSync(p, "utf8")),
    confirm: deps.confirm ?? defaultConfirm,
    isTty,
    writeAudit:
      deps.writeAudit ?? ((issue, name, text) => defaultWriteAudit(repo, issue, name, text)),
    readState: deps.readState ?? ((issue) => defaultReadState(repo, issue)),
    writeState: deps.writeState ?? ((issue, st) => defaultWriteState(repo, issue, st)),
    writeGate: deps.writeGate ?? ((issue, name, text) => defaultWriteGate(repo, issue, name, text)),
    removeGate: deps.removeGate ?? ((issue, name) => defaultRemoveGate(repo, issue, name)),
    slug,
  };

  const { code } = await runShip({ repo, issue: opts.issue, opts, deps: fullDeps });
  return code;
}
