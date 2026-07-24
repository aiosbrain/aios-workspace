import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadTranscriptEngine, parseV2Stage, statusExit } from "./transcripts-engine.mjs";
import { createTranscriptPhaseRunner } from "./transcripts-phases.mjs";
import {
  TranscriptCliError,
  argValue,
  invalidRequest,
  nowProvider,
  readStageSource,
  rubricBudget,
  stageRelative,
} from "./transcripts-runtime.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

async function defaultPush(root) {
  await execFileAsync(
    process.execPath,
    [path.join(SCRIPT_DIR, "aios.mjs"), "push", "--repo", root],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }
  );
}

function diagnostic(error, root) {
  return String(error?.message ?? error ?? "push failed")
    .replaceAll(path.resolve(root), "[workspace]")
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function classifyStageError(error) {
  const message = String(error?.message ?? error);
  if (error?.exitCode === 1 || error?.exitCode === 2) {
    return new TranscriptCliError(message, error.exitCode);
  }
  if (/not found|unreadable|lock|busy|write|rename|permission|EACCES|ENOENT|EIO/i.test(message)) {
    return new TranscriptCliError(message, 1);
  }
  return invalidRequest(error);
}

function reviewPayload(root, stagePath, stage, source = null) {
  const local =
    stage.status === "approved"
      ? {
          state: "approved",
          decisionsAdded: stage.apply.decisionsAdded,
          tasksAdded: stage.apply.tasksAdded,
          decisionLogChanged: stage.apply.decisionLogChanged,
          taskLogChanged: stage.apply.taskLogChanged,
        }
      : { state: "not_applied" };
  return {
    command: "approve",
    ...(source ? { source } : {}),
    review: {
      version: 2,
      stage: stageRelative(root, stagePath),
      status: stage.status,
      decisions: stage.decisions.length,
      tasks: stage.tasks.length,
    },
    local,
    push: { state: stage.push?.state ?? "not_requested" },
  };
}

function reviewText(payload) {
  const source = payload.source ? `source: v1 ${payload.source.state}; ` : "";
  const review = `review: v2 ${payload.review.status} (${payload.review.stage}); `;
  return `${source}${review}local: ${payload.local.state}; push: ${payload.push.state}`;
}

function rereadV2(root, stagePath, engine) {
  const stored = readStageSource(root, stagePath);
  return parseV2Stage(engine, stored.source);
}

async function recordPush(engine, options) {
  return await engine.recordTranscriptPushAttempt(options);
}

function bookkeepingFailure(root, stagePath, stage, engine, source) {
  try {
    stage = rereadV2(root, stagePath, engine);
  } catch {
    // The last validated approved record still proves that local apply completed.
  }
  const payload = reviewPayload(root, stagePath, stage, source);
  payload.push = { state: stage.push?.state ?? "not_requested", error: "bookkeeping_failed" };
  return { code: 1, payload, text: `${reviewText(payload)} (bookkeeping failed)` };
}

async function handlePush({ root, stagePath, stage, engine, deps, noPush, source }) {
  if (noPush) {
    if (!new Set(["skipped", "succeeded"]).has(stage.push.state)) {
      try {
        await recordPush(engine, {
          root,
          stagePath,
          state: "skipped",
          now: nowProvider(deps),
        });
      } catch {
        return bookkeepingFailure(root, stagePath, stage, engine, source);
      }
      stage = rereadV2(root, stagePath, engine);
    }
    const payload = reviewPayload(root, stagePath, stage, source);
    return { code: 0, payload, text: reviewText(payload) };
  }
  if (new Set(["skipped", "succeeded"]).has(stage.push.state)) {
    const payload = reviewPayload(root, stagePath, stage, source);
    return { code: 0, payload, text: reviewText(payload) };
  }
  if (
    stage.push.state === "not_requested" &&
    !stage.apply.decisionLogChanged &&
    !stage.apply.taskLogChanged
  ) {
    const payload = reviewPayload(root, stagePath, stage, source);
    return { code: 0, payload, text: reviewText(payload) };
  }
  let started;
  try {
    started = await recordPush(engine, {
      root,
      stagePath,
      state: "pending",
      now: nowProvider(deps),
    });
  } catch {
    return bookkeepingFailure(root, stagePath, stage, engine, source);
  }
  const attemptId = started?.attemptId ?? started?.id;
  let pushError = null;
  try {
    await (deps.push ?? defaultPush)(root);
  } catch (error) {
    pushError = error;
  }
  try {
    await recordPush(engine, {
      root,
      stagePath,
      state: pushError ? "failed" : "succeeded",
      attemptId,
      ...(pushError ? { diagnostics: [diagnostic(pushError, root)] } : {}),
      now: nowProvider(deps),
    });
  } catch {
    return bookkeepingFailure(root, stagePath, stage, engine, source);
  }
  stage = rereadV2(root, stagePath, engine);
  const payload = reviewPayload(root, stagePath, stage, source);
  return { code: pushError ? 1 : 0, payload, text: reviewText(payload) };
}

async function upgradeV1({ root, record, args, deps, engine }) {
  const runPhase =
    deps.runPhase ??
    createTranscriptPhaseRunner({
      model: argValue(args, "--model") ?? "deepseek:deepseek-chat",
      modelCall: deps.modelCall,
    });
  let result;
  try {
    result = await engine.migrateTranscriptStageV1({
      root,
      stagePath: record.stagePath,
      rubricBudget: rubricBudget(args, 0),
      runPhase,
      now: nowProvider(deps),
    });
  } catch (error) {
    throw classifyStageError(error);
  }
  const source = { version: 1, state: "regraded", stage: stageRelative(root, record.stagePath) };
  if (result.outcome === "no_changes") {
    const payload = {
      command: "approve",
      source,
      review: { version: 2, status: "no_changes", decisions: 0, tasks: 0 },
      local: { state: "not_applied" },
      push: { state: "not_requested" },
    };
    return {
      done: {
        code: 0,
        payload,
        text: "source: v1 regraded; review: no_changes; local: not_applied; push: not_requested",
      },
    };
  }
  const stage = parseV2Stage(engine, result.stage);
  if (stage.status !== "pending_review") {
    const payload = reviewPayload(root, result.stagePath, stage, source);
    return { done: { code: statusExit(stage.status), payload, text: reviewText(payload) } };
  }
  return { stagePath: result.stagePath, stage, source };
}

export async function runApproveCommand(root, args, deps) {
  const requested = args[1];
  if (!requested || requested.startsWith("--")) {
    throw new TranscriptCliError("usage: aios transcripts approve <stage-file> [--no-push]", 2);
  }
  let record;
  try {
    record = readStageSource(root, requested);
  } catch (error) {
    throw classifyStageError(error);
  }
  const engine = await loadTranscriptEngine(deps);
  let stagePath = record.stagePath;
  let source = null;
  let stage;
  if (record.value?.version === 1) {
    const upgraded = await upgradeV1({ root, record, args, deps, engine });
    if (upgraded.done) return upgraded.done;
    ({ stagePath, stage, source } = upgraded);
  } else {
    try {
      stage = parseV2Stage(engine, record.source);
    } catch (error) {
      throw invalidRequest(error);
    }
  }
  if (stage.status === "pending_review") {
    try {
      engine.applyPendingTranscriptStage({ root, stagePath, now: nowProvider(deps) });
      stage = rereadV2(root, stagePath, engine);
    } catch (error) {
      throw classifyStageError(error);
    }
  } else if (stage.status !== "approved") {
    const payload = reviewPayload(root, stagePath, stage, source);
    return { code: 2, payload, text: reviewText(payload) };
  }
  return handlePush({
    root,
    stagePath,
    stage,
    engine,
    deps,
    noPush: args.includes("--no-push"),
    source,
  });
}
