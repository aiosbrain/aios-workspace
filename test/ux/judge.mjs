// test/ux/judge.mjs — pure, dependency-injected LLM-as-judge for the cockpit UX harness.
//
// This module is the GATE. It is deliberately PURE and DEPENDENCY-INJECTED:
//   • NO top-level import of any Anthropic SDK (so judge.test.mjs runs zero-dep in the
//     pre-`npm ci` CI job, and so the gate logic is testable with a fake callModel).
//   • The real `callModel` (a thin @anthropic-ai/sdk adapter with temp 0 + image blocks)
//     lives in run-ux.mjs and is INJECTED here.
//
// Per the design (docs/plan-agentic-ux-testing.md) + the approved implementation plan:
//   • One ISOLATED judge call per criterion (one dimension per judge cuts inconsistency).
//   • Strict JSON verdict, schema-VALIDATED (reject missing/extra fields, bad verdict,
//     confidence out of [0,1]). On malformed/invalid → RETRY ONCE, then that criterion is
//     `review_needed`.
//   • Run each criterion 3× (self-consistency): unanimous `pass` → pass; any `fail` → fail;
//     otherwise (mixed / unknown / review_needed) → `review_needed`.
//   • Aggregate: score = passes / total; gate passes iff score >= rubric.threshold AND no
//     criterion failed AND nothing needs review (trust-critical flows run at threshold 1.0).
//
// Grade OUTCOMES, not the path. Give the judge an explicit "unknown" out.

const VALID_VERDICTS = new Set(["pass", "fail", "unknown"]);
const ALLOWED_FIELDS = new Set(["criterion", "verdict", "reason", "confidence"]);
const RUNS_PER_CRITERION = 3;

/**
 * Validate one parsed judge object against the strict schema.
 * Rejects: non-objects, missing fields, EXTRA fields, wrong types, bad verdict,
 * confidence outside [0,1]. Returns { ok, value?, error? }.
 */
export function validateVerdict(parsed) {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not a JSON object" };
  }
  const keys = Object.keys(parsed);
  for (const k of keys) {
    if (!ALLOWED_FIELDS.has(k)) return { ok: false, error: `unexpected field '${k}'` };
  }
  for (const required of ALLOWED_FIELDS) {
    if (!(required in parsed)) return { ok: false, error: `missing field '${required}'` };
  }
  if (typeof parsed.criterion !== "string" || !parsed.criterion) {
    return { ok: false, error: "criterion must be a non-empty string" };
  }
  if (typeof parsed.verdict !== "string" || !VALID_VERDICTS.has(parsed.verdict)) {
    return { ok: false, error: `verdict must be one of ${[...VALID_VERDICTS].join("|")}` };
  }
  if (typeof parsed.reason !== "string") {
    return { ok: false, error: "reason must be a string" };
  }
  if (typeof parsed.confidence !== "number" || Number.isNaN(parsed.confidence) ||
      parsed.confidence < 0 || parsed.confidence > 1) {
    return { ok: false, error: "confidence must be a number in [0,1]" };
  }
  return { ok: true, value: { criterion: parsed.criterion, verdict: parsed.verdict, reason: parsed.reason, confidence: parsed.confidence } };
}

// Parse strict JSON from a model reply. Accepts a bare JSON object only; tolerates
// surrounding whitespace but nothing else (no markdown fences, no prose).
function parseStrict(raw) {
  if (typeof raw !== "string") return { ok: false, error: "model returned non-string" };
  const trimmed = raw.trim();
  let parsed;
  try { parsed = JSON.parse(trimmed); }
  catch (e) { return { ok: false, error: `malformed JSON: ${e.message}` }; }
  return { ok: true, parsed };
}

// Build the messages array for ONE criterion judgment. Outcome-graded, single dimension,
// explicit "unknown" out, strict-JSON contract. `callModel` is responsible for attaching
// the actual screenshot image blocks from `evidence` (it owns the SDK/image encoding).
function buildMessages(flow, criterion, evidence) {
  const system =
    "You are an isolated UX judge. You grade EXACTLY ONE criterion about a product flow " +
    "from the supplied evidence (screenshots, console errors, and a transcript). Grade the " +
    "OUTCOME shown in the evidence, not the path taken. If the evidence is insufficient to " +
    "decide, answer \"unknown\" — never guess. Reply with STRICT JSON only, no prose, no " +
    "markdown fences, exactly these four fields: " +
    '{"criterion": string, "verdict": "pass"|"fail"|"unknown", "reason": string, "confidence": number between 0 and 1}.';
  const user =
    `Flow: ${flow}\n` +
    `Criterion id: ${criterion.id}\n` +
    `Question to grade: ${criterion.ask}\n\n` +
    "Evidence is attached (screenshots + the items below). Decide pass/fail/unknown for " +
    "this single criterion.\n\n" +
    `Console errors captured: ${JSON.stringify(evidence?.errors ?? [])}\n` +
    `Transcript (driver steps + observations): ${JSON.stringify(evidence?.transcript ?? [])}\n`;
  return { system, messages: [{ role: "user", content: user }], criterion, evidence };
}

