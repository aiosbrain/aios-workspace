// test/spec-eval-live.test.mjs — the ONE test that spends a real Opus call. It is gated on BOTH
// ANTHROPIC_API_KEY *and* SPEC_EVAL_LIVE=1: the owner's machine exports the key globally via
// direnv, so key-presence alone would silently run xhigh Opus on every `npm test`. Opt in with:
//   SPEC_EVAL_LIVE=1 npm test   (or run this file directly with both set)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");

const LIVE = process.env.SPEC_EVAL_LIVE === "1" && !!process.env.ANTHROPIC_API_KEY;

test(
  "live adversarial eval flags the weak spec (real Opus)",
  { skip: LIVE ? false : "set SPEC_EVAL_LIVE=1 and ANTHROPIC_API_KEY to run" },
  async () => {
    const { evaluateSpec, loadRubric } = await import("../scripts/spec-eval.mjs");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const { resolveLoopModels } = await import("../scripts/loop-models.mjs");
    const rubric = loadRubric(path.join(REPO, ".claude", "rubrics", "spec-readiness.md"));
    const specText = readFileSync(path.join(FIXTURES, "acceptance-demo-weak.md"), "utf8");
    const res = await evaluateSpec({
      specText,
      repo: REPO,
      rubric,
      useLlm: true,
      anthropic: new Anthropic(),
      evalCfg: resolveLoopModels({ repo: REPO }).spec_eval,
      decisions: [],
    });
    // A weak spec must NOT be ready; deterministic blockers alone already force exit 1.
    assert.equal(res.verdict, "NOT_READY");
    assert.ok([1, 2].includes(res.exitCode));
  }
);
