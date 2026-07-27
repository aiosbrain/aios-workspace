import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import {
  TRANSCRIPT_REL,
  assertReviewShape,
  decisions,
  gradeReport,
  readStage,
  runTranscriptCli,
  sha256,
  stageFiles,
  tasks,
  verificationReport,
  workspace,
  workspaceLogs,
  writeExtraction,
} from "./helpers/transcript-pipeline.mjs";

test("default approve does not push an all-deduplicated pending stage", async () => {
  const root = workspace();
  try {
    const extraction = writeExtraction(root);
    const runPhase = async ({ phase, input }) => {
      if (phase === "extract") return { decisions, tasks };
      if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
      if (phase === "verify") return verificationReport();
      return gradeReport();
    };
    const seeded = await runTranscriptCli(
      root,
      ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
      { runPhase }
    );
    assert.equal(seeded.code, 0);
    const seededStagePath = stageFiles(root)[0];
    const seededApproval = await runTranscriptCli(root, [
      "approve",
      path.relative(root, seededStagePath),
      "--no-push",
    ]);
    assert.equal(seededApproval.code, 0);

    const drafted = await runTranscriptCli(
      root,
      ["draft", "--transcripts", TRANSCRIPT_REL, "--from-json", extraction, "--json"],
      { runPhase }
    );
    assert.equal(drafted.code, 0);
    const stagePath = stageFiles(root).find((candidate) => candidate !== seededStagePath);
    assert.ok(stagePath, "second draft must create a pending stage");
    assert.equal(readStage(stagePath).status, "pending_review");
    const beforeLogs = workspaceLogs(root);
    const beforeHashes = {
      decisions: sha256(beforeLogs.decisions),
      tasks: sha256(beforeLogs.tasks),
    };
    let pushes = 0;

    const approved = await runTranscriptCli(root, ["approve", path.relative(root, stagePath)], {
      push: async () => {
        pushes += 1;
      },
    });

    assert.equal(approved.code, 0);
    const stage = readStage(stagePath);
    assertReviewShape(stage, "approved");
    assert.equal(stage.apply.decisionsAdded, 0);
    assert.equal(stage.apply.tasksAdded, 0);
    assert.equal(stage.apply.decisionLogChanged, false);
    assert.equal(stage.apply.taskLogChanged, false);
    assert.equal(stage.push.state, "not_requested");
    assert.equal(stage.push.attempts.length, 0);
    assert.equal(pushes, 0);
    const afterLogs = workspaceLogs(root);
    assert.deepEqual(afterLogs, beforeLogs);
    assert.deepEqual(
      { decisions: sha256(afterLogs.decisions), tasks: sha256(afterLogs.tasks) },
      beforeHashes
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
