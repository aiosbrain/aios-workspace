/**
 * ship.mjs — `aios ship <AIO-nnn>`: the whole gated loop for one Linear issue.
 *
 * Composes the merged pipeline surfaces — never re-implements them:
 *   recon (Linear + git-tracked files) → spec eval (EE5 readiness gate) → plan (loop)
 *   → follow-up capture → build (runBuild) → PR (cmdPr) → review (waitForBots + GPT review
 *   + cmdConsolidateFindings) → fix loop → merge gate (CI + consolidator + path-gated safety
 *   review + operator) → cleanup.
 *
 * Every stage maps to a distinct, documented SHIP_EXIT code (§ SHIP_EXIT below). Gates default
 * ON; in a non-TTY context without the matching --auto flag they exit with a *_GATE_BLOCKED
 * code rather than hanging (cron safety). Recon reads ONLY git-tracked, deny-filtered files
 * (extractRepoFileRefs) so untrusted Linear text can never exfiltrate secrets/paths.
 *
 * The orchestration (runShip/cmdShip) takes injected deps so the whole pipeline is testable
 * without touching the network, git, gh, claude, or cursor.
 */

import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import {
  c,
  callClaudeAgent,
  callCursorAgent,
  callDeepSeekDirect,
  PLAN_READY_TOKEN,
  NO_TOOLS,
  NO_TOOLS_ARGS,
  PLAN_DISALLOWED_ARGS,
} from "./relay-core.mjs";
import { runBuild, slugify } from "./build.mjs";
import { cmdPr, detectRepo } from "./pr.mjs";
import { cmdConsolidateFindings, defaultOutPath } from "./consolidate-findings.mjs";
import { resolveLoopModels } from "./loop-models.mjs";
import { modelFamily } from "./model-providers.mjs";
import { callPromptModel, callAgentModel, reviewCallForModel } from "./model-call.mjs";
import { createLinearClient, resolveLinearApiKey, extractRepoFileRefs } from "./linear-client.mjs";
import {
  evaluateSpec,
  loadRubric,
  resolveRubricPath,
  loadRecentDecisions,
  formatFindings,
  specEvalHints,
  DEFAULT_SPEC_GATE,
} from "./spec-eval.mjs";
import {
  REQUIRED_BUGBOT_MODEL,
  resolveRequiredBugbotBase,
  runLocalPrePrReview,
} from "./review-bugbot.mjs";
import { loadConstitutionDigest } from "./constitution.mjs";
import { runSimplify } from "./simplify.mjs";
import { loadSkillContext, parseDeclaredSkills } from "./skill-context.mjs";

import {
  parseShipArgs,
  validateShipArgs,
  buildShipDryRunReport,
  builderSkillCheckpoint,
  builderSkillCheckpointMatches,
} from "./ship/args.mjs";
import {
  SHIP_EXIT,
  SAFETY_APPROVED_TOKEN,
  SAFETY_PATHS,
  CODERABBIT_READY_LABEL,
  resolveGates,
  mapBuildExit,
  detectSafetyToken,
  touchesSafetySurface,
  localBugbotEvidenceMatches,
  readChecks,
  usableFrontmatterGate,
  auditSpecText,
  readSpecFrontmatter,
  badSpecFrontmatter,
  specEvalTier,
} from "./ship/gates.mjs";
import {
  parseDeferredScope,
  normalizeTitle,
  buildReconPrompt,
  buildSpecTextFromIssue,
  specSafetyFlag,
  buildLightPlanFromSpec,
  formatSpecEvalAudit,
  RECON_FILE_CAP,
  buildOmittedRefsNote,
  buildPlanPrompt,
  buildPlanReviewPrompt,
  buildGptReviewPrompt,
  buildSafetyPrompt,
} from "./ship/prompts.mjs";
import {
  SHIP_VERIFY_CMD,
  DEFAULT_PLAN_TIMEOUT_MS,
  failedArtifact,
  SHIP_STATE_VERSION,
  defaultReadState,
  defaultWriteState,
  defaultWriteGate,
  defaultRemoveGate,
  expandHomePath,
  findPlanFilePath,
  defaultGitLsFiles,
  defaultGitExec,
  defaultGhExec,
  defaultMakeAnthropic,
  defaultCallOpus,
  defaultWriteAudit,
  defaultConfirm,
  defaultWaitForBots,
  resolveWorktreePathFromList,
  runCleanup,
  makeBuildOpts,
  lastNonBlankLine,
  cursorCliModelArg,
} from "./ship/runtime.mjs";

// Re-export the extracted surfaces so existing `import { X } from "./ship.mjs"` call sites (tests,
// scripts/cli/*, roadmap-run.mjs) keep working unchanged — ship.mjs stays the stable public entry
// point; scripts/ship/{args,gates,prompts,runtime}.mjs are the internal seams this pulls apart
// (AIO-560, wave 5 of docs/v1-operator-loop/domains/safety-unit-extraction.md). Only symbols that
// were public before the move are re-exported — the newly-`export`ed default-dep helpers (e.g.
// defaultWriteGate, makeBuildOpts) were never part of ship.mjs's surface, so they stay import-only.
export {
  parseShipArgs,
  validateShipArgs,
  buildShipDryRunReport,
  builderSkillCheckpoint,
  builderSkillCheckpointMatches,
  SHIP_EXIT,
  SAFETY_APPROVED_TOKEN,
  SAFETY_PATHS,
  CODERABBIT_READY_LABEL,
  resolveGates,
  mapBuildExit,
  detectSafetyToken,
  touchesSafetySurface,
  localBugbotEvidenceMatches,
  readChecks,
  parseDeferredScope,
  normalizeTitle,
  buildReconPrompt,
  buildSpecTextFromIssue,
  specSafetyFlag,
  buildLightPlanFromSpec,
  formatSpecEvalAudit,
  RECON_FILE_CAP,
  buildOmittedRefsNote,
  buildPlanPrompt,
  buildPlanReviewPrompt,
  buildGptReviewPrompt,
  buildSafetyPrompt,
  SHIP_VERIFY_CMD,
  DEFAULT_PLAN_TIMEOUT_MS,
  failedArtifact,
  SHIP_STATE_VERSION,
  defaultReadState,
  defaultWriteState,
  expandHomePath,
  findPlanFilePath,
  resolveWorktreePathFromList,
  runCleanup,
};