/**
 * Judge ONE criterion: isolated call → strict-JSON parse → schema validate. On
 * malformed/invalid, RETRY ONCE; if it still fails, the verdict is "review_needed".
 * Returns { verdict: "pass"|"fail"|"unknown"|"review_needed", reason, confidence, raw? }.
 */
async function judgeCriterionOnce(flow, criterion, evidence, callModel) {
  const req = buildMessages(flow, criterion, evidence);
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw;
    try { raw = await callModel(req); }
    catch (e) { if (attempt === 1) return { verdict: "review_needed", reason: `judge call error: ${e.message}`, confidence: 0 }; continue; }
    const parsed = parseStrict(raw);
    if (!parsed.ok) { if (attempt === 1) return { verdict: "review_needed", reason: parsed.error, confidence: 0 }; continue; }
    const valid = validateVerdict(parsed.parsed);
    if (!valid.ok) { if (attempt === 1) return { verdict: "review_needed", reason: `invalid verdict: ${valid.error}`, confidence: 0 }; continue; }
    return valid.value;
  }
  // Unreachable, but stay safe.
  return { verdict: "review_needed", reason: "exhausted retries", confidence: 0 };
}

// Collapse 3 self-consistency runs to one criterion verdict:
//   unanimous pass → pass · any fail → fail · otherwise → review_needed.
function reduceRuns(runs) {
  if (runs.some((r) => r.verdict === "fail")) return "fail";
  if (runs.length === RUNS_PER_CRITERION && runs.every((r) => r.verdict === "pass")) return "pass";
  return "review_needed";
}

/**
 * judgeFlow — the public gate. PURE: all model access goes through the injected
 * `callModel(req)` where `req = { system, messages, criterion, evidence }` and the
 * return is the model's raw STRING reply.
 *
 * @param {{flow:string, criteria:Array<{id:string,ask:string}>, threshold:number}} rubric
 * @param {{screenshots?:string[], errors?:any[], transcript?:any[]}} evidence
 * @param {(req:object)=>Promise<string>} callModel
 * @returns {Promise<{flow, status, score, threshold, passes, total, criteria:Array}>}
 *   status ∈ "pass" | "fail" | "review_needed".
 */
export async function judgeFlow(rubric, evidence, callModel) {
  if (!rubric || !Array.isArray(rubric.criteria) || !rubric.criteria.length) {
    throw new Error("judgeFlow: rubric must have a non-empty criteria array");
  }
  if (typeof rubric.threshold !== "number" || rubric.threshold < 0 || rubric.threshold > 1) {
    throw new Error("judgeFlow: rubric.threshold must be a number in [0,1]");
  }
  if (typeof callModel !== "function") throw new Error("judgeFlow: callModel must be a function");

  const flow = rubric.flow || "unknown-flow";
  const results = [];
  for (const criterion of rubric.criteria) {
    const runs = [];
    for (let i = 0; i < RUNS_PER_CRITERION; i++) {
      runs.push(await judgeCriterionOnce(flow, criterion, evidence, callModel));
    }
    const verdict = reduceRuns(runs);
    results.push({
      id: criterion.id,
      ask: criterion.ask,
      verdict,
      runs: runs.map((r) => ({ verdict: r.verdict, reason: r.reason, confidence: r.confidence })),
    });
  }

  const total = results.length;
  const passes = results.filter((r) => r.verdict === "pass").length;
  const anyFail = results.some((r) => r.verdict === "fail");
  const anyReview = results.some((r) => r.verdict === "review_needed");
  const score = passes / total;

  // Gate: a fail anywhere → "fail". Any review-needed → "review_needed" (triage, never a
  // silent pass). Otherwise pass iff the score clears the threshold. Trust-critical flows
  // set threshold 1.0 so a single non-pass blocks.
  let status;
  if (anyFail) status = "fail";
  else if (anyReview) status = "review_needed";
  else status = score >= rubric.threshold ? "pass" : "fail";

  return { flow, status, score, threshold: rubric.threshold, passes, total, criteria: results };
}
