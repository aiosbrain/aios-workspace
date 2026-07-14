// test/spec-eval-adversarial.test.mjs — the LLM layer via an injected mock evalFn: aggregation,
// no duplication of deterministic findings, junk-JSON resilience → one synthetic blocker, and the
// severity → exit-code mapping (deterministic 1 dominates adversarial 2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseAdversarial,
  runAdversarialEval,
  evaluateSpec,
  normalizeQuorum,
  aggregateQuorum,
  EVAL_SAMPLING,
} from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");
const read = (f) => readFileSync(path.join(FIXTURES, f), "utf8");
const STRONG = read("strong-spec.md"); // deterministically clean → the LLM layer is the gate
const RUBRIC = { raw: "", frontmatter: { budget: 2 }, rows: [] };
const stub = (obj) => () => (typeof obj === "string" ? obj : JSON.stringify(obj));
// A stateful evaluator that returns each value in sequence (last value repeats), with a call count —
// simulates a stochastic judge that flips verdict run to run.
function seqStub(values) {
  let i = 0;
  const fn = () => {
    const v = values[Math.min(i, values.length - 1)];
    i++;
    return typeof v === "string" ? v : JSON.stringify(v);
  };
  fn.calls = () => i;
  return fn;
}
const blocker = (ruleId, why = "x") => ({
  verdict: "NOT_READY",
  score: 20,
  findings: [{ ruleId, severity: "blocker", why }],
});
const ready = (score = 95) => ({ verdict: "SPEC_READY", score, findings: [] });

test("parseAdversarial — well-formed JSON parses; blocker forces NOT_READY", () => {
  const ok = parseAdversarial('{"verdict":"SPEC_READY","score":88,"findings":[]}');
  assert.equal(ok.verdict, "SPEC_READY");
  assert.equal(ok.score, 88);

  // Model claims READY but lists a blocker → we force NOT_READY (fail closed).
  const forced = parseAdversarial(
    '{"verdict":"SPEC_READY","score":80,"findings":[{"ruleId":"SR9","severity":"blocker","why":"x"}]}'
  );
  assert.equal(forced.verdict, "NOT_READY");
});

test("junk output → one synthetic blocker, never throws", () => {
  for (const junk of ["not json", "", "{ broken", "[1,2,3]", '{"verdict":"MAYBE"}']) {
    const p = parseAdversarial(junk);
    assert.equal(p.parseError, true);
    assert.equal(p.verdict, "NOT_READY");
    assert.equal(p.findings.length, 1);
    assert.equal(p.findings[0].severity, "blocker");
  }
});

test("runAdversarialEval — aggregates findings from the evaluator", async () => {
  const res = await runAdversarialEval({
    specText: STRONG,
    rubric: RUBRIC,
    deterministic: [],
    evalFn: stub({
      verdict: "SPEC_READY",
      score: 75,
      findings: [{ ruleId: "SR12", severity: "minor", why: "traceability" }],
    }),
  });
  assert.equal(res.verdict, "SPEC_READY");
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].layer, "adversarial");
});

test("runAdversarialEval — drops findings that duplicate a deterministic blocker", async () => {
  const res = await runAdversarialEval({
    specText: STRONG,
    rubric: RUBRIC,
    deterministic: [{ ruleId: "SR4", severity: "blocker", layer: "deterministic" }],
    evalFn: stub({
      verdict: "NOT_READY",
      score: 30,
      findings: [
        { ruleId: "SR4", severity: "blocker", why: "dup of deterministic" },
        { ruleId: "SR15", severity: "blocker", why: "a real refutation" },
      ],
    }),
  });
  const ids = res.findings.map((f) => f.ruleId);
  assert.ok(!ids.includes("SR4"), "the deterministic-owned SR4 must be dropped");
  assert.ok(ids.includes("SR15"));
});

test("runAdversarialEval — evalFn throwing yields a synthetic blocker (fail closed)", async () => {
  const res = await runAdversarialEval({
    specText: STRONG,
    rubric: RUBRIC,
    evalFn: () => {
      throw new Error("network down");
    },
  });
  assert.equal(res.verdict, "NOT_READY");
  assert.equal(res.error, true);
  assert.equal(res.findings[0].severity, "blocker");
});

test("severity → exit mapping — adversarial blocker on a clean spec is exit 2", async () => {
  const res = await evaluateSpec({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    useLlm: true,
    evalFn: stub({
      verdict: "NOT_READY",
      score: 20,
      findings: [{ ruleId: "SR8", severity: "blocker", why: "x" }],
    }),
  });
  assert.equal(res.verdict, "NOT_READY");
  assert.equal(res.exitCode, 2);
});

