#!/usr/bin/env node
/**
 * consolidate-findings.mjs — `aios consolidate-findings`: merge every independent review
 * of a PR (CI checks, Cursor Bugbot, CodeRabbit, an optional GPT-5.5 review) plus the PR
 * diff into ONE deterministic, severity-ranked finding list the builder can act on.
 *
 * Pipeline: gather → deterministic pre-extract → model consolidation → deterministic
 * post-validation (fail-closed max-severity inheritance) → write + stdout verdict.
 *
 * The single prompt source is `.claude/agents/code-reviewer.md` (frontmatter stripped),
 * read at runtime — never forked. The diff is supplied so its "read the diff / check
 * plan-conformance" instructions stay honest.
 *
 * Run context: REQUIRES a local checkout (reads .claude/agents/code-reviewer.md +
 * .aios/loop-models.yaml, writes .aios/loop/<issue>/…). The repo root is resolved from
 * cwd by the dispatcher; the GitHub target is a SEPARATE `--repo owner/repo` slug.
 *
 * Exit codes (dispatch owns process.exit — this returns the number):
 *   0 — CLEAR   (no Critical/High after post-validation)
 *   3 — BLOCKED (a Critical/High finding, red CI, or a forced max-severity inheritance)
 *   1 — error   (bad args, missing reviewer prompt, gh error other than a tolerated CI-red)
 *
 * A red CI board is DATA, not an error: it returns 3 (BLOCKED), never 1.
 *
 * Exported:
 *   cmdConsolidateFindings(repo, args, deps = {})  — returns a numeric exit code
 *   plus the pure helpers below (unit-tested).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { c } from "./relay-core.mjs";
import { callClaudeAgent } from "./relay-core.mjs";
import { detectRepo } from "./pr.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { hasCriticalOrHighFindings, SEVERITY_RANK } from "./review-bugbot.mjs";
import { DIFF_CAP } from "./build.mjs";

const ISSUE_RE = /^AIO-\d+$/;
// Cap the GPT-5.5 review markdown fed to the model (documented, tunable via this const).
// The PR diff shares build.mjs's DIFF_CAP so the two caps never silently drift.
export const GPT_REVIEW_CAP = 20000;
export const DEFAULT_CONSOLIDATE_TIMEOUT = 300; // seconds

// CI states/conclusions that mean the board is red (block-worthy). Pending/in-progress is
// deliberately NOT here — the consolidator runs after wait-for-bots, so an explicit failure
// is the signal; treating in-progress as red would over-block a slow-but-passing job.
const CI_RED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

const REVIEWER_PROMPT_REL = path.join(".claude", "agents", "code-reviewer.md");

// ── pure helpers (exported for tests) ─────────────────────────────────────────

export function parseConsolidateArgs(args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);
  return {
    help: hasFlag("--help") || hasFlag("-h"),
    pr: flag("--pr"),
    issue: flag("--issue"),
    round: parseInt(flag("--round") ?? "1", 10),
    repoSlug: flag("--repo"),
    gptReview: flag("--gpt-review"),
    out: flag("--out"),
  };
}

// Strip a leading YAML frontmatter block (--- … ---) from a markdown file.
export function stripFrontmatter(text) {
  const s = text ?? "";
  const m = s.match(/^---\n[\s\S]*?\n---\n?/);
  return m ? s.slice(m[0].length).trimStart() : s;
}

export function rankSeverity(sev) {
  return SEVERITY_RANK[sev] ?? 0;
}

function normSev(s) {
  const t = String(s ?? "").toLowerCase();
  if (t.startsWith("crit")) return "Critical";
  if (t === "high") return "High";
  if (t === "medium" || t === "med") return "Medium";
  if (t === "low") return "Low";
  return null;
}

function maxSev(a, b) {
  if (!a) return b;
  if (!b) return a;
  return rankSeverity(a) >= rankSeverity(b) ? a : b;
}

// Parse `gh pr checks --json name,state,conclusion` output → { checks, ciRed }. Falls back
// to a plaintext-table scan when --json is unsupported (older gh). ciRed on any red state.
export function parseCheckResults(stdout) {
  const raw = String(stdout ?? "");
  let arr = null;
  try {
    arr = JSON.parse(raw);
  } catch {
    /* not JSON — fall through to plaintext */
  }
  if (!Array.isArray(arr)) {
    // Plaintext `gh pr checks` table: a "fail"/"failing" cell means red.
    const ciRed = /\bfail(ed|ing|ure)?\b/i.test(raw) && raw.trim().length > 0;
    return { checks: [], ciRed };
  }
  const checks = arr.map((x) => ({
    name: x.name ?? x.context ?? "(unnamed)",
    state: String(x.state ?? "").toUpperCase(),
    conclusion: String(x.conclusion ?? "").toUpperCase(),
  }));
  const ciRed = checks.some((x) => CI_RED.has(x.state) || CI_RED.has(x.conclusion));
  return { checks, ciRed };
}

