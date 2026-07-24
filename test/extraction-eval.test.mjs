import test from "node:test";
import assert from "node:assert/strict";
import {
  loadCorpus,
  runDeterministicEval,
  runLiveEval,
} from "../evals/transcript-extraction/extraction-eval.mjs";

test("deterministic extraction evaluation verifies rejection, dedup, adapters, and scoring", () => {
  const result = runDeterministicEval(loadCorpus());
  assert.equal(result.pass, true);
  assert.equal(result.adaptersConform, true);
  assert.equal(result.thresholdsMet, true);
  assert.deepEqual(
    result.rejected.map((item) => item.reason).sort(),
    [
      "duplicate_in_stage",
      "source_quote_empty",
      "source_quote_mismatch",
      "source_quote_not_found",
    ]
  );
  for (const score of Object.values(result.scores)) {
    assert.equal(score.precision, 1);
    assert.equal(score.recall, 1);
  }
});

test("live evaluation requires grounding in every run and two threshold passes", async () => {
  const corpus = loadCorpus();
  let calls = 0;
  const modelCall = async () => {
    calls++;
    const output = structuredClone(corpus.fixedModelOutput);
    output.decisions = output.decisions.slice(0, 1);
    output.tasks = output.tasks.slice(0, 2);
    output.facts = output.facts.slice(0, 2);
    output.stakeholders = output.stakeholders.slice(0, 2);
    return JSON.stringify(output);
  };
  const result = await runLiveEval(corpus, { model: "fixed:test", modelCall });
  assert.equal(calls, 3);
  assert.equal(result.allGrounded, true);
  assert.equal(result.passingRuns, 3);
  assert.equal(result.pass, true);
});
