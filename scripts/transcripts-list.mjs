import { loadTranscriptEngine } from "./transcripts-engine.mjs";
import { displayPath } from "./transcripts-runtime.mjs";

export async function runListCommand(root, deps) {
  const engine = await loadTranscriptEngine(deps);
  const listing = engine.listTranscriptReviewStages(root);
  const payload = { command: "list", ...listing };
  const stageLines = listing.stages.map((stage) => {
    const version = stage.version === 1 ? "legacy_v1" : stage.status;
    return `${version}  ${stage.decisions} decisions + ${stage.tasks} tasks  ${displayPath(stage.path)}`;
  });
  const diagnosticLines = listing.diagnostics.map(
    (item) =>
      `invalid  0 decisions + 0 tasks  ${displayPath(item.path)}  diagnostics: stage unavailable`
  );
  const lines = [...stageLines, ...diagnosticLines];
  return {
    code: 0,
    payload,
    text: lines.length ? lines.join("\n") : "no transcript review stages",
  };
}
