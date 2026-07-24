import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createTranscriptPhaseRunner } from "../scripts/transcripts-phases.mjs";
import {
  NOW,
  TRANSCRIPT_REL,
  assertReviewShape,
  decisions,
  gradeReport,
  loadMeetings,
  tasks,
  verificationReport,
  workspace,
} from "./helpers/transcript-pipeline.mjs";

const options = (root, runPhase, rubricBudget = 1) => ({
  root,
  transcriptPaths: [TRANSCRIPT_REL],
  rubricBudget,
  runPhase,
  now: () => NOW,
});

function providerRunner(...responses) {
  let index = 0;
  return createTranscriptPhaseRunner({
    model: "claude:claude-opus-4-8",
    modelCall: async () => {
      const response = responses[index];
      assert.notEqual(response, undefined, "unexpected extra provider phase call");
      index += 1;
      return JSON.stringify(response);
    },
  });
}

test("phase-boundary interruptions persist complete grading_error stages", async (t) => {
  const meetings = await loadMeetings();
  for (const interrupted of ["extract", "deduplicate", "verify", "grade", "correct"]) {
    await t.test(interrupted, async () => {
      const root = workspace();
      try {
        const runPhase = async ({ phase, input }) => {
          if (phase === interrupted) throw new Error(`synthetic ${phase} interruption`);
          if (phase === "extract" || phase === "correct") return { decisions, tasks };
          if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
          if (phase === "verify") return verificationReport();
          return gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } });
        };
        const result = await meetings.draftTranscriptReview(options(root, runPhase));
        assertReviewShape(result.stage, "grading_error");
        assert.equal(result.stage.gradeReport.verdict, "error");
        assert.ok(result.stage.gradeReport.criteria.every(({ outcome }) => outcome === "error"));
        assert.match(JSON.stringify(result.stage.diagnostics), new RegExp(interrupted));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("later correction-cycle interruptions preserve candidates and complete error evidence", async (t) => {
  const meetings = await loadMeetings();
  for (const interrupted of ["deduplicate", "verify", "grade", "correct"]) {
    await t.test(interrupted, async () => {
      const root = workspace();
      try {
        const occurrences = new Map();
        const runPhase = async ({ phase, input }) => {
          const occurrence = (occurrences.get(phase) ?? 0) + 1;
          occurrences.set(phase, occurrence);
          if (phase === interrupted && occurrence === 2) {
            throw new Error(`synthetic second ${phase} interruption`);
          }
          if (phase === "extract" || phase === "correct") return { decisions, tasks };
          if (phase === "deduplicate") {
            return { decisions: input.decisions, tasks: input.tasks };
          }
          if (phase === "verify") return verificationReport();
          return gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } });
        };
        const result = await meetings.draftTranscriptReview(options(root, runPhase, 2));
        assertReviewShape(result.stage, "grading_error");
        assert.deepEqual(result.stage.decisions, decisions);
        assert.deepEqual(result.stage.tasks, tasks);
        assert.ok(result.stage.loops.length >= 1);
        const firstLoop = result.stage.loops[0];
        assert.deepEqual(firstLoop.candidateCounts ?? firstLoop.counts, {
          decisions: decisions.length,
          tasks: tasks.length,
        });
        assert.equal((firstLoop.gradeReport ?? firstLoop.report).verdict, "fail");
        assert.equal(result.stage.gradeReport.verdict, "error");
        assert.ok(result.stage.gradeReport.criteria.every(({ outcome }) => outcome === "error"));
        assert.match(JSON.stringify(result.stage.diagnostics), new RegExp(`second ${interrupted}`));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("raw extract defaults an empty sprint from the observed Claude response", async () => {
  const meetings = await loadMeetings();
  const root = workspace();
  try {
    // Given: the sanitized real Haiku/Sonnet shape whose otherwise-valid task had `sprint: ""`.
    const observedTasks = [{ ...tasks[0], sprint: "" }];
    const runPhase = providerRunner(
      { decisions, tasks: observedTasks },
      { decisions, tasks: [{ ...tasks[0], sprint: "—" }] },
      verificationReport(),
      gradeReport()
    );

    // When: the raw provider-shaped output crosses the typed phase boundary.
    const result = await meetings.draftTranscriptReview(options(root, runPhase));

    // Then: deterministic missing scheduling metadata is canonical, not a grading error.
    assertReviewShape(result.stage, "pending_review");
    assert.equal(result.stage.tasks[0].sprint, "—");
    assert.deepEqual(result.stage.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw grade derives advisory TD5 from the observed Claude response", async () => {
  const meetings = await loadMeetings();
  const root = workspace();
  try {
    // Given: the sanitized real Opus shape whose complete report labeled TD5 as `must`.
    const observedGrade = gradeReport({
      verdict: "fail",
      failures: { TD5: [tasks[0].id] },
    });
    observedGrade.criteria[4].classification = "must";
    const runPhase = providerRunner(
      { decisions, tasks },
      { decisions, tasks },
      verificationReport(),
      observedGrade
    );

    // When: the raw provider-shaped report crosses the typed phase boundary.
    const result = await meetings.draftTranscriptReview(options(root, runPhase));

    // Then: criterion identity owns policy classification while semantic output is retained.
    assertReviewShape(result.stage, "pending_review");
    assert.equal(result.stage.gradeReport.verdict, "pass");
    assert.equal(result.stage.gradeReport.criteria[4].classification, "advisory");
    assert.deepEqual(result.stage.gradeReport.criteria[4].findings, ["TD5 synthetic finding"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw grade keeps a malformed semantic outcome as grading_error", async () => {
  const meetings = await loadMeetings();
  const root = workspace();
  try {
    // Given: deterministic report metadata is valid but a semantic criterion outcome is not.
    const malformedGrade = gradeReport();
    malformedGrade.criteria[1].outcome = "unknown";
    const runPhase = providerRunner(
      { decisions, tasks },
      { decisions, tasks },
      verificationReport(),
      malformedGrade
    );

    // When: the malformed provider response crosses the same raw phase boundary.
    const result = await meetings.draftTranscriptReview(options(root, runPhase));

    // Then: only deterministic metadata is derived; malformed semantics stay fail-closed.
    assertReviewShape(result.stage, "grading_error");
    assert.match(JSON.stringify(result.stage.diagnostics), /criteria\[1\]\.outcome/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted V2 stages reject non-canonical scheduling and TD5 metadata", async (t) => {
  const meetings = await loadMeetings();
  const root = workspace();
  try {
    // Given: a valid pending V2 stage produced by the engine.
    const result = await meetings.draftTranscriptReview(
      options(root, async ({ phase, input }) => {
        if (phase === "extract") return { decisions, tasks };
        if (phase === "deduplicate") {
          return { decisions: input.decisions, tasks: input.tasks };
        }
        if (phase === "verify") return verificationReport();
        return gradeReport();
      })
    );
    assertReviewShape(result.stage, "pending_review");

    await t.test("empty persisted sprint", () => {
      // When/Then: persisted input is parsed without the raw-model normalization boundary.
      const tampered = {
        ...result.stage,
        tasks: [{ ...result.stage.tasks[0], sprint: "" }],
      };
      assert.throws(
        () => meetings.parseTranscriptReviewStage(tampered),
        /tasks\[0\]\.sprint must be a non-empty string/
      );
    });

    await t.test("mandatory persisted TD5", () => {
      // When/Then: persisted canonical rubric policy remains fail-closed.
      const criteria = result.stage.gradeReport.criteria.map((criterionReport) =>
        criterionReport.id === "TD5"
          ? { ...criterionReport, classification: "must" }
          : criterionReport
      );
      const tampered = {
        ...result.stage,
        gradeReport: { ...result.stage.gradeReport, criteria },
      };
      assert.throws(
        () => meetings.parseTranscriptReviewStage(tampered),
        /criteria\[4\]\.classification is invalid for TD5/
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
