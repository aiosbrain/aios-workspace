import type {
  CandidateBatch,
  DraftTranscriptReviewResult,
  GradeReport,
  PreparedTranscript,
  ReviewDiagnostic,
  TranscriptReviewStageV2,
  VerificationReport,
} from "./models.js";

export type LiveLogIndex = {
  readonly path: string;
  readonly content: string;
  readonly keys: readonly string[];
  readonly nextNumber: number;
};

export type LiveLogs = {
  readonly decisions: LiveLogIndex;
  readonly tasks: LiveLogIndex;
};

type CandidateInput = CandidateBatch & {
  readonly transcripts: readonly PreparedTranscript[];
  readonly liveLogs: LiveLogs;
};

export type TranscriptPhaseRequest =
  | {
      readonly phase: "extract";
      readonly input: {
        readonly transcript: PreparedTranscript;
        readonly liveLogs: LiveLogs;
      };
    }
  | { readonly phase: "deduplicate"; readonly input: CandidateInput }
  | { readonly phase: "verify"; readonly input: CandidateInput }
  | { readonly phase: "grade"; readonly input: CandidateInput }
  | {
      readonly phase: "correct";
      readonly input: CandidateInput & {
        readonly report: GradeReport;
        readonly attempt: number;
      };
    };

export type TranscriptPhaseRunner = (request: TranscriptPhaseRequest) => Promise<unknown>;
export type TimeSource = string | (() => string);

export type DraftTranscriptReviewOptions = {
  readonly root: string;
  readonly transcriptPaths: readonly string[];
  readonly rubricBudget: number;
  readonly runPhase: TranscriptPhaseRunner;
  readonly now?: TimeSource;
};

export type MigrateTranscriptStageV1Options = {
  readonly root: string;
  readonly stagePath: string;
  readonly rubricBudget?: number;
  readonly runPhase: TranscriptPhaseRunner;
  readonly now?: TimeSource;
};

export type ApplyPendingTranscriptStageOptions = {
  readonly root: string;
  readonly stagePath: string;
  readonly now?: TimeSource;
  readonly beforeLogReplace?: (log: "decisions" | "tasks") => void;
};

export type ApplyResult = {
  readonly stagePath: string;
  readonly stage: Extract<TranscriptReviewStageV2, { readonly status: "approved" }>;
  readonly decisionsAdded: number;
  readonly tasksAdded: number;
};

export type RecordTranscriptPushAttemptOptions = {
  readonly root: string;
  readonly stagePath: string;
  readonly state: "skipped" | "pending" | "failed" | "succeeded";
  readonly attemptId?: string;
  readonly now?: TimeSource;
  readonly diagnostics?: readonly (ReviewDiagnostic | string)[];
};

export type RecordTranscriptPushAttemptResult = {
  readonly attemptId?: string;
  readonly stage: Extract<TranscriptReviewStageV2, { readonly status: "approved" }>;
};

export type EvaluationResult =
  | {
      readonly kind: "review";
      readonly stage: Omit<
        | Extract<TranscriptReviewStageV2, { readonly status: "pending_review" }>
        | Extract<TranscriptReviewStageV2, { readonly status: "failed_rubric" }>
        | Extract<TranscriptReviewStageV2, { readonly status: "grading_error" }>,
        "id" | "createdAt" | "reviewDigest"
      >;
    }
  | Extract<DraftTranscriptReviewResult, { readonly outcome: "no_changes" }>;

export type CompletedGrade = {
  readonly candidates: CandidateBatch;
  readonly verification: VerificationReport;
  readonly report: GradeReport;
};
