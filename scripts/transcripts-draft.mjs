import { loadTranscriptEngine, parseV2Stage, statusExit } from "./transcripts-engine.mjs";
import { createTranscriptPhaseRunner, loadPhaseFixture } from "./transcripts-phases.mjs";
import { argValue, nowProvider, rubricBudget, stageRelative } from "./transcripts-runtime.mjs";

function transcriptPaths(args) {
  return String(argValue(args, "--transcripts") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function stagedPayload(root, result, stage) {
  return {
    command: "draft",
    outcome: "staged",
    status: stage.status,
    stage: stageRelative(root, result.stagePath),
    decisions: stage.decisions.length,
    tasks: stage.tasks.length,
  };
}

function noChangesPayload(result) {
  return {
    command: "draft",
    outcome: "no_changes",
    status: "no_changes",
    decisions: 0,
    tasks: 0,
    loops: result.loops?.length ?? 0,
  };
}

export async function runDraftCommand(root, args, deps) {
  const paths = transcriptPaths(args);
  if (!paths.length) throw new Error("pass at least one transcript with --transcripts");
  const fixture = loadPhaseFixture(root, argValue(args, "--from-json"));
  const runPhase =
    deps.runPhase ??
    createTranscriptPhaseRunner({
      fixture,
      model: argValue(args, "--model") ?? "deepseek:deepseek-chat",
      modelCall: deps.modelCall,
    });
  const engine = await loadTranscriptEngine(deps);
  const result = await engine.draftTranscriptReview({
    root,
    transcriptPaths: paths,
    rubricBudget: rubricBudget(args),
    runPhase,
    now: nowProvider(deps),
  });
  if (result.outcome === "no_changes") {
    const payload = noChangesPayload(result);
    return { code: 0, payload, text: "draft no_changes: 0 decisions + 0 tasks" };
  }
  const stage = parseV2Stage(engine, result.stage);
  const payload = stagedPayload(root, result, stage);
  return {
    code: statusExit(stage.status),
    payload,
    text: `draft ${stage.status}: ${payload.decisions} decisions + ${payload.tasks} tasks — ${payload.stage}`,
  };
}
