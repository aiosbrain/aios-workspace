// test/spec-eval-live.test.mjs — the ONE test that spends a real DeepSeek call. It is gated on BOTH
// DEEPSEEK_API_KEY *and* SPEC_EVAL_LIVE=1: opt in with:
//   SPEC_EVAL_LIVE=1 npm test   (or run this file directly with both set)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");

const LIVE = process.env.SPEC_EVAL_LIVE === "1" && !!process.env.DEEPSEEK_API_KEY;

test(
  "live adversarial eval flags the weak spec (real DeepSeek)",
  { skip: LIVE ? false : "set SPEC_EVAL_LIVE=1 and DEEPSEEK_API_KEY to run" },
  async () => {
    const { evaluateSpec, loadRubric } = await import("../scripts/spec-eval.mjs");
    const { resolveLoopModels } = await import("../scripts/loop-models.mjs");
    const rubric = loadRubric(path.join(REPO, ".claude", "rubrics", "spec-readiness.md"));
    const specText = readFileSync(path.join(FIXTURES, "acceptance-demo-weak.md"), "utf8");
    const res = await evaluateSpec({
      specText,
      repo: REPO,
      rubric,
      useLlm: true,
      evalCfg: resolveLoopModels({ repo: REPO }).spec_eval,
      decisions: [],
    });
    // A weak spec must NOT be ready; deterministic blockers alone already force exit 1.
    assert.equal(res.verdict, "NOT_READY");
    assert.ok([1, 2].includes(res.exitCode));
  }
);

// The determinism acceptance criterion (handover #1): the same spec, evaluated repeatedly, must not
// flip its verdict. Run the quorum-gated gate N times and assert a single stable verdict. If this
// flips, the SR15 wording or the spec is genuinely ambiguous — that is signal, not a reason to raise
// the quorum K.
test(
  "live determinism — the same spec yields one stable verdict across 10 evals",
  { skip: LIVE ? false : "set SPEC_EVAL_LIVE=1 and DEEPSEEK_API_KEY to run" },
  async () => {
    const { evaluateSpec, loadRubric } = await import("../scripts/spec-eval.mjs");
    const { resolveLoopModels } = await import("../scripts/loop-models.mjs");
    const rubric = loadRubric(path.join(REPO, ".claude", "rubrics", "spec-readiness.md"));
    const specText = readFileSync(path.join(FIXTURES, "doc-authoring-bounded.md"), "utf8");
    const evalCfg = resolveLoopModels({ repo: REPO }).spec_eval;
    const verdicts = [];
    for (let i = 0; i < 10; i++) {
      const res = await evaluateSpec({ specText, repo: REPO, rubric, useLlm: true, evalCfg });
      verdicts.push(res.verdict);
    }
    const unique = [...new Set(verdicts)];
    assert.equal(unique.length, 1, `expected one stable verdict, saw ${JSON.stringify(verdicts)}`);
  }
);

// The SR15 sharpen (handover #2/#3): a bounded, human-reviewed doc-authoring spec must PASS (a
// reviewed PR is recoverable), while a genuinely under-specified one (unstated target, ambiguous
// external contract, no review step) must still FAIL. The stubbed tests prove the code path; only
// this live A/B proves the model actually separates the two under the sharpened criterion.
test(
  "live SR15 A/B — bounded latitude passes; genuine under-specification still blocks",
  { skip: LIVE ? false : "set SPEC_EVAL_LIVE=1 and DEEPSEEK_API_KEY to run" },
  async () => {
    const { evaluateSpec, loadRubric } = await import("../scripts/spec-eval.mjs");
    const { resolveLoopModels } = await import("../scripts/loop-models.mjs");
    const rubric = loadRubric(path.join(REPO, ".claude", "rubrics", "spec-readiness.md"));
    const evalCfg = resolveLoopModels({ repo: REPO }).spec_eval;
    const evalOne = (fixture) =>
      evaluateSpec({
        specText: readFileSync(path.join(FIXTURES, fixture), "utf8"),
        repo: REPO,
        rubric,
        useLlm: true,
        evalCfg,
      });

    const bounded = await evalOne("doc-authoring-bounded.md");
    assert.equal(bounded.verdict, "SPEC_READY", "bounded, reviewed latitude must not be blocked");

    const underspecified = await evalOne("doc-authoring-underspecified.md");
    assert.equal(underspecified.verdict, "NOT_READY", "a real gap must still block");
  }
);
