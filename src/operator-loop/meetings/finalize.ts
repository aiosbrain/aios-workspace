import { randomUUID } from "node:crypto";
import type { DraftTranscriptReviewResult } from "./models.js";
import type { MigrationProvenance, PreparedTranscript, ReviewableStage } from "./models.js";
import type { ReviewEvaluation } from "./evaluation.js";
import { computeReviewDigest, type ReviewedPayload } from "./review-digest.js";
import { persistNewStage } from "./stage-store.js";

export type FinalizeReviewOptions = {
  readonly root: string;
  readonly evaluation: ReviewEvaluation;
  readonly transcripts: readonly PreparedTranscript[];
  readonly rubricBudget: number;
  readonly createdAt: string;
  readonly migration?: MigrationProvenance;
};

export function finalizeReview(options: FinalizeReviewOptions): DraftTranscriptReviewResult {
  const metadata = options.transcripts.map(({ content: _content, ...transcript }) => transcript);
  if (options.evaluation.status === "no_changes") {
    return {
      outcome: "no_changes",
      transcripts: metadata,
      rubricBudget: options.rubricBudget,
      loops: options.evaluation.loops,
      gradeReport: options.evaluation.gradeReport,
      diagnostics: options.evaluation.diagnostics,
    };
  }
  const payload: ReviewedPayload = {
    version: 2,
    id: randomUUID(),
    createdAt: options.createdAt,
    access: "admin",
    decisions: options.evaluation.decisions,
    tasks: options.evaluation.tasks,
    transcripts: metadata,
    rubricBudget: options.rubricBudget,
    loopsUsed: options.evaluation.loopsUsed,
    loops: options.evaluation.loops,
    gradeReport: options.evaluation.gradeReport,
    diagnostics: options.evaluation.diagnostics,
    migration: options.migration,
  };
  const stage: ReviewableStage = {
    ...payload,
    status: options.evaluation.status,
    push: { state: "not_requested", attempts: [] },
    reviewDigest: computeReviewDigest(payload),
  };
  const stagePath = persistNewStage(options.root, stage);
  return { outcome: "staged", stagePath, stage };
}
