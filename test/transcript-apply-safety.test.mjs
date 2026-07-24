import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NOW,
  TRANSCRIPT_REL,
  assertReviewShape,
  loadMeetings,
  passingPhaseRunner,
  readStage,
  runTranscriptCli,
  workspace,
  workspaceLogs,
} from "./helpers/transcript-pipeline.mjs";

async function pendingStage(meetings, root) {
  return meetings.draftTranscriptReview({
    root,
    transcriptPaths: [TRANSCRIPT_REL],
    rubricBudget: 1,
    runPhase: passingPhaseRunner(),
    now: () => NOW,
  });
}

test("repository-local apply lock refusal touches neither log nor stage", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const pending = await pendingStage(meetings, root);
    const beforeLogs = workspaceLogs(root);
    const beforeStage = readFileSync(pending.stagePath);
    const lockDir = path.join(root, ".aios", "locks");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "transcript-apply.lock"), "synthetic busy lock\n");
    assert.throws(
      () => meetings.applyPendingTranscriptStage({ root, stagePath: pending.stagePath }),
      /lock|busy/i
    );
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.deepEqual(readFileSync(pending.stagePath), beforeStage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retry after second-log failure completes once without duplicating the first log", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const pending = await pendingStage(meetings, root);
    const reviewed = readStage(pending.stagePath);
    assert.throws(
      () =>
        meetings.applyPendingTranscriptStage({
          root,
          stagePath: pending.stagePath,
          beforeLogReplace: (log) => {
            if (log === "tasks") throw new Error("synthetic second-log replacement failure");
          },
        }),
      /second-log replacement failure/
    );
    assert.equal(readStage(pending.stagePath).status, "pending_review");
    assert.equal(
      workspaceLogs(root).decisions.split("Limit the beta to existing customers").length - 1,
      1
    );
    assert.doesNotMatch(workspaceLogs(root).tasks, /accessibility audit brief/);

    const applied = meetings.applyPendingTranscriptStage({
      root,
      stagePath: pending.stagePath,
    });
    assert.equal(typeof applied?.then, "undefined");
    const approved = readStage(pending.stagePath);
    assertReviewShape(approved, "approved", { approvedFrom: reviewed });
    assert.equal(approved.reviewDigest, reviewed.reviewDigest);
    assert.equal(approved.decisions.length, reviewed.decisions.length);
    assert.equal(approved.tasks.length, reviewed.tasks.length);
    assert.equal(
      workspaceLogs(root).decisions.split("Limit the beta to existing customers").length - 1,
      1
    );
    assert.equal(
      workspaceLogs(root).tasks.split("Send the accessibility audit brief to Mina").length - 1,
      1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewDigest tampering is refused before either log changes", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const pending = await pendingStage(meetings, root);
    const beforeLogs = workspaceLogs(root);
    const tampered = readStage(pending.stagePath);
    tampered.decisions[0].decision = "Tampered ungraded decision";
    writeFileSync(pending.stagePath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    assert.throws(
      () => meetings.applyPendingTranscriptStage({ root, stagePath: pending.stagePath }),
      /reviewDigest|digest|integrity/i
    );
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.equal(readStage(pending.stagePath).status, "pending_review");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("digest-consistent must-fail tampering is refused by parse, apply, and CLI", async () => {
  // Given a pending stage whose digest is recomputed after disguising a TD2 failure as a pass.
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const pending = await pendingStage(meetings, root);
    const tampered = readStage(pending.stagePath);
    tampered.gradeReport.criteria = tampered.gradeReport.criteria.map((criterion) =>
      criterion.id === "TD2"
        ? { ...criterion, outcome: "fail", findings: ["synthetic hidden TD2 failure"] }
        : criterion
    );
    const reviewed = {
      version: tampered.version,
      id: tampered.id,
      createdAt: tampered.createdAt,
      access: tampered.access,
      decisions: tampered.decisions,
      tasks: tampered.tasks,
      transcripts: tampered.transcripts,
      rubricBudget: tampered.rubricBudget,
      loopsUsed: tampered.loopsUsed,
      loops: tampered.loops,
      gradeReport: tampered.gradeReport,
      diagnostics: tampered.diagnostics,
      migration: tampered.migration,
    };
    tampered.reviewDigest = createHash("sha256").update(JSON.stringify(reviewed)).digest("hex");
    writeFileSync(pending.stagePath, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    const beforeLogs = workspaceLogs(root);
    const beforeStage = readFileSync(pending.stagePath);

    // When each approval boundary receives the internally inconsistent stage.
    assert.throws(
      () => meetings.parseTranscriptReviewStage(tampered),
      /verdict|must|TD2|criterion/i
    );
    assert.throws(
      () => meetings.applyPendingTranscriptStage({ root, stagePath: pending.stagePath }),
      /verdict|must|TD2|criterion/i
    );
    const refused = await runTranscriptCli(root, [
      "approve",
      path.relative(root, pending.stagePath),
      "--no-push",
      "--json",
    ]);

    // Then no surface approves the stage or changes either destination log.
    assert.equal(refused.code, 2);
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.deepEqual(readFileSync(pending.stagePath), beforeStage);
    assert.equal(readStage(pending.stagePath).status, "pending_review");
    assert.doesNotMatch(refused.stdout, /\b(success|approved)\b/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid destination header fails preflight before either log or stage is written", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const pending = await pendingStage(meetings, root);
    const taskLog = path.join(root, "3-log", "tasks-team.md");
    writeFileSync(taskLog, "| Invalid | Header |\n|---|---|\n");
    const beforeLogs = workspaceLogs(root);
    const beforeStage = readFileSync(pending.stagePath);
    assert.throws(
      () => meetings.applyPendingTranscriptStage({ root, stagePath: pending.stagePath }),
      /header|column|destination|tasks-team/i
    );
    assert.deepEqual(workspaceLogs(root), beforeLogs);
    assert.deepEqual(readFileSync(pending.stagePath), beforeStage);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent approvals serialize under one repository lock and never duplicate rows", async () => {
  const root = workspace();
  try {
    const meetings = await loadMeetings();
    const first = await pendingStage(meetings, root);
    const second = await pendingStage(meetings, root);
    const firstReviewed = readStage(first.stagePath);
    const secondReviewed = readStage(second.stagePath);
    let nestedAttempted = false;
    let nestedError;
    meetings.applyPendingTranscriptStage({
      root,
      stagePath: first.stagePath,
      beforeLogReplace: () => {
        if (nestedAttempted) return;
        nestedAttempted = true;
        try {
          meetings.applyPendingTranscriptStage({ root, stagePath: second.stagePath });
        } catch (error) {
          nestedError = error;
        }
      },
    });
    assert.match(String(nestedError), /lock|busy/i);
    assert.equal(readStage(second.stagePath).status, "pending_review");
    meetings.applyPendingTranscriptStage({ root, stagePath: second.stagePath });
    assertReviewShape(readStage(first.stagePath), "approved", { approvedFrom: firstReviewed });
    assertReviewShape(readStage(second.stagePath), "approved", { approvedFrom: secondReviewed });
    assert.equal(
      workspaceLogs(root).decisions.split("Limit the beta to existing customers").length - 1,
      1
    );
    assert.equal(
      workspaceLogs(root).tasks.split("Send the accessibility audit brief to Mina").length - 1,
      1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
