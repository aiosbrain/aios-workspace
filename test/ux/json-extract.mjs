// test/ux/json-extract.mjs — normalize a model's text response down to a bare JSON object string.
//
// Why: the LLM judge gate (judge.mjs) is intentionally STRICT — parseStrict rejects markdown
// fences and surrounding prose by contract, because that strictness is what makes the gate
// trustworthy. But models routinely wrap their JSON in a ```json … ``` fence despite being told
// not to (observed live: every verdict came back "malformed JSON: Unexpected token '`'"). So the
// REAL callModel adapter normalizes the model's text HERE before handing it to the judge — the
// gate stays strict; the adapter absorbs the model's well-known formatting quirk.
//
// Pure + dependency-free so it is unit-testable in the pre-`npm ci` CI job.

/**
 * Reduce a model text response to the bare JSON object substring:
 *   1. strip a wrapping ```json … ``` (or ``` … ```) markdown fence, then
 *   2. slice from the first "{" to the last "}" (drops any leading/trailing prose).
 * Returns the original trimmed text unchanged when no object is present, so the judge's
 * strict parse/validation still fails closed on genuine garbage.
 */
export function extractJsonObject(text) {
  if (typeof text !== "string") return "";
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return t.slice(first, last + 1);
  return t;
}
