import { TranscriptReviewError } from "./errors.js";
import {
  CRITERION_IDS,
  type CriterionId,
  type CriterionOutcome,
  type CriterionReport,
  type GradeReport,
  type GradeVerdict,
  type VerificationReport,
} from "./models.js";
import { arrayValue, booleanValue, literal, record, stringArray } from "./parse.js";

const OUTCOMES = ["pass", "fail", "error"] as const;
const VERDICTS = ["pass", "fail", "error"] as const;

function classification(id: CriterionId): "must" | "advisory" {
  return id === "TD5" ? "advisory" : "must";
}

function criterion(value: unknown, label: string): CriterionReport {
  const item = record(value, label);
  const id = literal(item["id"], CRITERION_IDS, `${label}.id`);
  const parsedClassification = literal(
    item["classification"],
    ["must", "advisory"] as const,
    `${label}.classification`
  );
  if (parsedClassification !== classification(id)) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `${label}.classification is invalid for ${id}`
    );
  }
  return {
    id,
    classification: parsedClassification,
    outcome: literal(item["outcome"], OUTCOMES, `${label}.outcome`),
    findings: stringArray(item["findings"], `${label}.findings`),
    candidateIds: stringArray(item["candidateIds"], `${label}.candidateIds`),
    transcriptPaths: stringArray(item["transcriptPaths"], `${label}.transcriptPaths`),
    evidence: stringArray(item["evidence"], `${label}.evidence`),
  };
}

function criteria(value: unknown, expected: readonly CriterionId[]): readonly CriterionReport[] {
  const parsed = arrayValue(value, "criteria").map((item, index) =>
    criterion(item, `criteria[${index}]`)
  );
  if (parsed.length !== expected.length) {
    throw new TranscriptReviewError("invalid_input", 2, "grade report has incomplete criteria");
  }
  for (const id of expected) {
    if (parsed.filter((item) => item.id === id).length !== 1) {
      throw new TranscriptReviewError("invalid_input", 2, `grade report must contain ${id} once`);
    }
  }
  return expected.map((id) => {
    const found = parsed.find((item) => item.id === id);
    if (found === undefined) {
      throw new TranscriptReviewError("invalid_input", 2, `grade report is missing ${id}`);
    }
    return found;
  });
}

function verdictFor(criteriaReports: readonly CriterionReport[]): GradeVerdict {
  const mandatory = criteriaReports.filter((item) => item.classification === "must");
  if (mandatory.some((item) => item.outcome === "error")) return "error";
  return mandatory.some((item) => item.outcome === "fail") ? "fail" : "pass";
}

function requireConsistentVerdict(
  verdict: GradeVerdict,
  criteriaReports: readonly CriterionReport[],
  label: string
): void {
  if (verdict !== verdictFor(criteriaReports)) {
    throw new TranscriptReviewError(
      "invalid_input",
      2,
      `${label}.verdict is inconsistent with mandatory criterion outcomes`
    );
  }
}

function canonicalPhaseReport(
  value: unknown,
  label: string,
  expected: readonly CriterionId[]
): unknown {
  const report = record(value, label);
  const normalizedCriteria = arrayValue(report["criteria"], "criteria").map((value, index) => {
    const item = record(value, `criteria[${index}]`);
    const id = literal(item["id"], CRITERION_IDS, `criteria[${index}].id`);
    return { ...item, classification: classification(id) };
  });
  const normalizedVerdict = verdictFor(criteria(normalizedCriteria, expected));
  return { ...report, verdict: normalizedVerdict, criteria: normalizedCriteria };
}

export function parseGradeReport(value: unknown): GradeReport {
  const report = record(value, "grade report");
  const verdict = literal(report["verdict"], VERDICTS, "gradeReport.verdict");
  const criteriaReports = criteria(report["criteria"], CRITERION_IDS);
  requireConsistentVerdict(verdict, criteriaReports, "gradeReport");
  return {
    verdict,
    certifiedNoChanges:
      report["certifiedNoChanges"] === undefined
        ? false
        : booleanValue(report["certifiedNoChanges"], "gradeReport.certifiedNoChanges"),
    criteria: criteriaReports,
  };
}

export function parseVerificationReport(value: unknown): VerificationReport {
  const report = record(value, "verification report");
  const verdict = literal(report["verdict"], VERDICTS, "verificationReport.verdict");
  const criteriaReports = criteria(report["criteria"], [
    "TD1",
    "TD2",
    "TD3",
    "TD4",
    "TD5",
  ] as const);
  requireConsistentVerdict(verdict, criteriaReports, "verificationReport");
  return {
    verdict,
    criteria: criteriaReports,
  };
}

export function parsePhaseGradeReport(value: unknown): GradeReport {
  return parseGradeReport(canonicalPhaseReport(value, "grade report", CRITERION_IDS));
}

export function parsePhaseVerificationReport(value: unknown): VerificationReport {
  return parseVerificationReport(
    canonicalPhaseReport(value, "verification report", ["TD1", "TD2", "TD3", "TD4", "TD5"])
  );
}

export function errorGradeReport(message: string): GradeReport {
  return {
    verdict: "error",
    certifiedNoChanges: false,
    criteria: CRITERION_IDS.map((id) => ({
      id,
      classification: classification(id),
      outcome: "error",
      findings: [message],
      candidateIds: [],
      transcriptPaths: [],
      evidence: [],
    })),
  };
}

function mergeStrings(first: readonly string[], second: readonly string[]): readonly string[] {
  return [...new Set([...first, ...second])];
}

function mergedOutcome(
  grade: CriterionOutcome,
  verified: CriterionOutcome | undefined
): CriterionOutcome {
  if (grade === "error" || verified === "error") return "error";
  if (grade === "fail" || verified === "fail") return "fail";
  return "pass";
}

export function mergeReports(verification: VerificationReport, grade: GradeReport): GradeReport {
  const merged = grade.criteria.map((graded) => {
    const verified = verification.criteria.find((item) => item.id === graded.id);
    if (verified === undefined) return graded;
    return {
      ...graded,
      outcome: mergedOutcome(graded.outcome, verified.outcome),
      findings: mergeStrings(graded.findings, verified.findings),
      candidateIds: mergeStrings(graded.candidateIds, verified.candidateIds),
      transcriptPaths: mergeStrings(graded.transcriptPaths, verified.transcriptPaths),
      evidence: mergeStrings(graded.evidence, verified.evidence),
    };
  });
  const hasError = merged.some(
    (item) => item.classification === "must" && item.outcome === "error"
  );
  const hasFailure = merged.some(
    (item) => item.classification === "must" && item.outcome === "fail"
  );
  return {
    verdict: hasError ? "error" : hasFailure ? "fail" : "pass",
    certifiedNoChanges: grade.certifiedNoChanges,
    criteria: merged,
  };
}

export function hasMustFailure(report: GradeReport): boolean {
  return report.criteria.some((item) => item.classification === "must" && item.outcome !== "pass");
}
