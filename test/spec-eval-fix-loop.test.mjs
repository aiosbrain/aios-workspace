// test/spec-eval-fix-loop.test.mjs — the bounded fix loop via injected mock evalFn + reviseFn:
// convergence within budget, exhaustion, exact call counts, and the exit-code carried out of a
// spent budget (deterministic 1 vs adversarial 2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFixLoop } from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");
const read = (f) => readFileSync(path.join(FIXTURES, f), "utf8");
const STRONG = read("strong-spec.md"); // deterministically clean → the LLM verdict is the gate
const RUBRIC = { raw: "", frontmatter: { budget: 2 }, rows: [] };

const NOT_READY = JSON.stringify({
  verdict: "NOT_READY",
  score: 40,
  findings: [{ ruleId: "SR15", severity: "blocker", why: "underspecified" }],
});
const READY = JSON.stringify({ verdict: "SPEC_READY", score: 90, findings: [] });

test("converges within budget (fail-then-pass) → exit 0, 1 iteration", async () => {
  let evalCalls = 0;
  let reviseCalls = 0;
  const evalFn = () => {
    evalCalls++;
    return evalCalls === 1 ? NOT_READY : READY;
  };
  const reviseFn = ({ specText }) => {
    reviseCalls++;
    return specText; // still deterministically clean; verdict is driven by evalFn
  };
  const loop = await runFixLoop({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    budget: 2,
    useLlm: true,
    evalFn,
    reviseFn,
  });
  assert.equal(loop.status, "converged");
  assert.equal(loop.exitCode, 0);
  assert.equal(loop.iterations, 1);
  assert.equal(reviseCalls, 1); // revised once
  assert.equal(evalCalls, 2); // before + one re-verify
  assert.equal(loop.after.verdict, "SPEC_READY");
});

test("exhaustion (always NOT_READY) → status exhausted, exit 2, iterations == budget", async () => {
  let reviseCalls = 0;
  const loop = await runFixLoop({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    budget: 2,
    useLlm: true,
    evalFn: () => NOT_READY,
    reviseFn: ({ specText }) => {
      reviseCalls++;
      return specText;
    },
  });
  assert.equal(loop.status, "exhausted");
  assert.equal(loop.exitCode, 2); // adversarial blocker remained
  assert.equal(loop.iterations, 2);
  assert.equal(reviseCalls, 2);
});

test("budget defaults to the rubric budget when not passed", async () => {
  let reviseCalls = 0;
  const loop = await runFixLoop({
    specText: STRONG,
    repo: REPO,
    rubric: { raw: "", frontmatter: { budget: 3 }, rows: [] },
    useLlm: true,
    evalFn: () => NOT_READY,
    reviseFn: ({ specText }) => {
      reviseCalls++;
      return specText;
    },
  });
  assert.equal(loop.budget, 3);
  assert.equal(loop.iterations, 3);
  assert.equal(reviseCalls, 3);
});

test("a deterministic must-fail the reviser cannot fix → exhausted with exit 1", async () => {
  const WEAK = read("weak-no-deps.md"); // SR4 deterministic blocker, unfixable by an identity reviser
  const loop = await runFixLoop({
    specText: WEAK,
    repo: REPO,
    rubric: RUBRIC,
    budget: 2,
    useLlm: true,
    evalFn: () => READY, // even a permissive LLM cannot clear the deterministic blocker
    reviseFn: ({ specText }) => specText,
  });
  assert.equal(loop.status, "exhausted");
  assert.equal(loop.exitCode, 1); // deterministic must-fail dominates
});

test("a reviser that clears the deterministic blocker converges (offline, --no-llm)", async () => {
  const loop = await runFixLoop({
    specText: read("weak-no-deps.md"),
    repo: REPO,
    rubric: RUBRIC,
    budget: 2,
    useLlm: false, // deterministic-only verify
    reviseFn: () => STRONG, // returns a deterministically-clean spec
  });
  assert.equal(loop.status, "converged");
  assert.equal(loop.exitCode, 0);
  assert.equal(loop.iterations, 1);
  assert.equal(loop.revisedSpec, STRONG);
  assert.equal(loop.after.verdict, "NOT_EVALUATED"); // clean deterministic, no LLM
});

test("reviewed-parent provenance uses LLM only before and after deterministic revisions", async () => {
  let evalCalls = 0;
  let reviseCalls = 0;
  const loop = await runFixLoop({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    budget: 3,
    useLlm: true,
    provenanceAware: true,
    evalFn: () => {
      evalCalls++;
      return evalCalls === 1 ? NOT_READY : READY;
    },
    reviseFn: ({ specText }) => {
      reviseCalls++;
      return specText;
    },
  });
  assert.equal(loop.status, "converged");
  assert.equal(reviseCalls, 1);
  assert.equal(evalCalls, 2, "initial adversarial pass plus one final confirmation");
});
