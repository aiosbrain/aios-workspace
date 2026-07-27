import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadOperatorLoop } from "./operator-loop-loader.mjs";

const CORE_EXPORTS = [
  "draftTranscriptReview",
  "parseTranscriptReviewStage",
  "applyPendingTranscriptStage",
  "migrateTranscriptStageV1",
  "recordTranscriptPushAttempt",
  "listTranscriptReviewStages",
];

const DIRECT_BARREL = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "operator-loop",
  "meetings",
  "index.js"
);

function hasCoreExports(engine) {
  return CORE_EXPORTS.every((name) => typeof engine?.[name] === "function");
}

export async function loadTranscriptEngine(deps = {}) {
  let engine = deps.engine ?? (await (deps.loadOperatorLoop ?? loadOperatorLoop)());
  if (!deps.engine && !hasCoreExports(engine)) {
    engine = await import(pathToFileURL(DIRECT_BARREL).href);
  }
  const missing = CORE_EXPORTS.filter((name) => typeof engine?.[name] !== "function");
  if (missing.length) {
    throw new Error(`operator-loop transcript engine is missing: ${missing.join(", ")}`);
  }
  return engine;
}

export function parseV2Stage(engine, value) {
  return engine.parseTranscriptReviewStage(value);
}

export function statusExit(status) {
  if (status === "pending_review" || status === "approved") return 0;
  if (status === "grading_error") return 1;
  return 2;
}
