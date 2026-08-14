import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePhaseCandidateBatch,
  parseLenientPhaseCandidateBatch,
} from "../../dist/operator-loop/meetings/candidate-schema.js";

const TRANSCRIPT = "1-inbox/transcripts/meeting.md";

function decision(overrides) {
  return {
    id: "decision-1",
    date: "2026-08-12",
    decision: "Keep ClickUp as the primary project management tool.",
    rationale: "Simpler starting point than a tightly coupled two-way sync.",
    decidedBy: "John Ellison",
    impact: "Admin/private tasks stay personal; team-tier tasks sync to ClickUp.",
    type: 2,
    transcript: TRANSCRIPT,
    sourceQuote: "we're basically using the team brain just as a and a content layer",
    ...overrides,
  };
}

function batch(audience) {
  return { decisions: [decision({ audience })], tasks: [] };
}

// Regression: a transcript that itself discusses access tiers (e.g. "admin/private tasks
// stay personal") previously caused the extraction model to emit the friendly alias
// "private" for the audience field instead of the canonical "admin" — and the strict
// schema parser hard-failed the whole batch on that valid alias instead of normalizing it.
test("parsePhaseCandidateBatch normalizes the 'private' audience alias to 'admin' instead of throwing", () => {
  const result = parsePhaseCandidateBatch(batch("private"));
  assert.equal(result.decisions[0].audience, "admin");
});

test("parsePhaseCandidateBatch normalizes 'client'/'company' audience aliases to 'external'", () => {
  assert.equal(parsePhaseCandidateBatch(batch("client")).decisions[0].audience, "external");
  assert.equal(parsePhaseCandidateBatch(batch("company")).decisions[0].audience, "external");
});

test("parsePhaseCandidateBatch still accepts canonical audience values unchanged", () => {
  assert.equal(parsePhaseCandidateBatch(batch("admin")).decisions[0].audience, "admin");
  assert.equal(parsePhaseCandidateBatch(batch("team")).decisions[0].audience, "team");
  assert.equal(parsePhaseCandidateBatch(batch("external")).decisions[0].audience, "external");
});

test("parsePhaseCandidateBatch still rejects a genuinely unknown audience value", () => {
  assert.throws(() => parsePhaseCandidateBatch(batch("bogus")), /audience has unknown value: bogus/);
});

test("parseLenientPhaseCandidateBatch (the live extract-phase parser) also normalizes 'private'", () => {
  const result = parseLenientPhaseCandidateBatch(batch("private"));
  assert.equal(result.batch.decisions[0].audience, "admin");
  assert.equal(result.dropped.length, 0);
});
