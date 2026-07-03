// LLM-boundary invariant (AIO-192, Major #3): llm.ts is the ONLY operator-loop module that imports
// the Anthropic SDK or constructs a client. A static scan of the TS sources enforces it — any new
// module that reaches for `@anthropic-ai/sdk` or `new Anthropic(` outside llm.ts fails this test.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = path.join(ROOT, "src", "operator-loop");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("only llm.ts imports the Anthropic SDK / constructs a client", () => {
  const offenders = [];
  for (const file of walk(SRC)) {
    if (path.basename(file) === "llm.ts") continue;
    const text = readFileSync(file, "utf8");
    if (/@anthropic-ai\/sdk/.test(text) || /new\s+Anthropic\s*\(/.test(text)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `SDK usage must stay in llm.ts; found in: ${offenders.join(", ")}`);
});