// The agent tool-access tiers (NO_TOOLS / PLAN_DISALLOWED) now live in relay-core.mjs so ship and
// roadmap-run share one source of truth; re-exported here for back-compat (tests import NO_TOOLS
// from ship.mjs). recon + safety_review run at the NO_TOOLS tier; the plan cli runner at the
// PLAN_DISALLOWED (read-only, no exfil/mutate) tier — see the boundary doc in relay-core.mjs.
export { NO_TOOLS, NO_TOOLS_ARGS };

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
    evaluateSpec: evaluateSpecDep = evaluateSpec,
    specEvalHints: specEvalHintsDep = specEvalHints,
    loadRecentDecisions: loadRecentDecisionsDep = loadRecentDecisions,
    loadSpecRubric: loadSpecRubricDep = () => loadRubric(resolveRubricPath(repo)),
    readState = () => null,
    writeState = () => {},
    writeGate = () => {},
    removeGate = () => {},
  } = deps;

  const isLightLoop = opts.loop === "light";
  const records = { issue: issueId, loop: opts.loop ?? "full", stages: [] };
  const record = (stage, detail) => records.stages.push({ stage, ...detail });
  const models = resolveModels({ repo, profile: isLightLoop ? "light" : null });
  // Loaded once per ship; null (no file / no digest markers) simply omits the section.
  const constitution = (deps.loadConstitutionDigest ?? loadConstitutionDigest)(repo);

  // Unified model dispatch — tests may inject callPromptModel/callAgentModel or legacy shims.
  const promptCall = async ({ model, prompt, timeoutMs, opts = {} }) => {
    if (deps.callPromptModel) return deps.callPromptModel({ model, prompt, timeoutMs, opts });
    if (deps.callClaudeAgent && !deps.callPromptModel) {
      return deps.callClaudeAgent(prompt, timeoutMs, { model, ...opts });
    }
    return callPromptModel({ model, prompt, timeoutMs, opts });
  };
  const agentCall = async ({ model, prompt, timeoutMs, opts = {} }) => {
    if (deps.callAgentModel) return deps.callAgentModel({ model, prompt, timeoutMs, opts });
    if (deps.callClaudeAgent && !deps.callAgentModel) {
      return deps.callClaudeAgent(prompt, timeoutMs, { model, ...opts });
    }
    return callAgentModel({ model, prompt, timeoutMs, opts });
  };
  const reviewCall = deps.reviewCallForModel
    ? (model) => deps.reviewCallForModel(model)
    : deps.callPromptModel
      ? (model) =>
          (prompt, timeoutMs, opts = {}) =>
            deps.callPromptModel({ model, prompt, timeoutMs, opts })
      : deps.callDeepSeekDirect || deps.callCursorAgent
        ? (model) =>
            (prompt, timeoutMs, opts = {}) =>
              modelFamily(model) === "deepseek"
                ? deepseek(prompt, timeoutMs, { model, ...opts })
                : cursor(prompt, timeoutMs, opts)
        : reviewCallForModel;
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
  if (state.loop && state.loop !== (opts.loop ?? "full")) {
    record("resume", { error: "loop mismatch", checkpointLoop: state.loop });
    console.error(
      c.red(
        `resume: checkpoint was created by --loop ${state.loop}; resume with the same loop shape.`
      )
    );
    return { code: SHIP_EXIT.USAGE, records };
  }
  const saveState = (patch) => {
    Object.assign(state, patch);
    writeState(issueId, state);
  };
  const progress = (msg) => console.log(c.blue(`ship: ${msg}`));
  // One Anthropic SDK client per run — shared by spec eval (EE5) and the sdk plan runner.
  let anthropic = null;
  const getAnthropic = async () => (anthropic ??= await makeAnthropic());

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

  const specText = buildSpecTextFromIssue(issue);
  const manifestPath = path.join(repo, ".claude", "skill-suite.json");
  const declaredBuilderSkills = parseDeclaredSkills(issue.description || "");
  const selectedBuilderSkills = opts.builderSkills?.length
    ? opts.builderSkills
    : declaredBuilderSkills;
  if (selectedBuilderSkills.length && !existsSync(manifestPath)) {
    record("builder-skills", { error: "skill suite manifest missing" });
    console.error(
      c.red(
        "builder skills were selected but .claude/skill-suite.json is missing; refusing to continue."
      )
    );
    return { code: SHIP_EXIT.USAGE, records };
  }
  const builderContext = existsSync(manifestPath)
    ? loadSkillContext({
        repo,
        ids: selectedBuilderSkills,
        stage: "builder",
        source: opts.builderSkills?.length
          ? "flag"
          : declaredBuilderSkills.length
            ? "spec"
            : "none",
      })
    : { source: "none", stage: "builder", bytes: 0, skills: [], prompt: "", audit: [] };
  const builderCheckpoint = builderSkillCheckpoint(builderContext);
  if (
    opts.resume &&
    Object.keys(state).length > 0 &&
    !Object.hasOwn(state, "builderSkillContext")
  ) {
    record("resume", { error: "builder skill checkpoint missing" });
    console.error(
      c.red("resume: checkpoint predates builder skill verification; start a fresh ship run.")
    );
    return { code: SHIP_EXIT.USAGE, records };
  }
  if (opts.resume && state.builderSkillContext) {
    if (!builderSkillCheckpointMatches(state.builderSkillContext, builderCheckpoint)) {
      record("resume", { error: "builder skill context changed" });
      console.error(
        c.red(
          "resume: selected builder skill ids or content hashes changed; start a fresh ship run."
        )
      );
      return { code: SHIP_EXIT.USAGE, records };
    }
  } else {
    saveState({ builderSkillContext: builderCheckpoint });
  }
  record("builder-skills", builderCheckpoint);
  // Read the `safety: true` flag from the RAW issue body, not specText: buildSpecTextFromIssue
  // prepends a `# <id>: <title>` heading, which pushed the frontmatter off the start of the
  // string so specSafetyFlag(specText) was ALWAYS false — a fail-open of the safety review +
  // mandatory CodeRabbit gate for light-loop specs whose diff misses SAFETY_PATHS (H5).
  const specSafetyDeclared = specSafetyFlag(issue.description);

  let recon = "";
  if (isLightLoop) {
    record("recon", { skipped: true, reason: "--loop light uses the SPEC_READY spec directly" });
    progress("recon: skipped (--loop light uses the SPEC_READY spec directly)");
  } else if (state.recon) {
    recon = state.recon;
    record("recon", { resumed: true });
    progress("recon: resumed from checkpoint");
  }
  const reconStartedAt = Date.now();
  if (!isLightLoop && !state.recon) {
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
    try {
      // Read ONLY allowed (tracked, non-denied) files — audit the rest by path+reason only.
      const fileBlobs = allowed.map((rel) => {
        let body = "";
        try {
          body = readFile(path.join(repo, rel));
        } catch {
          body = "(unreadable)";
        }
        // Mark truncation instead of silently slicing — the model must know it saw a partial file.
        return body.length > RECON_FILE_CAP
          ? `### ${rel}\n\n${body.slice(0, RECON_FILE_CAP)}\n\n…[truncated: first ${RECON_FILE_CAP} of ${body.length} chars]`
          : `### ${rel}\n\n${body}`;
      });
      const reconPrompt =
        buildReconPrompt(issue, { allowedFiles: allowed }) +
        (fileBlobs.length ? `\n\n## File contents\n\n${fileBlobs.join("\n\n")}` : "") +
        buildOmittedRefsNote(skipped);
      const cfg = models.recon;
      // Recon runs with NO tools: the untrusted Linear text is in the prompt, and the only files it
      // may see are the pre-vetted `allowed` blobs already injected above. A prompt-injection payload
      // therefore cannot make recon read anything outside the tracked-only allow list.
      recon = await promptCall({
        model: cfg.model,
        prompt: reconPrompt,
        timeoutMs: cfg.timeoutMs ?? 300 * 1000,
        opts: {
          extraArgs: [...NO_TOOLS_ARGS, ...(cfg.effort ? ["--effort", cfg.effort] : [])],
        },
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
  }

  // ── 1b. SPEC EVAL (EE5) ─────────────────────────────────────────────────────
  // Fail closed before the plan loop: an unready Linear issue body must not spend Opus plan rounds
  // — UNLESS the policy is `advisory` (run + warn + proceed) or `off` (don't run). Precedence:
  // --spec-gate flag (or --skip-spec-gate → off) > spec frontmatter > config default.
  const fm = readSpecFrontmatter(specEvalHintsDep, issue.description); // RAW body — see helper
  if (fm.invalid) return badSpecFrontmatter(records, c, fm.invalid);
  const specGatePolicy =
    opts.specGate ??
    (opts.skipSpecGate ? "off" : undefined) ??
    usableFrontmatterGate(fm.specGate, opts, c) ??
    models.spec_eval?.spec_gate ??
    DEFAULT_SPEC_GATE;

  if (specGatePolicy === "off") {
    const reason = opts.skipSpecGate ? "--skip-spec-gate" : "spec_gate=off";
    record("spec-eval", { skipped: true, reason });
    progress(`spec eval: SKIPPED (${reason} — logged for audit)`);
  } else if (state.specReady) {
    record("spec-eval", { resumed: true });
    progress("spec eval: resumed from checkpoint (SPEC_READY)");
  } else {
    writeAudit(issueId, "spec.md", auditSpecText(issue.description, specText));
    const specStartedAt = Date.now();
    let rubric;
    try {
      rubric = loadSpecRubricDep();
    } catch (e) {
      record("spec-eval", { error: e.message });
      writeAudit(issueId, "spec-eval-FAILED.md", failedArtifact("spec-eval", e, specStartedAt));
      console.error(c.red(`spec eval: rubric load failed: ${e.message}`));
      return { code: SHIP_EXIT.SPEC_NOT_READY, records };
    }
    try {
      progress("spec eval: running spec-readiness gate…");
      const decisions = await loadRecentDecisionsDep(repo);
      const res = await evaluateSpecDep({
        specText,
        skillDeclarationText: issue.description || "",
        repo,
        rubric,
        tier: specEvalTier(fm.tier, { lightLoop: isLightLoop, safety: specSafetyDeclared }),
        evalCfg: models.spec_eval,
        decisions,
        requireCleanRepo: true,
      });
      writeAudit(issueId, "spec-eval-r1.md", formatSpecEvalAudit(res));
      if (res.verdict !== "SPEC_READY") {
        if (specGatePolicy === "advisory") {
          // Advisory: the gate ran and found problems, but the operator chose warn-not-block.
          // Surface everything loudly, record that it was non-blocking, and proceed to build.
          record("spec-eval", {
            verdict: res.verdict,
            exitCode: res.exitCode,
            score: res.score,
            advisory: true,
          });
          console.error(formatFindings(res.findings));
          console.error(
            c.yellow(
              `\nspec eval: NOT_READY (verdict ${res.verdict}, score ${res.score ?? "n/a"}) — ADVISORY mode, proceeding anyway.`
            )
          );
          console.error(
            c.dim(
              `  To enforce: drop --spec-gate advisory (default blocks). To fix: aios spec fix .aios/loop/${issueId}/spec.md`
            )
          );
          saveState({ specReady: true });
          progress(`spec eval: ADVISORY — proceeding despite ${res.verdict}`);
        } else {
          record("spec-eval", { verdict: res.verdict, exitCode: res.exitCode, score: res.score });
          console.error(formatFindings(res.findings));
          console.error(
            c.red(
              `\nspec eval: NOT_READY (verdict ${res.verdict}, score ${res.score ?? "n/a"}) — refusing to plan.`
            )
          );
          console.error(
            c.dim(
              `  Fix it:  aios spec fix .aios/loop/${issueId}/spec.md   then re-run aios ship ${issueId}` +
                `\n  Or warn-and-proceed:  aios ship ${issueId} --spec-gate advisory`
            )
          );
          return { code: SHIP_EXIT.SPEC_NOT_READY, records };
        }
      } else {
        record("spec-eval", { verdict: res.verdict, score: res.score });
        saveState({ specReady: true });
        progress(`spec eval: SPEC_READY (score ${res.score ?? "n/a"})`);
      }
    } catch (e) {
      record("spec-eval", { error: e.message });
      writeAudit(issueId, "spec-eval-FAILED.md", failedArtifact("spec-eval", e, specStartedAt));
      console.error(c.red(`spec eval: model step failed: ${e.message}`));
      return { code: SHIP_EXIT.SPEC_NOT_READY, records };
    }
  }

  // ── 2. PLAN ────────────────────────────────────────────────────────────────
  // The light loop has no planner or plan gate: the mandatory SPEC_READY spec is the approved
  // build contract. Its plan is still checkpointed so every later stage consumes the same text.
  let plan = null;
  if (isLightLoop) {
    if (state.plan) {
      plan = state.plan;
      record("plan", { resumed: true, derived: true });
      progress("plan: resumed spec-derived contract");
    } else {
      plan = buildLightPlanFromSpec(specText, { issue: issue.identifier });
      writeAudit(issueId, "plan.md", `## Approved spec-derived plan\n\n${plan}`);
      saveState({ loop: "light", plan, planReviewed: true, planApproved: true });
      record("plan", { derived: true, source: "SPEC_READY spec" });
      progress("plan: derived from SPEC_READY spec (--loop light)");
    }
  } else {
    const PLAN_ROUNDS = 3;
    let approved = false;
    let prevReview = null;
    const planCfg = models.plan;
    const planReviewCfg = models.plan_review;
    // Plan-stage runner (§3.4). `cli` (default): callClaudeAgent under --permission-mode plan; it
    // strips ANTHROPIC_API_KEY so the CLI uses Claude Code login auth. `sdk`: Opus via the Anthropic
    // SDK (relay.mjs's callOpus), which requires a funded ANTHROPIC_API_KEY. The Cursor plan review
    // (below) is identical for both runners. The Anthropic client is constructed once, lazily, when
    // spec eval or the sdk plan runner needs it — the cli plan path never touches the SDK.
    let generatePlan;
    if (opts.planRunner === "sdk") {
      const client = await getAnthropic();
      generatePlan = (prompt) => callOpus(client, [{ role: "user", content: prompt }], planCfg);
    } else {
      generatePlan = (prompt) =>
        agentCall({
          model: planCfg.model,
          prompt,
          timeoutMs: planCfg.timeoutMs ?? DEFAULT_PLAN_TIMEOUT_MS,
          opts: {
            extraArgs: [
              ...PLAN_DISALLOWED_ARGS,
              ...(planCfg.effort ? ["--effort", planCfg.effort] : []),
            ],
          },
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
        const planPrompt = buildPlanPrompt(issue, recon, prevReview, constitution, builderContext);
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
        const reviewPrompt = buildPlanReviewPrompt(
          plan,
          round,
          PLAN_ROUNDS,
          prevReview,
          builderContext.audit
        );
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
                ...(planReviewCfg.model ? ["--model", cursorCliModelArg(planReviewCfg.model)] : []),
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
  const artifactExists = deps.artifactExists ?? existsSync;
  // The mandatory local gate remains pinned; reviewer selection and loop config cannot override it.
  const reviewModel = REQUIRED_BUGBOT_MODEL;
  const resolveReviewSnapshot = () => {
    const head = (gitExec(["rev-parse", branch], repo) ?? "").trim();
    if (!head) throw new Error("could not resolve the branch head for local review");
    const verifiedBase = (deps.resolveBugbotBase ?? resolveRequiredBugbotBase)(worktreePath);
    if (!verifiedBase.ok) throw new Error(verifiedBase.reason);
    if (!verifiedBase.baseSha) throw new Error("verified Bugbot base SHA is missing");
    return { head, baseSha: verifiedBase.baseSha };
  };
  const invalidateReviewEvidence = (extra = {}, { preserveLocalBugbot = false } = {}) => {
    saveState({
      ...(preserveLocalBugbot
        ? {}
        : {
            prePrReviewDone: false,
            localBugbotReviewPath: null,
            localBugbotHead: null,
            localBugbotBaseSha: null,
          }),
      reviewClear: false,
      reviewHead: null,
      reviewBaseSha: null,
      codeRabbitHead: null,
      ...extra,
    });
  };
  const ensureLocalBugbotEvidence = async ({
    stage = "local-bugbot",
    roundTag = "pre-pr",
  } = {}) => {
    let snapshot;
    try {
      snapshot = resolveReviewSnapshot();
    } catch (e) {
      record(stage, { error: e.message });
      writeAudit(issueId, `local-bugbot-${roundTag}-FAILED.md`, failedArtifact("Local Bugbot", e));
      console.error(c.red(`local Bugbot: ${e.message} — blocking (fail closed).`));
      return { ok: false };
    }
    if (
      localBugbotEvidenceMatches(state, {
        ...snapshot,
        artifactExists,
      })
    ) {
      record(stage, { reused: true, head: snapshot.head, baseSha: snapshot.baseSha });
      progress(`local Bugbot: reusing exact-head evidence (${snapshot.head.slice(0, 12)})`);
      return { ok: true, ...snapshot, path: state.localBugbotReviewPath, reused: true };
    }

    progress(`local Bugbot: code + security review (${roundTag})`);
    let review;
    try {
      review = await (deps.runLocalPrePrReview ?? runLocalPrePrReview)({
        worktree: worktreePath,
        baseSha: snapshot.baseSha,
        branch,
        timeoutMs: models.code_review.timeoutMs ?? 300 * 1000,
        model: reviewModel,
      });
    } catch (e) {
      record(stage, { error: e.message });
      writeAudit(issueId, `local-bugbot-${roundTag}-FAILED.md`, failedArtifact("Local Bugbot", e));
      console.error(c.red(`local Bugbot: ${e.message} — blocking (fail closed).`));
      return { ok: false };
    }
    if (!review?.ok || review.skipped) {
      record(stage, { blocked: true, skipped: !!review?.skipped, pass: review?.pass });
      console.error(
        c.red(
          review?.error || review?.skipped
            ? "local Bugbot could not complete — blocking."
            : `local Bugbot found Medium+ issues in ${review?.pass ?? "review"} — blocking.`
        )
      );
      console.error(review?.output || "(Local Bugbot produced no evidence)");
      return { ok: false };
    }

    // An ok result MUST carry evidence markdown — an empty artifact is not exact-head
    // evidence, so fail closed rather than checkpoint a blank file.
    const evidenceMarkdown = (review.output ?? "").trim();
    if (!evidenceMarkdown) {
      record(stage, { blocked: true, emptyEvidence: true });
      console.error(c.red("local Bugbot returned no evidence markdown — blocking (fail closed)."));
      return { ok: false };
    }
    const safeHead = snapshot.head.replace(/[^a-f0-9]/gi, "").slice(0, 40) || "unknown-head";
    const artifactName = `local-bugbot-${safeHead}.md`;
    const artifactPath = path.join(auditDir, artifactName);
    writeAudit(issueId, artifactName, evidenceMarkdown);
    saveState({
      prePrReviewDone: true,
      localBugbotReviewPath: artifactPath,
      localBugbotHead: snapshot.head,
      localBugbotBaseSha: snapshot.baseSha,
    });
    record(stage, { ok: true, head: snapshot.head, baseSha: snapshot.baseSha, artifactPath });
    progress(`local Bugbot: clear (${snapshot.head.slice(0, 12)})`);
    return { ok: true, ...snapshot, path: artifactPath, reused: false };
  };
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
        opts: makeBuildOpts({
          branch,
          issue: issueId,
          logFile: buildLog,
          constitution,
          profile: isLightLoop ? "light" : null,
          builderContext,
        }),
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

  // ── 4b. PRE-PR LOCAL REVIEW ───────────────────────────────────────────────────
  // Code + security review is mandatory and canonical. A checkpoint is reusable only when the
  // artifact, branch head, and verified base SHA all still match.
  if (!state.merged) {
    const prePrEvidence = await ensureLocalBugbotEvidence({
      stage: "pre-pr-review",
      roundTag: "pre-pr",
    });
    if (!prePrEvidence.ok) return { code: SHIP_EXIT.MERGE_BLOCKED, records };
  }

  // ── 5. PR ────────────────────────────────────────────────────────────────────
  let prNumber;
  let reusedPr = false;
  if (state.prNumber) {
    prNumber = state.prNumber;
    record("pr", { resumed: true, pr: prNumber });
    progress(`pr: resumed from checkpoint (#${prNumber})`);
  } else {
    try {
      const prResult = await cmdPrDep(repo, ["--branch", branch, "--issue", issue.identifier], {
        throwOnError: true,
        returnMetadata: true,
      });
      prNumber = typeof prResult === "object" && prResult !== null ? prResult.number : prResult;
      reusedPr = typeof prResult === "object" && prResult !== null && prResult.reused === true;
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
    // `cmdPr` always pushes. Reusing an already-labelled PR therefore advances its head
    // without an automatic incremental review; require an explicit current-head refresh.
    saveState({ prNumber, codeRabbitRefreshRequired: reusedPr });
    progress(`pr: opened #${prNumber}`);
  }

  // ── 6 + 7. REVIEW + FIX LOOP ──────────────────────────────────────────────────
  // Local Bugbot always runs. --reviewers selects CodeRabbit and/or the GPT review; the legacy
  // `bugbot` name is a deprecated no-op alias.
  const wantCodeRabbit = opts.reviewers.includes("coderabbit");
  const wantGpt = opts.reviewers.includes("gpt-5.5");
  const effectiveReviewers = opts.reviewers.filter((reviewer) => reviewer !== "bugbot").sort();
  let round = state.reviewRound ?? 1;
  // A resumed CLEAR is honored only when the exact head/base Local Bugbot artifact and every
  // required current-head reviewer still match the checkpoint.
  if (state.reviewClear && !state.merged) {
    let snapshot = null;
    try {
      snapshot = resolveReviewSnapshot();
    } catch {
      snapshot = null;
    }
    const stale =
      !snapshot ||
      snapshot.head !== state.reviewHead ||
      snapshot.baseSha !== state.reviewBaseSha ||
      !localBugbotEvidenceMatches(state, { ...snapshot, artifactExists }) ||
      (state.reviewCodeRabbitRequired && state.codeRabbitHead !== snapshot.head) ||
      (wantCodeRabbit && !state.reviewCodeRabbitRequired) ||
      JSON.stringify(state.reviewers ?? []) !== JSON.stringify(effectiveReviewers);
    if (stale) {
      progress("review: checkpointed CLEAR is stale — re-running the exact-head review round");
      // The pre-PR step immediately above has already refreshed Local Bugbot for this exact
      // head/base. Only the stale consolidation/remote-review checkpoint needs invalidation.
      invalidateReviewEvidence(
        {
          codeRabbitRefreshRequired:
            (wantCodeRabbit && !state.reviewCodeRabbitRequired) ||
            (!!state.reviewCodeRabbitRequired && state.codeRabbitHead !== snapshot?.head),
        },
        { preserveLocalBugbot: true }
      );
      state.reviewClear = false;
    }
  }
  if (state.reviewClear || state.merged) {
    record("review", { resumed: true, clear: true });
    progress(
      state.merged
        ? "review: skipped (merge already checkpointed)"
        : "review: resumed from checkpoint (already CLEAR)"
    );
  } else
    for (;;) {
      saveState({ reviewRound: round });
      progress(`review: round ${round} started`);
      const localEvidence = await ensureLocalBugbotEvidence({
        stage: "review-local-bugbot",
        roundTag: `r${round}`,
      });
      if (!localEvidence.ok) return { code: SHIP_EXIT.MERGE_BLOCKED, records };

      // Classify the current PR diff every round. Missing changed-path metadata cannot rule out
      // the safety surface, so it fails closed.
      let reviewPolicy;
      try {
        const changed = ghExec([
          "pr",
          "diff",
          String(prNumber),
          ...(slug ? ["--repo", slug] : []),
          "--name-only",
        ]);
        if (changed?.code !== 0 || !(changed?.stdout ?? "").trim()) {
          throw new Error("changed-path metadata unavailable");
        }
        const changedPaths = changed.stdout
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean);
        const safetyRequired =
          (isLightLoop && specSafetyDeclared) || touchesSafetySurface(changedPaths);
        reviewPolicy = {
          changedPaths,
          safetyRequired,
          codeRabbitRequired: safetyRequired || wantCodeRabbit,
        };
      } catch (e) {
        record("review", { round, changedPathsUnavailable: true, error: e.message });
        console.error(c.red(`review: ${e.message} — blocking (fail closed).`));
        return { code: SHIP_EXIT.MERGE_BLOCKED, records };
      }

      if (reviewPolicy.safetyRequired && opts.autoMerge) {
        record("review", { round, safetyAutoMergeRejected: true });
        console.error(
          c.red(
            "review: --auto-merge is forbidden for safety-sensitive changes; use the interactive " +
              "operator gate or resume deliberately with --approve-merge."
          )
        );
        return { code: SHIP_EXIT.SAFETY_BLOCKED, records };
      }

      // CodeRabbit is opt-in for Standard PRs and mandatory for Safety PRs. The configured
      // positive label both proves operator intent and triggers the initial review. Reused PRs
      // and later fix pushes explicitly request a new review because incremental review is off.
      if (reviewPolicy.codeRabbitRequired) {
        let labels;
        try {
          const labelRes = ghExec([
            "pr",
            "view",
            String(prNumber),
            ...(slug ? ["--repo", slug] : []),
            "--json",
            "labels",
            "--jq",
            ".labels[].name",
          ]);
          if (labelRes?.code !== 0) throw new Error(labelRes?.stderr || "label query failed");
          labels = (labelRes?.stdout ?? "")
            .split("\n")
            .map((value) => value.trim())
            .filter(Boolean);
        } catch (e) {
          record("review", { round, labelsUnavailable: true, error: e.message });
          console.error(c.red(`review: could not read PR labels (${e.message}) — blocking.`));
          return { code: SHIP_EXIT.MERGE_BLOCKED, records };
        }
        if (!labels.includes(CODERABBIT_READY_LABEL)) {
          record("review", { round, codeRabbitLabelMissing: true });
          console.error(
            c.red(
              `review: CodeRabbit is required but PR #${prNumber} lacks the ` +
                `\`${CODERABBIT_READY_LABEL}\` label. Add it, then resume ship.`
            )
          );
          return { code: SHIP_EXIT.MERGE_BLOCKED, records };
        }

        if (state.codeRabbitRefreshRequired) {
          const request = ghExec([
            "pr",
            "comment",
            String(prNumber),
            ...(slug ? ["--repo", slug] : []),
            "--body",
            "@coderabbitai review",
          ]);
          if (request?.code !== 0) {
            record("review", { round, codeRabbitRequestFailed: true, code: request?.code });
            console.error(
              c.red(
                `review: could not request a fresh CodeRabbit review (${request?.stderr || "unknown error"}) — blocking.`
              )
            );
            return { code: SHIP_EXIT.MERGE_BLOCKED, records };
          }
        }

        const wfbCode = waitForBots([
          "--pr",
          String(prNumber),
          ...(slug ? ["--repo", slug] : []),
          "--bots",
          "coderabbitai[bot]",
          "--timeout",
          "10",
        ]);
        if (wfbCode !== 0) {
          record("review", { round, codeRabbitUnavailable: wfbCode });
          const why = wfbCode === 2 ? "timed out" : `exited ${wfbCode} (gate could not run)`;
          console.error(
            c.red(
              `review: current-head CodeRabbit review unavailable — wait-for-bots ${why}; blocking.`
            )
          );
          return { code: SHIP_EXIT.MERGE_BLOCKED, records };
        }
        // Keep a pending refresh durable across timeouts. Only substantive current-head
        // evidence can clear the request flag; a command acknowledgment is not evidence.
        saveState({ codeRabbitRefreshRequired: false, codeRabbitHead: localEvidence.head });
      } else if (state.codeRabbitRefreshRequired) {
        saveState({ codeRabbitRefreshRequired: false, codeRabbitHead: null });
      }

      // GPT-5.5 PR review via the configured model. Skipped only when the operator drops
      // "gpt-5.5". A
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
            buildGptReviewPrompt(plan, prDiff, prNumber, constitution),
            gptCfg.timeoutMs ?? 300 * 1000,
            {
              extraArgs: [
                "--force",
                "--trust",
                ...(gptCfg.model ? ["--model", cursorCliModelArg(gptCfg.model)] : []),
              ],
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
        "--local-bugbot-review",
        localEvidence.path,
      ];
      if (isLightLoop) consolidateArgs.push("--loop-profile", "light");
      if (gptReviewFile) consolidateArgs.push("--gpt-review", gptReviewFile);
      if (slug) consolidateArgs.push("--repo", slug);
      const verdictCode = await consolidateDep(repo, consolidateArgs);
      record("review", { round, verdictCode });

      if (verdictCode === 0) {
        saveState({
          reviewClear: true,
          reviewHead: localEvidence.head,
          reviewBaseSha: localEvidence.baseSha,
          reviewSafetyRequired: reviewPolicy.safetyRequired,
          reviewCodeRabbitRequired: reviewPolicy.codeRabbitRequired,
          reviewers: effectiveReviewers,
        });
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
          opts: makeBuildOpts({
            branch,
            issue: issueId,
            logFile: buildLog,
            findingsFile,
            constitution,
            profile: isLightLoop ? "light" : null,
            builderContext,
          }),
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
      invalidateReviewEvidence({
        codeRabbitRefreshRequired: reviewPolicy.codeRabbitRequired,
        reviewRound: round + 1,
      });
      round++;
    }

  // ── 7b. SIMPLIFY — post-review, pre-merge cleanup pass (advisory) ───────────────
  // One cheap-model, behavior-preserving pass over the branch diff after the review
  // loop clears (runSimplify reverts itself on any failure, so this stage can slow a
  // ship but never block one). A kept cleanup is a new changeset: invalidate every review
  // checkpoint and require a resumed exact-head review instead of relabeling stale evidence.
  if (!opts.noSimplify && !state.simplifyDone && !state.merged) {
    const simplifyDep = deps.runSimplify ?? runSimplify;
    const sCfg = models.simplify;
    progress("simplify: post-review cleanup pass started");
    const sRes = await simplifyDep({
      worktree: worktreePath,
      baseSha: "origin/main",
      branch,
      model: sCfg.model,
      effort: sCfg.effort,
      timeoutMs: sCfg.timeoutMs ?? 600 * 1000,
      verify: SHIP_VERIFY_CMD,
      constitution,
    });
    writeAudit(issueId, "simplify.md", sRes.output ?? "(no output)");
    record("simplify", { changed: sRes.changed, ok: sRes.ok, reverted: sRes.reverted });
    if (sRes.changed) {
      let pushed = true;
      try {
        await cmdPrDep(repo, ["--branch", branch, "--issue", issue.identifier], {
          throwOnError: true,
        });
      } catch (e) {
        // A push failure would strand the cleanup commit locally while GitHub merges
        // the un-simplified head — drop the commit instead (advisory contract).
        pushed = false;
        record("simplify", { pushError: e.message });
        if (state.reviewHead) {
          try {
            gitExec(["reset", "--hard", state.reviewHead], worktreePath);
          } catch {
            /* worktree cleanup is best-effort; the merge proceeds from the remote head */
          }
        }
      }
      if (pushed) {
        invalidateReviewEvidence({
          simplifyDone: true,
          codeRabbitRefreshRequired: !!state.reviewCodeRabbitRequired,
          reviewRound: round + 1,
        });
        progress("simplify: cleanup commit pushed — exact-head reviews invalidated");
        console.error(
          c.yellow(
            `simplify: resume with aios ship ${issueId} --resume to review the cleanup commit.`
          )
        );
        return { code: SHIP_EXIT.MERGE_BLOCKED, records };
      } else {
        saveState({ simplifyDone: true });
      }
    } else {
      saveState({ simplifyDone: true });
      progress(sRes.ok ? "simplify: no-op" : "simplify: pass discarded (reverted)");
    }
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
    // Re-check the canonical local artifact immediately before merge. A branch or verified-base
    // movement after consolidation invalidates the whole CLEAR checkpoint.
    let mergeSnapshot = null;
    try {
      mergeSnapshot = resolveReviewSnapshot();
    } catch {
      mergeSnapshot = null;
    }
    const mergeEvidenceStale =
      !mergeSnapshot ||
      mergeSnapshot.head !== state.reviewHead ||
      mergeSnapshot.baseSha !== state.reviewBaseSha ||
      !localBugbotEvidenceMatches(state, {
        ...(mergeSnapshot ?? {}),
        artifactExists,
      }) ||
      (state.reviewCodeRabbitRequired && state.codeRabbitHead !== mergeSnapshot?.head);
    if (mergeEvidenceStale) {
      const headMoved = !!mergeSnapshot && mergeSnapshot.head !== state.reviewHead;
      invalidateReviewEvidence({
        codeRabbitRefreshRequired: headMoved && !!state.reviewCodeRabbitRequired,
      });
      record("merge-gate", { staleReviewEvidence: true });
      console.error(
        c.red(
          "merge gate: reviewed head/base evidence is stale — resume to run a fresh review round."
        )
      );
      return { code: SHIP_EXIT.MERGE_BLOCKED, records };
    }

    // `gh pr merge` merges GITHUB's head, not the local ref. A commit pushed to the PR
    // branch by anyone else after the review would otherwise slip into the merge without
    // review evidence — require the remote head to equal the reviewed head, fail closed
    // when it cannot be read.
    let remoteHead = null;
    try {
      const headRes = ghExec([
        "pr",
        "view",
        String(prNumber),
        ...(slug ? ["--repo", slug] : []),
        "--json",
        "headRefOid",
        "--jq",
        ".headRefOid",
      ]);
      if (headRes?.code === 0) remoteHead = (headRes.stdout ?? "").trim() || null;
    } catch {
      remoteHead = null;
    }
    if (!remoteHead || remoteHead !== state.reviewHead) {
      record("merge-gate", { remoteHeadMismatch: true, remoteHead });
      console.error(
        c.red(
          remoteHead
            ? "merge gate: the PR head on GitHub does not match the reviewed head — fetch the branch, re-review, and resume."
            : "merge gate: could not verify the PR head on GitHub — blocking (fail closed)."
        )
      );
      return { code: SHIP_EXIT.MERGE_BLOCKED, records };
    }

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

    // Changed-path metadata is REQUIRED to decide whether the safety surface is touched — if
    // `gh pr diff --name-only` fails (non-zero code or empty stdout) we cannot rule the surface
    // out, so we fail closed rather than treat "no data" as "no safety surface". ghExec returns
    // {code,stdout,stderr} without throwing; check code explicitly.
    //
    // The full loop uses path-gated inference alone. The light loop uses the SPEC_READY
    // frontmatter `safety: true` as its primary signal but STILL runs changed-path inference
    // as a defense-in-depth backstop: if the frontmatter is absent but the PR touches
    // safety-sensitive files, the safety review still fires (frontmatter OR path-level match).
    let changedPaths = [];
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
    changedPaths = nameStdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const safetyRequired = isLightLoop
      ? specSafetyDeclared || touchesSafetySurface(changedPaths)
      : touchesSafetySurface(changedPaths);
    if (
      safetyRequired &&
      (!state.reviewSafetyRequired ||
        !state.reviewCodeRabbitRequired ||
        state.codeRabbitHead !== state.reviewHead)
    ) {
      // Defense in depth against path-classification drift or eventual-consistency races between
      // the review round and merge gate. Safety can never proceed without current-head CodeRabbit.
      invalidateReviewEvidence({ codeRabbitRefreshRequired: true }, { preserveLocalBugbot: true });
      record("merge-gate", { safetyReviewPolicyStale: true });
      console.error(
        c.red(
          "merge gate: safety-sensitive diff lacks current-head CodeRabbit evidence — resume for a fresh review round."
        )
      );
      return { code: SHIP_EXIT.SAFETY_BLOCKED, records };
    }
    if (safetyRequired && gates.merge === "skip") {
      record("merge-gate", { safetyAutoMergeRejected: true });
      console.error(
        c.red(
          "merge gate: --auto-merge cannot bypass operator approval for safety-sensitive changes."
        )
      );
      return { code: SHIP_EXIT.SAFETY_BLOCKED, records };
    }
    if (safetyRequired) {
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
        const safety = await promptCall({
          model: cfg.model,
          prompt: buildSafetyPrompt(diffRes.stdout, changedPaths),
          timeoutMs: cfg.timeoutMs ?? 300 * 1000,
          opts: {
            extraArgs: [...NO_TOOLS_ARGS, ...(cfg.effort ? ["--effort", cfg.effort] : [])],
          },
        });
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
      "  --auto-merge           skip the merge gate for Standard PRs (rejected for Safety PRs)",
      "  --reviewers <list>     optional reviewers: gpt-5.5 (default), coderabbit; local Bugbot always runs",
      "  --builder-skill <id>   focused builder skill (repeatable, maximum 2; overrides spec skills)",
      "                         (`bugbot` is accepted temporarily as a deprecated no-op alias)",
      "  --max-fix-rounds N     outer review→fix cycles (default: 3)",
      "  --no-simplify          skip the post-review simplify pass (stage 8b — cheap-model",
      "                         cleanup on the reviewed diff; verify-gated, advisory)",
      "  --plan-runner cli|sdk  plan-stage runner (default: cli — Claude Code login auth; sdk drives",
      "                         Opus via the Anthropic SDK and needs a funded ANTHROPIC_API_KEY)",
      "  --loop full|light      full plan/review loop (default), or SPEC_READY spec-derived light loop",
      "  --dry-run              print the resolved step plan; no side effects (a resolvable",
      "                         LINEAR_API_KEY only enables a best-effort issue-title fetch)",
      "  --resume               re-enter at the first incomplete stage (state.json checkpoint)",
      "  --approve-plan         satisfy a pending PLAN gate (use with --resume after inspecting",
      "                         .aios/loop/<issue>/GATE-plan.pending.md)",
      "  --approve-merge        satisfy a pending MERGE gate (use with --resume)",
      "  --spec-gate <policy>   spec-readiness enforcement: block (default) | advisory (warn+proceed) | off",
      "  --skip-spec-gate       alias for --spec-gate off (logged loudly; escape hatch only)",
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
  if (opts.deprecatedBugbotReviewer) {
    console.warn(
      c.yellow(
        "warning: `bugbot` in --reviewers is deprecated and ignored; Local Bugbot is mandatory " +
          "for every ship run. Use `coderabbit` and/or `gpt-5.5` to select optional reviewers."
      )
    );
  }

  let models;
  try {
    models = resolveLoopModels({ repo, profile: opts.loop === "light" ? "light" : null });
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
        loop: opts.loop,
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
