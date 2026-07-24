export type TranscriptMetadata = {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly chars: number;
};

export type PreparedTranscript = TranscriptMetadata & {
  readonly content: string;
};

export type DecisionCandidate = {
  readonly id: string;
  readonly date: string;
  readonly decision: string;
  readonly rationale: string;
  readonly decidedBy: string;
  readonly impact: string;
  readonly type: 1 | 2 | 3;
  readonly audience: "admin" | "team" | "external";
  readonly transcript: string;
  readonly sourceQuote: string;
};

export type TaskCandidate = {
  readonly id: string;
  readonly task: string;
  readonly assignee: string;
  readonly status: string;
  readonly sprint: string;
  readonly due: string;
  readonly linear: string;
  readonly transcript: string;
  readonly sourceQuote: string;
};

export type CandidateBatch = {
  readonly decisions: readonly DecisionCandidate[];
  readonly tasks: readonly TaskCandidate[];
};

// 1.12 evidence kinds. Grounded (deterministic verbatim source-quote verification), NOT rubric-graded:
// they ride alongside decisions/tasks in the same stage and are applied under the same apply/push
// lock, but they never enter the TD1–TD6 rubric loop and are excluded from the reviewDigest.
export type EvidenceAccess = "admin" | "team" | "external";

export type FactCandidate = {
  readonly rowKey: string;
  readonly title: string;
  readonly occurredAt?: string;
  readonly factType: "fact" | "event";
  readonly access: EvidenceAccess;
  readonly transcript: string;
  readonly sourceQuote: string;
};

export type StakeholderMentionCandidate = {
  readonly rowKey: string;
  readonly name: string;
  readonly role?: string;
  readonly context?: string;
  readonly access: EvidenceAccess;
  readonly transcript: string;
  readonly sourceQuote: string;
};

export type EvidenceBatch = {
  readonly facts: readonly FactCandidate[];
  readonly stakeholderMentions: readonly StakeholderMentionCandidate[];
};

export const CRITERION_IDS = ["TD1", "TD2", "TD3", "TD4", "TD5", "TD6"] as const;
export type CriterionId = (typeof CRITERION_IDS)[number];
export type CriterionOutcome = "pass" | "fail" | "error";
export type GradeVerdict = "pass" | "fail" | "error";

export type CriterionReport = {
  readonly id: CriterionId;
  readonly classification: "must" | "advisory";
  readonly outcome: CriterionOutcome;
  readonly findings: readonly string[];
  readonly candidateIds: readonly string[];
  readonly transcriptPaths: readonly string[];
  readonly evidence: readonly string[];
};

export type GradeReport = {
  readonly verdict: GradeVerdict;
  readonly certifiedNoChanges: boolean;
  readonly criteria: readonly CriterionReport[];
};

export type VerificationReport = {
  readonly verdict: GradeVerdict;
  readonly criteria: readonly CriterionReport[];
};

export type ReviewDiagnostic = {
  readonly phase: string;
  readonly message: string;
};

export type ReviewLoop = {
  readonly attempt: number;
  readonly candidateCounts: {
    readonly decisions: number;
    readonly tasks: number;
  };
  readonly gradeReport: GradeReport;
};

export type PushAttempt = {
  readonly id: string;
  readonly state: "pending" | "failed" | "succeeded";
  readonly at: string;
  readonly diagnostics: readonly ReviewDiagnostic[];
};

export type PushRecord = {
  readonly state: "not_requested" | "skipped" | "pending" | "failed" | "succeeded";
  readonly attempts: readonly PushAttempt[];
};

export type MigrationProvenance = {
  readonly sourcePath: string;
  readonly sourceDigest: string;
  readonly sourceVersion: 1;
};

export type ApplyRecord = {
  readonly approvedAt: string;
  readonly decisionsAdded: number;
  readonly tasksAdded: number;
  readonly decisionLogChanged: boolean;
  readonly taskLogChanged: boolean;
  readonly factsAdded: number;
  readonly stakeholdersAdded: number;
};

type TranscriptReviewCommon = CandidateBatch &
  EvidenceBatch & {
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
    readonly push: PushRecord;
    readonly reviewDigest: string;
    readonly migration?: MigrationProvenance;
  };

export type TranscriptReviewStageV2 =
  | (TranscriptReviewCommon & { readonly status: "pending_review" })
  | (TranscriptReviewCommon & { readonly status: "failed_rubric" })
  | (TranscriptReviewCommon & { readonly status: "grading_error" })
  | (TranscriptReviewCommon & {
      readonly status: "approved";
      readonly apply: ApplyRecord;
    });

export type ReviewableStage = Exclude<TranscriptReviewStageV2, { readonly status: "approved" }>;

export type DraftTranscriptReviewResult =
  | {
      readonly outcome: "staged";
      readonly stagePath: string;
      readonly stage: ReviewableStage;
    }
  | {
      readonly outcome: "no_changes";
      readonly transcripts: readonly TranscriptMetadata[];
      readonly rubricBudget: number;
      readonly loops: readonly ReviewLoop[];
      readonly gradeReport: GradeReport;
      readonly diagnostics: readonly ReviewDiagnostic[];
    };

export type TranscriptReviewCounts = {
  readonly pendingStages: number;
  readonly decisions: number;
  readonly tasks: number;
  readonly failedRubric: number;
  readonly gradingErrors: number;
  readonly unreadableStages: number;
};

export type TranscriptStageSummary = {
  readonly path: string;
  readonly version: 1 | 2;
  readonly status: string;
  readonly createdAt: string;
  readonly decisions: number;
  readonly tasks: number;
  readonly pushState?: PushRecord["state"];
};

export type TranscriptStageList = {
  readonly stages: readonly TranscriptStageSummary[];
  readonly diagnostics: readonly { readonly path: string; readonly message: string }[];
};
