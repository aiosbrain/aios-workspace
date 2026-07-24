import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
  NOW,
  TRANSCRIPT_REL,
  assertReviewShape,
  decisions,
  gradeReport,
  loadMeetings,
  passingPhaseRunner,
  readStage,
  stageFiles,
  tasks,
  verificationReport,
  workspace,
  writeV1Stage,
} from "./helpers/transcript-pipeline.mjs";

const draftOptions = (root, overrides = {}) => ({
  root,
  transcriptPaths: [TRANSCRIPT_REL],
  rubricBudget: 1,
  runPhase: passingPhaseRunner(),
  now: () => NOW,
  ...overrides,
});

test("stage parsing accepts valid v2 and rejects bad JSON or unknown states", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const { stage } = await meetings.draftTranscriptReview(draftOptions(root));
    assert.equal(
      meetings.parseTranscriptReviewStage(JSON.stringify(stage)).status,
      "pending_review"
    );
    assert.throws(() => meetings.parseTranscriptReviewStage("{"), /JSON|parse|malformed/i);
    assert.throws(
      () => meetings.parseTranscriptReviewStage({ ...stage, status: "mystery_state" }),
      /status|mystery|unknown/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD5 findings remain advisory and do not spend correction budget", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const phases = [];
    const runPhase = async ({ phase, input }) => {
      phases.push(phase);
      if (phase === "extract") return { decisions, tasks };
      if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
      if (phase === "verify") {
        return verificationReport({ failures: { TD5: [decisions[0].id, tasks[0].id] } });
      }
      return gradeReport({ failures: { TD5: [decisions[0].id, tasks[0].id] } });
    };
    const result = await meetings.draftTranscriptReview(
      draftOptions(root, { runPhase, rubricBudget: 2 })
    );
    assertReviewShape(result.stage, "pending_review");
    assert.deepEqual(phases, ["extract", "deduplicate", "verify", "grade"]);
    const td5 = result.stage.gradeReport.criteria.find(({ id }) => id === "TD5");
    assert.equal(td5.outcome, "fail");
    assert.deepEqual(td5.candidateIds.sort(), [decisions[0].id, tasks[0].id].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("same-timestamp drafts are collision-safe non-overwriting 0600 files", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const [first, second] = await Promise.all([
      meetings.draftTranscriptReview(draftOptions(root)),
      meetings.draftTranscriptReview(draftOptions(root)),
    ]);
    assert.notEqual(first.stagePath, second.stagePath);
    assert.equal(stageFiles(root).length, 2);
    assert.equal(statSync(first.stagePath).mode & 0o777, 0o600);
    assert.equal(statSync(second.stagePath).mode & 0o777, 0o600);
    assert.equal(readStage(first.stagePath).id, first.stage.id);
    assert.equal(readStage(second.stagePath).id, second.stage.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repository-contained paths are validated before any model phase", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    let called = false;
    await assert.rejects(
      () =>
        meetings.draftTranscriptReview(
          draftOptions(root, {
            transcriptPaths: ["../outside.md"],
            runPhase: async () => {
              called = true;
            },
          })
        ),
      /path escapes workspace/i
    );
    assert.equal(called, false);
    assert.deepEqual(stageFiles(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Markdown row rendering is deterministic and header-ordered", async () => {
  const meetings = await loadMeetings();
  const decision = meetings.renderDecisionRow(decisions[0], 7);
  const task = meetings.renderTaskRow(tasks[0], 9);
  assert.equal(decision, meetings.renderDecisionRow(decisions[0], 7));
  assert.equal(task, meetings.renderTaskRow(tasks[0], 9));
  assert.equal(
    decision,
    "| 7 | 2026-07-21 | Limit the beta to existing customers | Keep the cohort controlled | Mina Okafor | Beta rollout | 2 | team |\n"
  );
  assert.equal(
    task,
    "| TT9 | Send the accessibility audit brief to Mina | Priya Shah | Todo | Launch | 2026-07-24 | — |\n"
  );
});

test("low-level apply is synchronous, v2-pending-only, and rejects v1 untouched", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const v1Path = writeV1Stage(root);
    const beforeStage = readFileSync(v1Path);
    const beforeDecisions = readFileSync(path.join(root, "3-log", "decision-log.md"));
    const beforeTasks = readFileSync(path.join(root, "3-log", "tasks-team.md"));
    assert.throws(
      () => meetings.applyPendingTranscriptStage({ root, stagePath: v1Path }),
      /version|v1|pending.*v2/i
    );
    assert.deepEqual(readFileSync(v1Path), beforeStage);
    assert.deepEqual(readFileSync(path.join(root, "3-log", "decision-log.md")), beforeDecisions);
    assert.deepEqual(readFileSync(path.join(root, "3-log", "tasks-team.md")), beforeTasks);

    const pending = await meetings.draftTranscriptReview(draftOptions(root));
    const reviewed = readStage(pending.stagePath);
    const applied = meetings.applyPendingTranscriptStage({ root, stagePath: pending.stagePath });
    assert.equal(typeof applied?.then, "undefined");
    assertReviewShape(readStage(pending.stagePath), "approved", { approvedFrom: reviewed });
    assert.equal(statSync(pending.stagePath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
