import type { LiveLogs, TranscriptPhaseRunner } from "./contracts.js";
import { PhaseExecutionError } from "./errors.js";
import { TranscriptReviewError } from "./errors.js";
import type {
  CandidateBatch,
  GradeReport,
  PreparedTranscript,
  ReviewDiagnostic,
  ReviewLoop,
} from "./models.js";
import {
  correctCandidates,
  deduplicateCandidates,
  extractCandidates,
  gradeCandidates,
  type PhaseContext,
  verifyCandidates,
} from "./phases.js";
import { errorGradeReport, hasMustFailure, mergeReports } from "./report-schema.js";

export type ReviewEvaluation = CandidateBatch & {
  readonly status: "pending_review" | "failed_rubric" | "grading_error" | "no_changes";
  readonly loopsUsed: number;
  readonly loops: readonly ReviewLoop[];
  readonly gradeReport: GradeReport;
  readonly diagnostics: readonly ReviewDiagnostic[];
};

export type EvaluateOptions = {
  readonly runPhase: TranscriptPhaseRunner;
  readonly transcripts: readonly PreparedTranscript[];
  readonly liveLogs: LiveLogs;
  readonly rubricBudget: number;
  readonly initialCandidates?: CandidateBatch;
};

function context(options: EvaluateOptions, candidates: CandidateBatch): PhaseContext {
  return {
    runPhase: options.runPhase,
    transcripts: options.transcripts,
    liveLogs: options.liveLogs,
    ...candidates,
  };
}

async function completeGrade(
  options: EvaluateOptions,
  candidates: CandidateBatch
): Promise<{ readonly candidates: CandidateBatch; readonly gradeReport: GradeReport }> {
  const deduplicated = await deduplicateCandidates(context(options, candidates));
  const phaseContext = context(options, deduplicated);
  const verification = await verifyCandidates(phaseContext);
  const grade = await gradeCandidates(phaseContext);
  const merged = mergeReports(verification, grade);
  if (
    deduplicated.decisions.length === 0 &&
    deduplicated.tasks.length === 0 &&
    !merged.certifiedNoChanges &&
    merged.verdict === "pass"
  ) {
    return {
      candidates: deduplicated,
      gradeReport: {
        ...merged,
        verdict: "fail",
        criteria: merged.criteria.map((criterion) =>
          criterion.id === "TD6"
            ? {
                ...criterion,
                outcome: "fail",
                findings: [
                  ...criterion.findings,
                  "empty extraction was not certified transcript-wide",
                ],
              }
            : criterion
        ),
      },
    };
  }
  return { candidates: deduplicated, gradeReport: merged };
}

function loop(attempt: number, candidates: CandidateBatch, gradeReport: GradeReport): ReviewLoop {
  return {
    attempt,
    candidateCounts: {
      decisions: candidates.decisions.length,
      tasks: candidates.tasks.length,
    },
    gradeReport,
  };
}

function completedStatus(
  candidates: CandidateBatch,
  report: GradeReport
): ReviewEvaluation["status"] {
  if (report.verdict === "error") return "grading_error";
  if (hasMustFailure(report)) return "failed_rubric";
  if (
    candidates.decisions.length === 0 &&
    candidates.tasks.length === 0 &&
    report.certifiedNoChanges
  ) {
    return "no_changes";
  }
  return "pending_review";
}

export async function evaluateReview(options: EvaluateOptions): Promise<ReviewEvaluation> {
  if (!Number.isInteger(options.rubricBudget) || options.rubricBudget < 0) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      "rubricBudget must be a non-negative integer"
    );
  }
  let candidates: CandidateBatch = options.initialCandidates ?? { decisions: [], tasks: [] };
  let loopsUsed = 0;
  const loops: ReviewLoop[] = [];
  let lastReport: GradeReport | null = null;
  try {
    if (options.initialCandidates === undefined) {
      candidates = await extractCandidates(options.runPhase, options.transcripts, options.liveLogs);
    }
    let completed = await completeGrade(options, candidates);
    candidates = completed.candidates;
    lastReport = completed.gradeReport;
    loops.push(loop(0, candidates, lastReport));
    while (
      hasMustFailure(lastReport) &&
      lastReport.verdict !== "error" &&
      loopsUsed < options.rubricBudget
    ) {
      loopsUsed += 1;
      candidates = await correctCandidates({
        ...context(options, candidates),
        report: lastReport,
        attempt: loopsUsed,
      });
      completed = await completeGrade(options, candidates);
      candidates = completed.candidates;
      lastReport = completed.gradeReport;
      loops.push(loop(loopsUsed, candidates, lastReport));
    }
    return {
      status: completedStatus(candidates, lastReport),
      ...candidates,
      loopsUsed,
      loops,
      gradeReport: lastReport,
      diagnostics: [],
    };
  } catch (error) {
    if (!(error instanceof PhaseExecutionError)) throw error;
    const gradeReport = errorGradeReport(error.message);
    return {
      status: "grading_error",
      ...candidates,
      loopsUsed,
      loops,
      gradeReport,
      diagnostics: [{ phase: error.phase, message: error.message }],
    };
  }
}