// Bugbot posts `**High Severity**`-style headers on its inline comments.
export function extractBugbotSeverities(comments) {
  let max = null;
  for (const cm of comments ?? []) {
    if (!/cursor/i.test(cm.user ?? "")) continue;
    const m = (cm.body ?? "").match(/\*\*(Critical|High|Medium|Low)\s+Severity\*\*/i);
    if (m) max = maxSev(max, normSev(m[1]));
  }
  return max;
}

// GPT-5.5 review markdown lists findings as `- \`High\` \`file\`: …`.
export function extractGptSeverities(gptMarkdown) {
  let max = null;
  const re = /^\s*-\s*`(Critical|High|Medium|Low)`/gim;
  let m;
  while ((m = re.exec(gptMarkdown ?? "")) !== null) max = maxSev(max, normSev(m[1]));
  return max;
}

// CodeRabbit prose → severity, mapped conservatively UPWARD: "potential issue"/"Major" →
// High (a plausible correctness issue is never dropped below Medium); "Minor" → Medium;
// "nitpick" → Low. Returns the max across all coderabbit comments.
export function extractCodeRabbitSeverities(comments) {
  let max = null;
  for (const cm of comments ?? []) {
    if (!/coderabbit/i.test(cm.user ?? "")) continue;
    const body = cm.body ?? "";
    if (/potential issue/i.test(body) || /\bmajor\b/i.test(body)) max = maxSev(max, "High");
    else if (/\bminor\b/i.test(body)) max = maxSev(max, "Medium");
    else if (/nitpick/i.test(body)) max = maxSev(max, "Low");
  }
  return max;
}

// Deterministic pre-extraction: the highest severity each source independently reported,
// plus whether CI is red. Feeds the fail-closed post-validation.
export function preExtractSeverities({ checks, bugbot, coderabbit, gpt } = {}) {
  const sourceMax = [
    extractBugbotSeverities(bugbot),
    extractCodeRabbitSeverities(coderabbit),
    extractGptSeverities(gpt),
  ].reduce((acc, s) => maxSev(acc, s), null);
  return { sourceMax, ciRed: !!checks?.ciRed };
}

// Assemble the consolidation prompt. The reviewer-prompt body (code-reviewer.md, frontmatter
// stripped) carries the Output format + severity vocabulary + BUGBOT_CLEAR rule; we append
// the consolidation instruction and every gathered input (incl. the PR diff, so plan-
// conformance findings are grounded).
export function buildConsolidatePrompt(reviewerPrompt, inputs = {}) {
  const {
    pr,
    issue,
    checks,
    prDiff,
    issueComments,
    inlineComments,
    reviews,
    gptMarkdown,
  } = inputs;
  const asJson = (v) => JSON.stringify(v ?? [], null, 2);
  const checkLines =
    checks?.checks?.length
      ? checks.checks.map((x) => `[${x.conclusion || x.state || "?"}] ${x.name}`).join("\n")
      : checks?.ciRed
        ? "(CI is red — see the raw board)"
        : "(no CI check data)";
  return [
    reviewerPrompt.trim(),
    "",
    "---",
    "",
    `You are CONSOLIDATING every independent review of PR #${pr ?? "?"} (${issue ?? "?"}) into ONE finding list.`,
    "Instructions:",
    "- Dedupe findings that describe the same issue across sources.",
    "- Tag every merged finding with its origin: `(source: Bugbot|CodeRabbit|GPT-5.5)`.",
    "- Tag any AIOS-rule / plan-conformance finding with `(plan-conformance)`.",
    "- Rank findings by severity (Critical > High > Medium > Low).",
    "- Emit EXACTLY the `## Output format` structure above, using the `[severity] file:line — …` bracket form.",
    "- If (and only if) there are no Critical or High findings, end with `BUGBOT_CLEAR` alone on the last line.",
    "",
    "## CI checks",
    "",
    checkLines,
    "",
    "## PR diff (base..head)",
    "",
    prDiff || "(no diff)",
    "",
    "## Bugbot + CodeRabbit issue comments",
    "",
    asJson(issueComments),
    "",
    "## Bugbot + CodeRabbit inline diff comments",
    "",
    asJson(inlineComments),
    "",
    "## Submitted reviews",
    "",
    asJson(reviews),
    "",
    "## GPT-5.5 review",
    "",
    gptMarkdown || "(none provided)",
  ].join("\n");
}

