#!/usr/bin/env node
// test/ux/judge.test.mjs — ZERO-DEPENDENCY unit test for the pure UX judge gate.
//
// No SDK import: we inject a FAKE callModel. Runs in the pre-`npm ci` CI job alongside the
// other `node test/*.mjs` lines. Covers, per the plan:
//   • a known-good evidence set PASSES (threshold 1.0, all criteria pass 3×);
//   • a broken evidence set FAILS on EXACTLY the criterion that's broken
//     (e.g. disclosure-missing), not the others;
//   • malformed-JSON → retry once → if still malformed, that criterion is review_needed
//     (and the flow status is review_needed, never a silent pass);
//   • the strict schema validator rejects extra/missing fields, bad verdict, bad confidence.
//
// Run: node test/ux/judge.test.mjs

import { judgeFlow, validateVerdict } from "./judge.mjs";

let failed = 0;
const RED = "\x1b[0;31m", GREEN = "\x1b[0;32m", NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else { console.log(`  ${RED}✗${NC} ${label}`); failed++; }
}

// A rubric mirroring the onboarding flow's shape (trust-critical → threshold 1.0).
const RUBRIC = {
  flow: "onboarding-draft-from-link",
  threshold: 1.0,
  criteria: [
    { id: "empty_state_offers_both", ask: "Does the empty chat offer BOTH options?" },
    { id: "firecrawl_disclosure", ask: "Is the Firecrawl disclosure shown before submit?" },
    { id: "draft_shown", ask: "Is a drafted profile shown back?" },
    { id: "confirm_before_write", ask: "Is confirmation required before any write?" },
    { id: "no_console_errors", ask: "Did the flow complete with no console errors?" },
  ],
};

// Build a fake callModel that returns a fixed verdict per criterion id.
// `verdictMap[id]` may be: "pass"|"fail"|"unknown" (valid JSON), the string
// "__malformed__" (returns broken JSON every time), or a function (id,callCount)->raw.
function fakeModel(verdictMap) {
  const calls = {};
  return async (req) => {
    const id = req.criterion.id;
    calls[id] = (calls[id] || 0) + 1;
    const spec = verdictMap[id];
    if (typeof spec === "function") return spec(id, calls[id]);
    if (spec === "__malformed__") return "this is not json {";
    const verdict = spec || "pass";
    return JSON.stringify({ criterion: id, verdict, reason: `fake ${verdict}`, confidence: 0.9 });
  };
}

console.log("judge: strict schema validator");
{
  check("rejects non-object", validateVerdict("x").ok === false);
  check("rejects missing field", validateVerdict({ criterion: "a", verdict: "pass", reason: "r" }).ok === false);
  check("rejects extra field", validateVerdict({ criterion: "a", verdict: "pass", reason: "r", confidence: 0.5, extra: 1 }).ok === false);
  check("rejects bad verdict", validateVerdict({ criterion: "a", verdict: "maybe", reason: "r", confidence: 0.5 }).ok === false);
  check("rejects confidence > 1", validateVerdict({ criterion: "a", verdict: "pass", reason: "r", confidence: 1.5 }).ok === false);
  check("rejects confidence < 0", validateVerdict({ criterion: "a", verdict: "pass", reason: "r", confidence: -0.1 }).ok === false);
  check("accepts a valid verdict", validateVerdict({ criterion: "a", verdict: "pass", reason: "r", confidence: 0.5 }).ok === true);
}

console.log("judge: a known-good evidence set passes (threshold 1.0)");
{
  const evidence = { screenshots: ["s1"], errors: [], transcript: ["ok"] };
  const out = await judgeFlow(RUBRIC, evidence, fakeModel({}));
  check("status pass", out.status === "pass");
  check("score 1.0", out.score === 1);
  check("5/5 passes", out.passes === 5 && out.total === 5);
  check("every criterion pass", out.criteria.every((c) => c.verdict === "pass"));
}