test("severity → exit mapping — deterministic must-fail (1) dominates adversarial READY", async () => {
  const res = await evaluateSpec({
    specText: read("weak-no-deps.md"), // SR4 deterministic blocker
    repo: REPO,
    rubric: RUBRIC,
    useLlm: true,
    evalFn: stub({ verdict: "SPEC_READY", score: 99, findings: [] }),
  });
  assert.equal(res.verdict, "NOT_READY");
  assert.equal(res.exitCode, 1);
});

test("clean spec + adversarial READY → SPEC_READY exit 0", async () => {
  const res = await evaluateSpec({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    useLlm: true,
    evalFn: stub({ verdict: "SPEC_READY", score: 95, findings: [] }),
  });
  assert.equal(res.verdict, "SPEC_READY");
  assert.equal(res.exitCode, 0);
});

// ── quorum ──────────────────────────────────────────────────────────────────────────────────

test("normalizeQuorum — coerces to an odd integer ≥ 1; ≤1 disables", () => {
  assert.equal(normalizeQuorum(3), 3);
  assert.equal(normalizeQuorum(4), 5); // even rounds up so a strict majority exists
  assert.equal(normalizeQuorum(1), 1);
  assert.equal(normalizeQuorum(0), 1);
  assert.equal(normalizeQuorum(undefined), 3); // DEFAULT_QUORUM
});

test("aggregateQuorum — a lone blocker is outvoted and demoted; median score", () => {
  const agg = aggregateQuorum([blocker("SR15", "one unlucky roll"), ready(100), ready(90)]);
  assert.equal(agg.verdict, "SPEC_READY", "1/3 NOT_READY is below the majority");
  const sr15 = agg.findings.find((f) => f.ruleId === "SR15");
  assert.equal(sr15.severity, "minor", "non-recurring blocker demoted, not gating");
  assert.equal(agg.score, 90, "median of [20,90,100]");
});

test("aggregateQuorum — a recurring blocker survives the vote and stays gating", () => {
  const agg = aggregateQuorum([blocker("SR8", "x"), blocker("SR8", "xy longer"), ready(80)]);
  assert.equal(agg.verdict, "NOT_READY", "2/3 NOT_READY meets the majority");
  const sr8 = agg.findings.find((f) => f.ruleId === "SR8");
  assert.equal(sr8.severity, "blocker");
  assert.equal(sr8.why, "xy longer", "keeps the richest instance");
});

test("quorum — confirm-before-fail: a first READY sample costs exactly one call", async () => {
  const evalFn = seqStub([ready(), blocker("SR8")]); // would flip on a 2nd call, but must not run one
  const res = await evaluateSpec({ specText: STRONG, repo: REPO, rubric: RUBRIC, evalFn });
  assert.equal(res.verdict, "SPEC_READY");
  assert.equal(evalFn.calls(), 1, "ready path does not escalate");
});

test("quorum — a lone NOT_READY roll is outvoted (stochastic flip absorbed)", async () => {
  // First sample blocks → escalate to 3; the other two pass → majority SPEC_READY.
  const evalFn = seqStub([blocker("SR15"), ready(), ready()]);
  const res = await evaluateSpec({ specText: STRONG, repo: REPO, rubric: RUBRIC, evalFn });
  assert.equal(res.verdict, "SPEC_READY");
  assert.equal(res.exitCode, 0);
  assert.equal(evalFn.calls(), 3, "escalated to the full quorum");
});

test("quorum — a consistent blocker still blocks (real problems survive)", async () => {
  const res = await evaluateSpec({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    evalFn: stub(blocker("SR8", "genuinely under-specified")),
  });
  assert.equal(res.verdict, "NOT_READY");
  assert.equal(res.exitCode, 2);
});

test("quorum — K=1 disables quorum (single pass, no escalation)", async () => {
  const evalFn = seqStub([blocker("SR15"), ready(), ready()]);
  const res = await evaluateSpec({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    evalFn,
    evalCfg: { quorum: 1 },
  });
  assert.equal(res.verdict, "NOT_READY", "K=1 takes the first (blocking) sample verbatim");
  assert.equal(evalFn.calls(), 1);
});

test("quorum — majority parseError fails closed; a minority is tolerated", async () => {
  // All junk → every sample is a synthetic NOT_READY → stays blocked.
  const allJunk = await evaluateSpec({
    specText: STRONG,
    repo: REPO,
    rubric: RUBRIC,
    evalFn: stub("not json at all"),
  });
  assert.equal(allJunk.verdict, "NOT_READY");

  // One junk roll, then two clean READY → the bad roll is outvoted.
  const oneJunk = seqStub(["not json at all", ready(), ready()]);
  const res = await evaluateSpec({ specText: STRONG, repo: REPO, rubric: RUBRIC, evalFn: oneJunk });
  assert.equal(res.verdict, "SPEC_READY");
});

test("evaluator sampling is pinned (temperature 0) for reproducibility", () => {
  assert.equal(EVAL_SAMPLING.temperature, 0);
  assert.equal(EVAL_SAMPLING.top_p, 1);
});
