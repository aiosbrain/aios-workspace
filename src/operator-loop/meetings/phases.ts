import type { LiveLogs, TranscriptPhaseRequest, TranscriptPhaseRunner } from "./contracts.js";
import { parsePhaseCandidateBatch } from "./candidate-schema.js";
import { diagnosticMessage, PhaseExecutionError } from "./errors.js";
import { isNearVerbatim } from "./markdown.js";
import type {
  CandidateBatch,
  GradeReport,
  PreparedTranscript,
  VerificationReport,
} from "./models.js";
import { parsePhaseGradeReport, parsePhaseVerificationReport } from "./report-schema.js";

export type PhaseContext = CandidateBatch & {
  readonly runPhase: TranscriptPhaseRunner;
  readonly transcripts: readonly PreparedTranscript[];
  readonly liveLogs: LiveLogs;
};

async function invoke(
  runner: TranscriptPhaseRunner,
  request: TranscriptPhaseRequest
): Promise<unknown> {
  try {
    return await runner(request);
  } catch (error) {
    if (error instanceof PhaseExecutionError) throw error;
    throw new PhaseExecutionError(request.phase, diagnosticMessage(error), { cause: error });
  }
}

function parseOutput<T>(
  phase: TranscriptPhaseRequest["phase"],
  output: unknown,
  parser: (value: unknown) => T
): T {
  try {
    return parser(output);
  } catch (error) {
    if (error instanceof PhaseExecutionError) throw error;
    throw new PhaseExecutionError(phase, diagnosticMessage(error), { cause: error });
  }
}

export async function extractCandidates(
  runPhase: TranscriptPhaseRunner,
  transcripts: readonly PreparedTranscript[],
  liveLogs: LiveLogs
): Promise<CandidateBatch> {
  const outputs = await Promise.all(
    transcripts.map(async (transcript) => {
      const output = await invoke(runPhase, {
        phase: "extract",
        input: { transcript, liveLogs },
      });
      return parseOutput("extract", output, parsePhaseCandidateBatch);
    })
  );
  return {
    decisions: outputs.flatMap((batch) => batch.decisions),
    tasks: outputs.flatMap((batch) => batch.tasks),
  };
}

export async function deduplicateCandidates(context: PhaseContext): Promise<CandidateBatch> {
  const output = await invoke(context.runPhase, {
    phase: "deduplicate",
    input: {
      decisions: context.decisions,
      tasks: context.tasks,
      transcripts: context.transcripts,
      liveLogs: context.liveLogs,
    },
  });
  return parseOutput("deduplicate", output, parsePhaseCandidateBatch);
}

function deterministicTd1(context: PhaseContext): readonly string[] {
  const candidates = [...context.decisions, ...context.tasks];
  return candidates
    .filter((candidate) => {
      const transcript = context.transcripts.find((item) => item.path === candidate.transcript);
      return transcript === undefined || !isNearVerbatim(candidate.sourceQuote, transcript.content);
    })
    .map((candidate) => candidate.id);
}

function enforceTd1(report: VerificationReport, context: PhaseContext): VerificationReport {
  const failures = deterministicTd1(context);
  if (failures.length === 0) return report;
  return {
    verdict: "fail",
    criteria: report.criteria.map((criterion) =>
      criterion.id === "TD1"
        ? {
            ...criterion,
            outcome: "fail",
            findings: [
              ...criterion.findings,
              "source quote is not near-verbatim in its transcript",
            ],
            candidateIds: [...new Set([...criterion.candidateIds, ...failures])],
          }
        : criterion
    ),
  };
}

export async function verifyCandidates(context: PhaseContext): Promise<VerificationReport> {
  const output = await invoke(context.runPhase, {
    phase: "verify",
    input: {
      decisions: context.decisions,
      tasks: context.tasks,
      transcripts: context.transcripts,
      liveLogs: context.liveLogs,
    },
  });
  return enforceTd1(parseOutput("verify", output, parsePhaseVerificationReport), context);
}

export async function gradeCandidates(context: PhaseContext): Promise<GradeReport> {
  const output = await invoke(context.runPhase, {
    phase: "grade",
    input: {
      decisions: context.decisions,
      tasks: context.tasks,
      transcripts: context.transcripts,
      liveLogs: context.liveLogs,
    },
  });
  return parseOutput("grade", output, parsePhaseGradeReport);
}

export async function correctCandidates(
  context: PhaseContext & { readonly report: GradeReport; readonly attempt: number }
): Promise<CandidateBatch> {
  const output = await invoke(context.runPhase, {
    phase: "correct",
    input: {
      decisions: context.decisions,
      tasks: context.tasks,
      transcripts: context.transcripts,
      liveLogs: context.liveLogs,
      report: context.report,
      attempt: context.attempt,
    },
  });
  return parseOutput("correct", output, parsePhaseCandidateBatch);
}
