import type { DraftTranscriptReviewOptions } from "./contracts.js";
import type { DraftTranscriptReviewResult } from "./models.js";
import { evaluateReview } from "./evaluation.js";
import { finalizeReview } from "./finalize.js";
import { readLiveLogs, readTranscripts, timestamp } from "./workspace.js";

export async function draftTranscriptReview(
  options: DraftTranscriptReviewOptions
): Promise<DraftTranscriptReviewResult> {
  const createdAt = timestamp(options.now);
  const transcripts = readTranscripts(options.root, options.transcriptPaths);
  const liveLogs = readLiveLogs(options.root);
  const evaluation = await evaluateReview({
    runPhase: options.runPhase,
    transcripts,
    liveLogs,
    rubricBudget: options.rubricBudget,
  });
  return finalizeReview({
    root: options.root,
    evaluation,
    transcripts,
    rubricBudget: options.rubricBudget,
    createdAt,
  });
}
