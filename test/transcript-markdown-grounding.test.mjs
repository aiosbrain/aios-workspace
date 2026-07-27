import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  isCrossTurnContinuation,
  isNearVerbatim,
  splitTranscriptTurns,
  stripTranscriptMarkup,
} from "../dist/operator-loop/meetings/markdown.js";
import {
  NOW,
  TRANSCRIPT_REL,
  decisions,
  gradeReport,
  loadMeetings,
  verificationReport,
  workspace,
} from "./helpers/transcript-pipeline.mjs";

test("stripTranscriptMarkup removes frontmatter and speaker labels", () => {
  const raw = [
    "---",
    "type: transcript",
    "---",
    "",
    "# Weekly sync",
    "",
    "**John Ellison:** Hello there.",
    "",
    "**Speaker:** Sounds good.",
    "",
  ].join("\n");
  assert.equal(stripTranscriptMarkup(raw), "Hello there. Sounds good.");
});

test("splitTranscriptTurns yields one normalized entry per speaker turn", () => {
  const raw = [
    "---",
    "type: transcript",
    "---",
    "",
    "# Weekly sync",
    "",
    "**John Ellison:** Hello there.",
    "",
    "**Speaker:** Sounds good.",
    "",
  ].join("\n");
  assert.deepEqual(splitTranscriptTurns(raw), ["hello there", "sounds good"]);
});

test("isCrossTurnContinuation accepts quotes split across speaker turns", () => {
  const transcript = [
    "**Speaker:** So it's important as well, John, that we put those icons on the front",
    "",
    "**John Ellison:** True.",
    "",
    "**Speaker:** page. To say that this works with Conductor.",
  ].join("\n");
  const quote = "So it's important as well, John, that we put those icons on the front page.";
  assert.equal(isCrossTurnContinuation(quote, transcript), true);
  assert.equal(isNearVerbatim(quote, transcript), true);
});

test("isCrossTurnContinuation accepts cross-turn quotes with intervening speaker labels", () => {
  const transcript = [
    "**John Ellison:** If you can ingest this granola",
    "",
    "**Speaker:** So it's just yeah.",
    "",
    "**John Ellison:** from the full meeting.",
  ].join("\n");
  const quote = "If you can ingest this granola from the full meeting.";
  assert.equal(isNearVerbatim(quote, transcript), true);
});

test("isNearVerbatim still rejects ungrounded long quotes", () => {
  const transcript = "**Speaker:** We should ship the operator loop this week.";
  const quote = "We should cancel the operator loop and delete the workspace.";
  assert.equal(isNearVerbatim(quote, transcript), false);
});

test("cross-turn matching cannot skip words inside a turn (negation bypass)", () => {
  const transcript = [
    "**John Ellison:** We should definitely not ship",
    "",
    "**Speaker:** the operator loop looks close though.",
  ].join("\n");
  const quote = "We should ship the operator loop";
  assert.equal(isCrossTurnContinuation(quote, transcript), false);
  assert.equal(isNearVerbatim(quote, transcript), false);
});

test("a continuation chunk may not begin mid-turn", () => {
  const transcript = [
    "**Speaker:** yesterday we put those icons on the front",
    "",
    "**Speaker:** website launch is next week.",
  ].join("\n");
  // "on the" ends mid-turn ("front" follows), so it cannot open a continuation.
  const quote = "we put those icons on the website";
  assert.equal(isNearVerbatim(quote, transcript), false);
});

test("a continuation may skip at most two interjection turns", () => {
  const head = "**John Ellison:** We agreed to ship the";
  const tail = "**John Ellison:** operator loop next week.";
  const interjection = "**Speaker:** hmm okay.";
  const quote = "We agreed to ship the operator loop next week.";
  const twoGaps = [head, "", interjection, "", interjection, "", tail].join("\n");
  const threeGaps = [head, "", interjection, "", interjection, "", interjection, "", tail].join(
    "\n"
  );
  assert.equal(isNearVerbatim(quote, twoGaps), true);
  assert.equal(isNearVerbatim(quote, threeGaps), false);
});

const CANDIDATE_ID = "decision-granola-split-quote";

function phaseRunner(candidate) {
  return async ({ phase, input }) => {
    if (phase === "extract") return { decisions: [candidate], tasks: [] };
    if (phase === "deduplicate") return { decisions: input.decisions, tasks: input.tasks };
    if (phase === "verify") return verificationReport();
    return gradeReport();
  };
}

test("TD1 passes when a granola-style quote spans multiple speaker turns", async () => {
  const root = workspace();
  try {
    const transcript = [
      "**Speaker:** So it's important as well, John, that we put those icons on the front",
      "",
      "**Speaker:** page.",
    ].join("\n");
    writeFileSync(path.join(root, TRANSCRIPT_REL), transcript);
    const meetings = await loadMeetings();
    const result = await meetings.draftTranscriptReview({
      root,
      transcriptPaths: [TRANSCRIPT_REL],
      rubricBudget: 0,
      runPhase: phaseRunner({
        ...decisions[0],
        id: CANDIDATE_ID,
        decision: "Add supported tool logos to the website home page",
        sourceQuote: "So it's important as well, John, that we put those icons on the front page.",
      }),
      now: () => NOW,
    });
    const td1 = result.stage.gradeReport.criteria.find(({ id }) => id === "TD1");
    assert.equal(result.stage.status, "pending_review");
    assert.equal(td1.outcome, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