// Read the current `## Verdict` value (CLEAR | BLOCKED), or null when absent.
function readVerdictLine(text) {
  const m = (text ?? "").match(/^\s*(?:##\s*Verdict\s*\n+\s*)?\[?(CLEAR|BLOCKED)\]?\s*$/im);
  // Prefer a value that follows a "## Verdict" header specifically.
  const hm = (text ?? "").match(/##\s*Verdict\s*\n+\s*\[?(CLEAR|BLOCKED)\]?/i);
  if (hm) return hm[1].toUpperCase();
  return m ? m[1].toUpperCase() : null;
}

/**
 * Deterministic post-validation — fail-closed max-severity inheritance. The model's output
 * is NEVER trusted to downgrade below what the sources deterministically reported.
 *
 * Forces BLOCK (and rewrites the artifact so the state is unloseable) when:
 *   - CI is red (a red board is ≥ High and can never be CLEAR), OR
 *   - a source reported Critical/High but the consolidated output shows no Critical/High
 *     (or its verdict is CLEAR) — i.e. the model dropped a source-level blocker.
 *
 * On a forced block: rewrite `## Verdict` to BLOCKED, strip any trailing BUGBOT_CLEAR, and
 * append a `## AIOS Rule Violations` section naming the dropped source severity / red CI
 * with a concrete `[High]` finding — so the bracket matcher (computeVerdict) also sees it.
 *
 * @returns {{ text: string, forcedBlock: boolean }}
 */
export function postValidate({ modelOutput, sourceMax, ciRed, checks } = {}) {
  let text = String(modelOutput ?? "");
  const verdict = readVerdictLine(text);
  const outHasCritHigh = hasCriticalOrHighFindings(text);
  const sourceHadCritHigh = rankSeverity(sourceMax) >= rankSeverity("High");

  const droppedSource = sourceHadCritHigh && (!outHasCritHigh || verdict === "CLEAR");
  const forceBlock = !!ciRed || droppedSource;
  if (!forceBlock) return { text, forcedBlock: false };

  // Strip any trailing CLEAR token — a forced block can never be CLEAR.
  text = text.replace(/\n*BUGBOT_CLEAR\s*$/i, "").trimEnd();

  // Rewrite an existing verdict, or leave it to the finalizer if none present.
  if (/##\s*Verdict\s*\n+\s*\[?(CLEAR|BLOCKED)\]?/i.test(text)) {
    text = text.replace(/(##\s*Verdict\s*\n+\s*)\[?(CLEAR|BLOCKED)\]?/i, "$1BLOCKED");
  }

  // Concrete, matcher-visible reason(s) for the forced block.
  const reasons = [];
  if (ciRed) {
    const reds =
      checks?.checks?.filter((x) => CI_RED.has(x.state) || CI_RED.has(x.conclusion)) ?? [];
    const names = reds.map((x) => x.name).join(", ") || "one or more jobs";
    reasons.push(`[High] CI — ${names} failed; a red CI board blocks merge (source: CI).`);
  }
  if (droppedSource) {
    reasons.push(
      `[High] consolidation — a source reported a ${sourceMax} finding that the consolidated ` +
        `report did not carry through; failing closed (deterministic max-severity inheritance).`
    );
  }
  text += `\n\n## AIOS Rule Violations\n\n${reasons.join("\n")}\n`;
  return { text, forcedBlock: true };
}

// BLOCKED iff a forced block OR any Critical/High in the post-validated findings.
export function computeVerdict({ text, forcedBlock } = {}) {
  return forcedBlock || hasCriticalOrHighFindings(text) ? "BLOCKED" : "CLEAR";
}

// Ensure the artifact ends with the right terminal marker for its verdict.
function finalizeOutput(text, verdict) {
  let out = String(text ?? "")
    .replace(/\n*BUGBOT_CLEAR\s*$/i, "")
    .trimEnd();
  if (verdict === "CLEAR") {
    // If there's no explicit Verdict section, add one so the artifact is self-describing.
    if (!/##\s*Verdict/i.test(out)) out += "\n\n## Verdict\n\nCLEAR";
    out += "\n\nBUGBOT_CLEAR\n";
  } else {
    if (!/##\s*Verdict/i.test(out)) out += "\n\n## Verdict\n\nBLOCKED";
    out += "\n";
  }
  return out;
}

export function defaultOutPath(repo, issue, round) {
  return path.join(repo, ".aios", "loop", issue, `findings-r${round}.md`);
}

// ── impure gather (injectable deps) ───────────────────────────────────────────

function defaultRunGh(argv, { tolerateNonZero = false } = {}) {
  try {
    const stdout = execFileSync("gh", argv, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return tolerateNonZero ? { code: 0, stdout, stderr: "" } : stdout;
  } catch (e) {
    if (tolerateNonZero) {
      // A failing/pending `gh pr checks` is DATA — return it, don't throw.
      return {
        code: e.status ?? 1,
        stdout: e.stdout?.toString() ?? "",
        stderr: e.stderr?.toString() ?? "",
      };
    }
    throw e;
  }
}

function defaultReadReviewerPrompt(repo) {
  const p = path.join(repo, REVIEWER_PROMPT_REL);
  if (!existsSync(p)) throw new Error(`reviewer prompt not found: ${REVIEWER_PROMPT_REL}`);
  return stripFrontmatter(readFileSync(p, "utf8"));
}

function safeJsonArray(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const BOT_SELECT = 'select(.user.login | test("cursor|coderabbit"))';

// Gather every input per code-reviewer.md §"How to gather inputs" — now INCLUDING the PR diff.
export function gatherInputs({ runGh, slug, pr, gptReviewPath } = {}) {
  // 1. CI checks (tolerate a red/pending board — it's data, not a crash).
  const checksRes = runGh(
    ["pr", "checks", String(pr), "--repo", slug, "--json", "name,state,conclusion"],
    { tolerateNonZero: true }
  );
  const checks = parseCheckResults(checksRes.stdout);

  // 2. PR diff (capped at DIFF_CAP with an explicit marker so the model knows it's clipped).
  let prDiff = runGh(["pr", "diff", String(pr), "--repo", slug]);
  if ((prDiff?.length ?? 0) > DIFF_CAP) {
    prDiff = prDiff.slice(0, DIFF_CAP) + `\n\n(diff truncated at ${DIFF_CAP} chars)`;
  }

  // 3-5. Bot issue comments, inline diff comments, submitted reviews (cursor|coderabbit).
  const issueComments = safeJsonArray(
    runGh([
      "api",
      `repos/${slug}/issues/${pr}/comments`,
      "--jq",
      `[.[] | ${BOT_SELECT} | {user: .user.login, body: .body, created_at: .created_at}]`,
    ])
  );
  const inlineComments = safeJsonArray(
    runGh([
      "api",
      `repos/${slug}/pulls/${pr}/comments`,
      "--jq",
      `[.[] | ${BOT_SELECT} | {user: .user.login, path: .path, line: .line, body: .body}]`,
    ])
  );
  const reviews = safeJsonArray(
    runGh([
      "api",
      `repos/${slug}/pulls/${pr}/reviews`,
      "--jq",
      `[.[] | ${BOT_SELECT} | {user: .user.login, state: .state, body: .body}]`,
    ])
  );

  // 6. Optional GPT-5.5 review markdown from a file (capped).
  let gptMarkdown = null;
  if (gptReviewPath) {
    if (!existsSync(gptReviewPath)) throw new Error(`--gpt-review file not found: ${gptReviewPath}`);
    gptMarkdown = readFileSync(gptReviewPath, "utf8");
    if (gptMarkdown.length > GPT_REVIEW_CAP) {
      gptMarkdown = gptMarkdown.slice(0, GPT_REVIEW_CAP) + `\n\n(diff truncated at ${GPT_REVIEW_CAP} chars)`;
    }
  }

  return { pr, checks, prDiff, issueComments, inlineComments, reviews, gptMarkdown };
}

// ── public entry ──────────────────────────────────────────────────────────────

function usage() {
  console.log(
    [
      "",
      c.blue("aios consolidate-findings — merge CI + bot + GPT reviews into one finding list"),
      "",
      "usage:",
      "  aios consolidate-findings --pr <n> --issue AIO-<n> [options]",
      "",
      "options:",
      "  --pr <n>            PR number (required)",
      "  --issue AIO-<n>     issue key (required; drives the output path)",
      "  --round N           build round (default: 1) — output is findings-r<N>.md",
      "  --repo owner/repo   GitHub target slug (default: detected from git remote)",
      "  --gpt-review <path> include a GPT-5.5 review markdown file in the consolidation",
      "  --out <path>        override the output path (default: .aios/loop/<issue>/findings-r<N>.md)",
      "",
      "Prints VERDICT=CLEAR / VERDICT=BLOCKED. Exit codes: 0 CLEAR · 3 BLOCKED · 1 error.",
      "A red CI board returns 3 (BLOCKED), never 1.",
    ].join("\n")
  );
}

/**
 * @param {string} repo   local checkout root (resolved from cwd by the dispatcher)
 * @param {string[]} args CLI args (excluding the command name)
 * @param {object} deps   { runGh, callAgent, readReviewerPrompt } — injected in tests
 * @returns {Promise<number>} exit code (0 CLEAR · 3 BLOCKED · 1 error)
 */
export async function cmdConsolidateFindings(repo, args, deps = {}) {
  const opts = parseConsolidateArgs(args);
  if (opts.help) {
    usage();
    return 0;
  }

  // Validate args — return 1 (never process.exit; the dispatcher owns the exit).
  if (!opts.pr || !/^\d+$/.test(String(opts.pr))) {
    console.error(c.red("error: --pr <number> is required."));
    return 1;
  }
  if (!opts.issue || !ISSUE_RE.test(opts.issue)) {
    console.error(c.red("error: --issue AIO-<n> is required (e.g. --issue AIO-161)."));
    return 1;
  }
  const round = Number.isFinite(opts.round) && opts.round > 0 ? opts.round : 1;

  const runGh = deps.runGh ?? defaultRunGh;
  const callAgent = deps.callAgent ?? callClaudeAgent;
  const readReviewerPrompt = deps.readReviewerPrompt ?? (() => defaultReadReviewerPrompt(repo));

  const slug = opts.repoSlug ?? detectRepo(repo);
  if (!slug) {
    console.error(c.red("error: could not detect the target repo — pass --repo owner/repo."));
    return 1;
  }

  let reviewerPrompt;
  try {
    reviewerPrompt = readReviewerPrompt();
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }

  // Gather. Only a NON-tolerated gh failure (auth/network on diff/comments) is an error.
  let inputs;
  try {
    inputs = gatherInputs({ runGh, slug, pr: opts.pr, gptReviewPath: opts.gptReview });
  } catch (e) {
    console.error(c.red(`error: gathering inputs failed: ${e.message}`));
    return 1;
  }

  // Deterministic pre-extraction (single severity dialect).
  const { sourceMax, ciRed } = preExtractSeverities({
    checks: inputs.checks,
    bugbot: inputs.inlineComments,
    coderabbit: [...(inputs.inlineComments ?? []), ...(inputs.issueComments ?? [])],
    gpt: inputs.gptMarkdown,
  });

  // Model consolidation, driven by the config surface (consolidate is a Claude-runner step,
  // so a gpt-* consolidate_model already failed loud in resolveLoopModels above/here).
  let models;
  try {
    models = resolveLoopModels({ repo });
  } catch (e) {
    console.error(c.red(`error: ${e.message}`));
    return 1;
  }
  const cfg = models.consolidate;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_CONSOLIDATE_TIMEOUT * 1000;
  const prompt = buildConsolidatePrompt(reviewerPrompt, { ...inputs, issue: opts.issue });

  let modelOutput;
  try {
    console.log(c.dim(`[consolidate] ${cfg.model}${cfg.effort ? ` (effort=${cfg.effort})` : ""}…`));
    modelOutput = await callAgent(prompt, timeoutMs, {
      model: cfg.model,
      extraArgs: cfg.effort ? ["--effort", cfg.effort] : [],
    });
  } catch (e) {
    console.error(c.red(`error: consolidation model call failed: ${e.message}`));
    return 1;
  }

  // Deterministic post-validation (fail-closed) + final verdict (forced block is unloseable).
  const validated = postValidate({ modelOutput, sourceMax, ciRed, checks: inputs.checks });
  const verdict = computeVerdict(validated);
  const finalText = finalizeOutput(validated.text, verdict);

  // Write the artifact (gitignored; never committed). --out overrides the default path.
  const outPath = opts.out ? path.resolve(opts.out) : defaultOutPath(repo, opts.issue, round);
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, finalText);
  } catch (e) {
    console.error(c.red(`error: could not write findings to ${outPath}: ${e.message}`));
    return 1;
  }

  console.log(c.dim(`findings → ${outPath}`));
  console.log(`VERDICT=${verdict}`);
  return verdict === "BLOCKED" ? 3 : 0;
}

// Direct entrypoint so `node scripts/consolidate-findings.mjs --help` works; the normal
// dispatch path is scripts/aios.mjs (which owns the process.exit with the returned code).
function findRepoRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".git")) || existsSync(path.join(dir, "aios.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const repo = findRepoRoot(process.cwd()) ?? process.cwd();
  const code = await cmdConsolidateFindings(repo, args);
  process.exit(code);
}
