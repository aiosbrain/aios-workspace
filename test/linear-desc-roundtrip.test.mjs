// test/linear-desc-roundtrip.test.mjs — description round-trip integrity (AIO-942)
//
// Linear re-serialises every description it stores. Most of that is cosmetic; one case is
// not. A markdown table INDENTED under a list item comes back with leading characters
// stripped from every cell after the first column — silent content loss, observed on
// VIB-348 on 2026-08-19. These tests pin the real payload from that incident.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeContentDrift,
  findIndentedTables,
  normalizeForCompare,
} from "../scaffold/.claude/skills/aios-linear/linear-template.mjs";

// The exact markdown sent to VIB-348, and the exact markdown Linear stored.
const SENT = [
  "3. **Reconcile the outcome encoding.**",
  "",
  "   | Slice | file | `dead-end` |",
  "   |---|---|---|",
  "   | I2 (#8) | `components/experiments/outcome-marker.tsx:24` | `CircleX` / `text-red` |",
  "   | I3 (#9) | `experiments-index.tsx` | plain text, no icon or colour |",
].join("\n");

const STORED = [
  "3. **Reconcile the outcome encoding.**",
  "",
  "   | Slice | file | `dead-end` |",
  "   | -- | -- | -- |",
  "   | (#8) | mponents/experiments/outcome-marker.tsx:24` | rcleX`/`text-red` |",
  "   | (#9) | periments-index.tsx` | in text, no icon or colour |",
].join("\n");

test("the VIB-348 corruption is detected as content drift", () => {
  const drift = describeContentDrift(SENT, STORED);
  assert.ok(drift, "must not report the mangled table as equivalent");
  // The divergence is the dropped row label, not somewhere incidental.
  assert.match(drift.local, /I2 \(#8\)/);
  assert.doesNotMatch(drift.remote, /I2 \(#8\)/);
});

test("a byte-compare cannot tell that corruption from routine reformatting", () => {
  // Both differ byte-wise from what was sent; only one is real loss. This is why
  // verify-desc's byte-compare stopped being an actionable gate.
  assert.notEqual(SENT, STORED);
  assert.notEqual("**not `x` icon**", "**not** `x` **icon**");
  assert.equal(describeContentDrift("**not `x` icon**", "**not** `x` **icon**"), null);
});

test("Linear's cosmetic rewrites are not reported as drift", () => {
  // emphasis re-bracketed around inline code
  assert.equal(describeContentDrift("**There is no `x` icon.**", "**There is no** `x` **icon.**"), null);
  // yaml frontmatter rewritten to a fence
  assert.equal(
    describeContentDrift("---\neval_tier: full\n---\n\n# T", "```yaml\neval_tier: full\n```\n\n# T"),
    null
  );
  // table delimiter row restyled
  assert.equal(
    describeContentDrift("| a | b |\n|---|---|\n| 1 | 2 |", "| a | b |\n| -- | -- |\n| 1 | 2 |"),
    null
  );
  // re-indentation and re-wrapping
  assert.equal(describeContentDrift("a\n  b\n\n\nc", "a\nb\nc"), null);
});

test("genuine content loss is still reported", () => {
  assert.ok(describeContentDrift("neutral, never red, never an X", "neutral, never red, never an"));
  assert.ok(describeContentDrift("| CircleSlash | neutral |", "| rcleSlash | neutral |"));
});

test("findIndentedTables flags the shape Linear corrupts", () => {
  const hits = findIndentedTables(SENT);
  assert.equal(hits.length, 4, "every indented table row is reported");
  assert.equal(hits[0].line, 3);
  assert.match(hits[0].text, /\| Slice \| file \|/);
});

test("findIndentedTables ignores tables that are safe", () => {
  // column-0 tables round-trip fine and must not be flagged
  assert.deepEqual(findIndentedTables("| a | b |\n|---|---|\n| 1 | 2 |"), []);
  // a fenced example of the bug is documentation, not the bug
  assert.deepEqual(findIndentedTables("```\n   | a | b |\n   |---|---|\n```"), []);
  assert.deepEqual(findIndentedTables("~~~md\n   | a | b |\n~~~"), []);
  // prose and indented bullets are unaffected
  assert.deepEqual(findIndentedTables("- a bullet\n  - nested\n\ntext | with a pipe"), []);
});

test("normalizeForCompare preserves visible characters", () => {
  // normalisation must not be so aggressive that it hides loss
  const a = normalizeForCompare("**bold** `code` plain");
  assert.match(a, /bold/);
  assert.match(a, /code/);
  assert.match(a, /plain/);
});
