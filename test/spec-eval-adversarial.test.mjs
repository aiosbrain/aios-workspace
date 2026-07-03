// test/spec-eval-adversarial.test.mjs — the LLM layer via an injected mock evalFn: aggregation,
// no duplication of deterministic findings, junk-JSON resilience → one synthetic blocker, and the
// severity → exit-code mapping (deterministic 1 dominates adversarial 2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAdversarial, runAdversarialEval, evaluateSpec } from "../scripts/spec-eval.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(DIR, "..");
const FIXTURES = path.join(DIR, "fixtures", "spec-eval");
const read = (f) => readFileSync(path.join(FIXTURES, f), "utf8");
const STRONG = read("strong-spec.md"); // deterministically clean → the LLM layer is the gate
const RUBRIC = { raw: "", frontmatter: { budget: 2 }, rows: [] };
const stub = (obj) => () => (typeof obj === "string" ? obj : JSON.stringify(obj));

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
