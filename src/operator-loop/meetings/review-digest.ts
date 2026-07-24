import { createHash } from "node:crypto";
import type {
  CandidateBatch,
  GradeReport,
  MigrationProvenance,
  ReviewDiagnostic,
  ReviewLoop,
  TranscriptMetadata,
  TranscriptReviewStageV2,
} from "./models.js";

export type ReviewedPayload = CandidateBatch & {
  readonly version: 2;
  readonly id: string;
  readonly createdAt: string;
  readonly access: "admin";
  readonly transcripts: readonly TranscriptMetadata[];
  readonly rubricBudget: number;
  readonly loopsUsed: number;
  readonly loops: readonly ReviewLoop[];
  readonly gradeReport: GradeReport;
  readonly diagnostics: readonly ReviewDiagnostic[];
  readonly migration?: MigrationProvenance;
};

export function computeReviewDigest(payload: ReviewedPayload | TranscriptReviewStageV2): string {
  const reviewed = {
    version: payload.version,
    id: payload.id,
    createdAt: payload.createdAt,
    access: payload.access,
    decisions: payload.decisions,
    tasks: payload.tasks,
    transcripts: payload.transcripts,
    rubricBudget: payload.rubricBudget,
    loopsUsed: payload.loopsUsed,
    loops: payload.loops,
    gradeReport: payload.gradeReport,
    diagnostics: payload.diagnostics,
    migration: payload.migration,
  };
  return createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
}
