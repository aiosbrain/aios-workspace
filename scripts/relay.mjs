/**
 * relay.mjs — Opus 4.8 ↔ Cursor plan-review loop, packaged as an aios sub-command.
 *
 * Exported entry point: cmdRelay(repo, args)
 * Called by aios.mjs as:  aios relay "task" [branch] [options]
 *
 * The relay produces an *approved plan*. To then implement it, hand the plan to
 * the build phase (scripts/build.mjs) — either with the --build flag here, or by
 * running `aios build <plan-file>` against this relay's --log output.
 *
 * Options:
 *   --rounds N       max plan/review cycles (default: 3)
 *   --skill /name    Cursor slash command (default: /review-plan)
 *   --dry-run        skip git operations
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import {
  PLAN_READY_TOKEN,
  c,
  die,
  checkPrereqs,
  gitMergeAndDelete,
  makeLogger,
} from "./relay-core.mjs";
import { callPromptModel } from "./model-call.mjs";
import { runBuild, parseBuildArgs } from "./build.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { evaluateSpec, loadRubric, loadRecentDecisions, formatFindings } from "./spec-eval.mjs";

const DEFAULT_SKILL = "/review-plan";

// Value-flags whose following token is a value, not the task/branch positional.
const VALUE_FLAGS = [
  "--rounds",
  "--skill",
  "--cursor-timeout",
  "--log",
  "--build-rounds",
  "--build-timeout",
  "--base",
  "--worktree",
  "--verify",
  "--spec",
];

// ── arg parsing ───────────────────────────────────────────────────────────────

function parseArgs(args) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : null;
  };
  const hasFlag = (name) => args.includes(name);

  const dryRun = hasFlag("--dry-run");
  const autoMerge = hasFlag("--merge");
  const maxRounds = parseInt(flag("--rounds") ?? "3", 10);
  const skill = flag("--skill") ?? DEFAULT_SKILL;
  const cursorTimeoutSet = hasFlag("--cursor-timeout");
  const cursorTimeout = parseInt(flag("--cursor-timeout") ?? "300", 10) * 1000;
  const logFile = flag("--log") ?? null;
  const build = hasFlag("--build");
  const buildRoundsRaw = parseInt(flag("--build-rounds") ?? "4", 10);
  const buildRounds = Number.isFinite(buildRoundsRaw) && buildRoundsRaw > 0 ? buildRoundsRaw : 4;
  const specFile = flag("--spec");

  const positional = args.filter(
    (a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1])
  );
  const [task, branch] = positional;
  return {
    task,
    branch,
    dryRun,
    autoMerge,
    maxRounds,
    skill,
    cursorTimeout,
    cursorTimeoutSet,
    logFile,
    build,
    buildRounds,
    specFile,
  };
}

// ── Anthropic client ──────────────────────────────────────────────────────────

export async function callOpus(anthropic, messages, planCfg = {}) {
  // Model + effort come from the per-step config (loop-models.mjs `plan` step): default
  // matrix → .aios/loop-models.yaml → CLI. Effort is passed via the SDK's output_config
  // here (NOT the Claude CLI --effort flag, which only the build phase uses).
  const model = planCfg.model ?? "claude-opus-4-8";
  const effort = planCfg.effort ?? "xhigh";
  process.stdout.write(`\n[opus] planning (${effort} effort)...`);
  // xhigh effort can exceed 10 minutes — streaming is required by the SDK.
  // .finalMessage() collects the full response once the stream completes.
  const stream = anthropic.messages.stream({
    model,
    max_tokens: 32000,
    thinking: { type: "adaptive" },
    output_config: { effort },
    system: [
      "You are a senior software architect.",
      "When given a task, produce a clear, numbered implementation plan.",
      "When given feedback, revise the plan to address all concerns — be specific.",
    ].join(" "),
    messages,
  });
  const res = await stream.finalMessage();
  process.stdout.write(" done.\n");
  const textBlock = res.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("Opus returned no text block");
  return textBlock.text;
}

// ── prompt builder ────────────────────────────────────────────────────────────

function buildReviewPrompt(skill, plan, round, maxRounds) {
  const isLastRound = round >= maxRounds;
  const roundNote = isLastRound
    ? `**This is the final round (${round}/${maxRounds}). Approve unless there is a Blocker. Do not raise new Majors or Minors at this stage.**`
    : `Round ${round} of ${maxRounds}. If only Minors remain after this round, approve on the next.`;

  return [
    skill,
    "",
    `> ${roundNote}`,
    "",
    "## Plan to review",
    "",
    plan,
    "",
    "---",
    "Review the plan above.",
    "List any Blockers or approach-level Majors. Minor issues do not block approval.",
    `When the plan is ready to implement, place this token alone on the very last line:`,
    PLAN_READY_TOKEN,
  ].join("\n");
}

// ── main entry point ──────────────────────────────────────────────────────────

export async function cmdRelay(repo, args) {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    console.log(
      [
        "",
        c.blue("aios relay — Opus 4.8 ↔ Cursor plan review loop"),
        "",
        "usage:",
        '  aios relay "task description" [branch] [options]',
        "",
        "arguments:",
        "  task      What to implement (required)",
        "  branch    Git branch to merge when approved (optional; omit to skip git ops)",
        "",
        "options:",
        "  --rounds N              max plan/review cycles (default: 3)",
        "  --log <file>            save the final approved plan to a file",
        "  --skill /name           Cursor slash command (default: /review-plan)",
        "  --cursor-timeout N      seconds before killing a stalled Cursor call (default: 300)",
        "  --merge                 auto-merge the branch on approval (off by default)",
        "  --dry-run               skip git operations",
        "  --build                 on approval, hand the plan to the build phase",
        "  --build-rounds N        max build/review cycles when --build is set (default: 4)",
        "  --spec <file>           gate: require the spec to pass readiness before planning (eval-only)",
        "",
        "next step:",
        "  Hand the approved plan to the build phase to implement it:",
        "    aios build <plan-file> [branch]",
        "",
        "examples:",
        '  aios relay "Add a --version flag to aios.mjs" --dry-run',
        '  aios relay "Add m365 integration" --rounds 3 --log plan.md --dry-run',
        '  aios relay "Add rate-limit headers" feat/rate-limit --rounds 3 --log plan.md',
      ].join("\n")
    );
    return;
  }

  const {
    task,
    branch,
    dryRun,
    autoMerge,
    maxRounds,
    skill,
    cursorTimeout,
    cursorTimeoutSet,
    logFile,
    build,
    buildRounds,
    specFile,
  } = parseArgs(args);
  if (!task) die('task description is required.\nusage: aios relay "task" [branch] [options]');

  checkPrereqs();

  const anthropic = new Anthropic();

  // Initialise log file with a header so partial runs are recoverable.
  const log = makeLogger(logFile, `# aios relay plan\n\nTask: ${task}\n\n`);

  console.log("\n── aios relay ───────────────────────────────────────────────");
  console.log(`Task:       ${task}`);
  console.log(`Branch:     ${branch ?? c.dim("(none — git ops skipped)")}`);
  console.log(`Skill:      ${skill}`);
  console.log(`Max rounds: ${maxRounds}`);
  if (logFile) console.log(`Log:        ${logFile}`);
  if (dryRun) console.log(c.yellow("Mode:       dry-run"));
  console.log("─────────────────────────────────────────────────────────────");

  // Per-step model config (loop-models.mjs). The plan phase uses the `plan` step and the
  // Cursor plan review uses the `plan_review` step; --cursor-timeout (when explicit)
  // overrides the reviewer timeout, else .aios/loop-models.yaml's plan_review_timeout_s,
  // else the 300s default. The diversity guard (plan vs plan_review family) runs here and
  // fails closed on a bad config.
  const cliOverrides = {};
  if (cursorTimeoutSet) cliOverrides.plan_review = { timeoutMs: cursorTimeout };
  const models = resolveLoopModels({ repo, cliOverrides });
  const reviewTimeout = models.plan_review.timeoutMs ?? cursorTimeout;

  // Spec-readiness gate (EE5, eval-only): don't spend a planning loop on an unready spec. This
  // NEVER auto-fixes — it evaluates and refuses. Fix with `aios spec fix <file>` then re-run.
  if (specFile) {
    const p = path.resolve(specFile);
    if (!existsSync(p)) die(`--spec file not found: ${specFile}`);
    const specText = readFileSync(p, "utf8");
    let rubric;
    try {
      rubric = loadRubric(path.join(repo, ".claude", "rubrics", "spec-readiness.md"));
    } catch (e) {
      die(e.message);
    }
    console.log(c.blue("\n── spec readiness gate (--spec) ─────────────────────────────"));
    const decisions = await loadRecentDecisions(repo);
    const res = await evaluateSpec({
      specText,
      repo,
      rubric,
      useLlm: true,
      anthropic,
      evalCfg: models.spec_eval,
      decisions,
    });
    if (res.verdict === "NOT_READY") {
      console.error(formatFindings(res.findings));
      console.error(
        c.red(
          `\n✗ spec NOT_READY (score ${res.score ?? "n/a"}) — refusing to plan against an unready spec.`
        )
      );
      console.error(c.dim(`  Fix it:  aios spec fix ${specFile}`));
      process.exit(res.exitCode);
    }
    console.log(c.green(`✓ spec SPEC_READY (score ${res.score ?? "n/a"}) — proceeding to plan.`));
  }

  const history = [{ role: "user", content: `Plan this task in detail:\n\n${task}` }];

  for (let round = 1; round <= maxRounds; round++) {
    console.log(`\n══ Round ${round}/${maxRounds} ${"═".repeat(50 - String(round).length)}`);

    const plan = await callOpus(anthropic, history, models.plan);
    console.log("\n── Opus plan ───────────────────────────────────────────────\n");
    console.log(plan);
    log(`Round ${round} — Opus plan`, plan);
    history.push({ role: "assistant", content: plan });

    const reviewPrompt = buildReviewPrompt(skill, plan, round, maxRounds);
    const review = await callPromptModel({
      model: models.plan_review.model,
      prompt: reviewPrompt,
      timeoutMs: reviewTimeout,
    });
    log(`Round ${round} — Cursor review`, review);

    console.log("\n\n── Cursor review done ──────────────────────────────────────");

    const lastLine =
      review
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1) ?? "";
    if (lastLine === PLAN_READY_TOKEN) {
      console.log(c.green(`\n✓ ${PLAN_READY_TOKEN} received after round ${round}.`));
      log(`Approved plan (round ${round})`, plan);
      if (logFile) console.log(c.dim(`Plan saved to ${logFile}`));

      // Chained one-shot: hand the in-memory approved plan to the build phase.
      if (build) {
        console.log(c.blue("\n── handing approved plan to the build phase ──────────────────"));
        const buildOpts = parseBuildArgs(args);
        buildOpts.rounds = buildRounds; // relay --rounds governs the PLAN loop; build uses --build-rounds
        buildOpts.skill = "/ai-code-review"; // relay --skill is the plan reviewer, not the code reviewer
        buildOpts.chained = true; // append to the shared --log instead of overwriting it
        const code = await runBuild({ repo, plan, branch, opts: buildOpts });
        process.exit(code);
      }

      if (branch && autoMerge) {
        gitMergeAndDelete(repo, branch, dryRun);
      } else if (branch) {
        console.log(c.yellow("\nPlan approved. Review the diff before merging:"));
        console.log(c.dim(`  git diff main...${branch}`));
        console.log(c.dim(`  git merge --no-ff -- ${branch}`));
        console.log(c.dim("Re-run with --merge to have aios relay merge automatically."));
      } else {
        console.log(c.dim("Plan approved. No branch specified — nothing to merge."));
      }
      if (logFile) {
        console.log(c.dim(`Build it:  aios build ${logFile}${branch ? " " + branch : ""}`));
      }
      return;
    }

    history.push({
      role: "user",
      content: `Cursor's review:\n\n${review}\n\nRevise the plan to address all concerns.`,
    });
  }

  // Save the last plan even if unapproved — don't lose the work.
  const lastPlan = history.filter((m) => m.role === "assistant").at(-1)?.content ?? "";
  if (logFile && lastPlan) {
    log("Last plan (round limit reached — unapproved)", lastPlan);
    console.log(c.yellow(`\nRound limit reached. Last plan saved to ${logFile}`));
    console.log(
      c.dim("Review it, answer any open questions, then re-run or hand off to your build agent.")
    );
  } else {
    console.error(
      c.red(`\n✗ Reached max rounds (${maxRounds}) without receiving ${PLAN_READY_TOKEN}.`)
    );
  }
  process.exit(1);
}
