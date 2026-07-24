import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  NOW,
  TRANSCRIPT_REL,
  decisions,
  gradeReport,
  loadMeetings,
  verificationReport,
  workspace,
} from "./helpers/transcript-pipeline.mjs";

const CANDIDATE_ID = "decision-short-source-quote";

function candidateWithSourceQuote(sourceQuote) {
  return {
    ...decisions[0],
    id: CANDIDATE_ID,
    decision: "Proceed with the reviewed plan",
    sourceQuote,
  };
}

function phaseRunner(candidate) {
  return async ({ phase, input }) => {
    if (phase === "extract") return { decisions: [candidate], tasks: [] };
    if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
    if (phase === "verify") return verificationReport();
    return gradeReport();
  };
}

async function draftWithSourceQuote(root, sourceQuote) {
  const meetings = await loadMeetings();
  return meetings.draftTranscriptReview({
    root,
    transcriptPaths: [TRANSCRIPT_REL],
    rubricBudget: 0,
    runPhase: phaseRunner(candidateWithSourceQuote(sourceQuote)),
    now: () => NOW,
  });
}

function td1(result) {
  return result.stage.gradeReport.criteria.find(({ id }) => id === "TD1");
}

test("TD1 keeps a grounded short exact source quote", async () => {
  const root = workspace();
  try {
    // Given: a transcript contains a meaningful short quote with punctuation.
    writeFileSync(path.join(root, TRANSCRIPT_REL), "Mina Okafor: Agreed.\n");

    // When: the engine evaluates a candidate grounded by the normalized short quote.
    const result = await draftWithSourceQuote(root, "Agreed");

    // Then: TD1 passes and the review remains eligible for owner review.
    assert.equal(result.stage.status, "pending_review");
    assert.equal(td1(result).outcome, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD1 rejects a blank source quote at the parsing boundary", async () => {
  const root = workspace();
  try {
    // Given: the transcript contains meaningful text but the candidate evidence is blank.
    writeFileSync(path.join(root, TRANSCRIPT_REL), "Mina Okafor: Agreed.\n");

    // When: the engine receives the blank source quote.
    const result = await draftWithSourceQuote(root, "");

    // Then: the untrusted candidate is rejected before a review can be staged as pending.
    assert.equal(result.stage.status, "grading_error");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD1 rejects a punctuation-only short source quote", async () => {
  const root = workspace();
  try {
    // Given: the transcript contains meaningful text but the candidate evidence normalizes to empty.
    writeFileSync(path.join(root, TRANSCRIPT_REL), "Mina Okafor: Agreed.\n");

    // When: the engine evaluates punctuation-only evidence.
    const result = await draftWithSourceQuote(root, "—?!“”");

    // Then: deterministic TD1 fails the candidate instead of accepting normalized noise.
    assert.equal(result.stage.status, "failed_rubric");
    assert.deepEqual(td1(result).candidateIds, [CANDIDATE_ID]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD1 rejects short text embedded only in a longer word", async () => {
  const root = workspace();
  try {
    // Given: the transcript has a longer word but not the candidate's exact short quote.
    writeFileSync(path.join(root, TRANSCRIPT_REL), "Mina Okafor: Not yet.\n");

    // When: the engine evaluates the partial-word source quote.
    const result = await draftWithSourceQuote(root, "No");

    // Then: deterministic TD1 does not treat the partial word as grounded evidence.
    assert.equal(result.stage.status, "failed_rubric");
    assert.deepEqual(td1(result).candidateIds, [CANDIDATE_ID]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("TD1 rejects an ungrounded short source quote", async () => {
  const root = workspace();
  try {
    // Given: the transcript has no occurrence of the candidate evidence.
    writeFileSync(path.join(root, TRANSCRIPT_REL), "Mina Okafor: Agreed.\n");

    // When: the engine evaluates the absent short quote.
    const result = await draftWithSourceQuote(root, "Nope");

    // Then: deterministic TD1 fails the ungrounded candidate.
    assert.equal(result.stage.status, "failed_rubric");
    assert.deepEqual(td1(result).candidateIds, [CANDIDATE_ID]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