console.log("judge: a broken evidence set fails on EXACTLY the broken criterion");
{
  // Only the Firecrawl-disclosure criterion is reported as a fail by the model.
  const out = await judgeFlow(RUBRIC, { errors: [], transcript: [] }, fakeModel({ firecrawl_disclosure: "fail" }));
  check("status fail", out.status === "fail");
  const broken = out.criteria.find((c) => c.id === "firecrawl_disclosure");
  check("disclosure criterion failed", broken.verdict === "fail");
  const others = out.criteria.filter((c) => c.id !== "firecrawl_disclosure");
  check("all other criteria passed", others.every((c) => c.verdict === "pass"));
  check("exactly one non-pass", out.criteria.filter((c) => c.verdict !== "pass").length === 1);
}

console.log("judge: a unanimous 'fail' (any of 3 runs) fails the criterion");
{
  // Return pass on runs 1+3 but fail on run 2 → 'any fail' rule → criterion fails.
  const flaky = (id, n) => JSON.stringify({ criterion: id, verdict: n === 2 ? "fail" : "pass", reason: "x", confidence: 0.8 });
  const out = await judgeFlow(RUBRIC, { errors: [], transcript: [] }, fakeModel({ draft_shown: flaky }));
  check("status fail", out.status === "fail");
  check("flaky criterion is fail", out.criteria.find((c) => c.id === "draft_shown").verdict === "fail");
}

console.log("judge: mixed pass/unknown (no fail) → review_needed, never a silent pass");
{
  const out = await judgeFlow(RUBRIC, { errors: [], transcript: [] }, fakeModel({ draft_shown: "unknown" }));
  check("status review_needed", out.status === "review_needed");
  check("unknown criterion is review_needed", out.criteria.find((c) => c.id === "draft_shown").verdict === "review_needed");
  check("no criterion failed", !out.criteria.some((c) => c.verdict === "fail"));
}

console.log("judge: malformed JSON → retry once → still malformed → review_needed");
{
  let callCount = 0;
  const model = async (req) => {
    if (req.criterion.id === "confirm_before_write") { callCount++; return "definitely not json"; }
    return JSON.stringify({ criterion: req.criterion.id, verdict: "pass", reason: "ok", confidence: 0.9 });
  };
  const out = await judgeFlow(RUBRIC, { errors: [], transcript: [] }, model);
  check("status review_needed", out.status === "review_needed");
  check("retried (2 calls per run x 3 runs = 6)", callCount === 6);
  check("malformed criterion is review_needed", out.criteria.find((c) => c.id === "confirm_before_write").verdict === "review_needed");
}

console.log("judge: malformed-then-valid retry recovers within a run");
{
  // First attempt of EACH call is malformed, second is valid → each run recovers to pass.
  const perCall = new Map();
  const model = async (req) => {
    const k = req.criterion.id;
    const n = (perCall.get(k) || 0) + 1; perCall.set(k, n);
    // odd call = malformed (1st attempt), even call = valid (retry)
    if (n % 2 === 1) return "nope {";
    return JSON.stringify({ criterion: k, verdict: "pass", reason: "recovered", confidence: 0.95 });
  };
  const out = await judgeFlow(RUBRIC, { errors: [], transcript: [] }, model);
  check("status pass after retries recover", out.status === "pass");
}

console.log("judge: an invalid-schema reply (extra field) → retry → review_needed");
{
  const model = async (req) => JSON.stringify({ criterion: req.criterion.id, verdict: "pass", reason: "r", confidence: 0.5, sneaky: true });
  const out = await judgeFlow(RUBRIC, { errors: [], transcript: [] }, model);
  check("status review_needed (schema rejected)", out.status === "review_needed");
}

console.log("judge: rubric guards");
{
  let threw = false;
  try { await judgeFlow({ flow: "x", criteria: [], threshold: 1 }, {}, fakeModel({})); } catch { threw = true; }
  check("empty criteria throws", threw);
  threw = false;
  try { await judgeFlow({ flow: "x", criteria: [{ id: "a", ask: "?" }], threshold: 2 }, {}, fakeModel({})); } catch { threw = true; }
  check("bad threshold throws", threw);
  threw = false;
  try { await judgeFlow(RUBRIC, {}, "not-a-fn"); } catch { threw = true; }
  check("non-function callModel throws", threw);
}

console.log("================================================");
if (failed === 0) { console.log(`${GREEN}ux judge tests PASSED${NC}`); process.exit(0); }
console.log(`${RED}ux judge tests FAILED — ${failed} assertion(s)${NC}`); process.exit(1);
