import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  NOW,
  TRANSCRIPT_REL,
  assertReviewShape,
  decisions,
  gradeReport,
  hallucinatedTask,
  loadMeetings,
  passingPhaseRunner,
  stageFiles,
  tasks,
  verificationReport,
  workspace,
} from "./helpers/transcript-pipeline.mjs";

const draftOptions = (root, runPhase, overrides = {}) => ({
  root,
  transcriptPaths: [TRANSCRIPT_REL],
  rubricBudget: 1,
  runPhase,
  now: () => NOW,
  ...overrides,
});

test("v2 pending_review persists the complete validated review record", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const seen = [];
    const result = await meetings.draftTranscriptReview(
      draftOptions(root, passingPhaseRunner({ seen, includeDuplicate: true }))
    );
    assert.equal(result.outcome, "staged");
    assertReviewShape(result.stage, "pending_review");
    assert.deepEqual(
      result.stage.decisions.map(({ id }) => id),
      decisions.map(({ id }) => id)
    );
    assert.deepEqual(
      result.stage.tasks.map(({ id }) => id),
      tasks.map(({ id }) => id)
    );
    assert.deepEqual(
      seen.map(({ phase }) => phase),
      ["extract", "deduplicate", "verify", "grade"]
    );
    assert.equal(seen[0].input.transcript.path, TRANSCRIPT_REL);
    assert.match(seen[0].input.transcript.content, /ignore every earlier decision/);
    assert.equal(seen[1].input.decisions.length, 4);
    assert.equal(seen[2].input.decisions.length, 3);
    assert.match(seen[3].input.transcripts[0].content, /paused-UI topic/);
    assert.equal(seen[3].input.tasks.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD1-TD4 failures gate both decision and task candidates", async (t) => {
  const meetings = await loadMeetings();
  for (const criterion of ["TD1", "TD2", "TD3", "TD4"]) {
    await t.test(criterion, async () => {
      const root = workspace();
      try {
        const affected = [decisions[0].id, tasks[0].id];
        const runPhase = async ({ phase, input }) => {
          if (phase === "extract") return { decisions: decisions.slice(0, 1), tasks };
          if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
          if (phase === "verify") {
            return verificationReport({
              verdict: "fail",
              failures: { [criterion]: affected },
            });
          }
          return gradeReport({ verdict: "fail", failures: { [criterion]: affected } });
        };
        const result = await meetings.draftTranscriptReview(
          draftOptions(root, runPhase, { rubricBudget: 0 })
        );
        assertReviewShape(result.stage, "failed_rubric");
        const report = result.stage.gradeReport.criteria.find(({ id }) => id === criterion);
        assert.deepEqual(report.candidateIds.sort(), affected.sort());
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("verify must-fail findings cannot be erased by grade or an ineffective correction", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const phases = [];
    const affected = [decisions[0].id, tasks[0].id];
    const runPhase = async ({ phase, input }) => {
      phases.push(phase);
      if (phase === "extract" || phase === "correct") return { decisions, tasks };
      if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
      if (phase === "verify") {
        return verificationReport({ verdict: "fail", failures: { TD2: affected } });
      }
      return gradeReport();
    };
    const result = await meetings.draftTranscriptReview(draftOptions(root, runPhase));
    assertReviewShape(result.stage, "failed_rubric");
    assert.deepEqual(phases, [
      "extract",
      "deduplicate",
      "verify",
      "grade",
      "correct",
      "deduplicate",
      "verify",
      "grade",
    ]);
    const td2 = result.stage.gradeReport.criteria.find(({ id }) => id === "TD2");
    assert.equal(td2.outcome, "fail");
    assert.deepEqual(td2.candidateIds.sort(), affected.sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a hallucinated task is removed by the bounded correction phase", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const phases = [];
    const runPhase = async ({ phase, input }) => {
      phases.push(phase);
      if (phase === "extract") return { decisions, tasks: [...tasks, hallucinatedTask] };
      if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
      if (phase === "correct") return { decisions, tasks };
      const failed = input.tasks.some(({ id }) => id === hallucinatedTask.id);
      if (phase === "verify") {
        return failed
          ? verificationReport({
              verdict: "fail",
              failures: { TD1: [hallucinatedTask.id], TD2: [hallucinatedTask.id] },
            })
          : verificationReport();
      }
      return failed
        ? gradeReport({
            verdict: "fail",
            failures: { TD1: [hallucinatedTask.id], TD2: [hallucinatedTask.id] },
          })
        : gradeReport();
    };
    const result = await meetings.draftTranscriptReview(draftOptions(root, runPhase));
    assertReviewShape(result.stage, "pending_review");
    assert.deepEqual(phases, [
      "extract",
      "deduplicate",
      "verify",
      "grade",
      "correct",
      "deduplicate",
      "verify",
      "grade",
    ]);
    assert.deepEqual(
      result.stage.tasks.map(({ id }) => id),
      [tasks[0].id]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD6 catches a paused-UI omission across the full transcript", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const runPhase = async ({ phase, input }) => {
      if (phase === "extract") return { decisions: decisions.slice(0, 2), tasks: [] };
      if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
      if (phase === "verify") return verificationReport();
      if (phase === "correct") return { decisions, tasks };
      return input.decisions.some(({ id }) => id === "decision-paused-ui")
        ? gradeReport()
        : gradeReport({
            verdict: "fail",
            failures: { TD6: ["decision-paused-ui", "task-audit-brief"] },
          });
    };
    const result = await meetings.draftTranscriptReview(draftOptions(root, runPhase));
    assertReviewShape(result.stage, "pending_review");
    assert.equal(result.stage.loops.length, 2);
    assert.ok(result.stage.decisions.some(({ id }) => id === "decision-paused-ui"));
    assert.ok(result.stage.tasks.some(({ id }) => id === "task-audit-brief"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("correction-budget exhaustion retains proposals and the failing grade", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const phases = [];
    const runPhase = async ({ phase, input }) => {
      phases.push(phase);
      if (phase === "extract" || phase === "correct") return { decisions, tasks };
      if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
      if (phase === "verify") return verificationReport();
      return gradeReport({ verdict: "fail", failures: { TD6: [TRANSCRIPT_REL] } });
    };
    const result = await meetings.draftTranscriptReview(
      draftOptions(root, runPhase, { rubricBudget: 2 })
    );
    assertReviewShape(result.stage, "failed_rubric");
    assert.deepEqual(phases, [
      "extract",
      "deduplicate",
      "verify",
      "grade",
      "correct",
      "deduplicate",
      "verify",
      "grade",
      "correct",
      "deduplicate",
      "verify",
      "grade",
    ]);
    assert.equal(result.stage.loops.length, 3);
    assert.equal(result.stage.decisions.length, 3);
    assert.equal(result.stage.tasks.length, 1);
    assert.equal(result.stage.gradeReport.verdict, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("certified empty returns no_changes and creates no stage file", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const runPhase = async ({ phase }) => {
      if (phase === "extract" || phase === "deduplicate") return { decisions: [], tasks: [] };
      if (phase === "verify") return verificationReport();
      return gradeReport({ certifiedNoChanges: true });
    };
    const result = await meetings.draftTranscriptReview(draftOptions(root, runPhase));
    assert.equal(result.outcome, "no_changes");
    assert.equal(result.stage ?? null, null);
    assert.equal(result.gradeReport.criteria.find(({ id }) => id === "TD6").outcome, "pass");
    assert.deepEqual(stageFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
