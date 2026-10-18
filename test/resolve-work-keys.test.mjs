// test/resolve-work-keys.test.mjs — AIO-556: PR merge must close ONLY the
// issue the PR implements, not every issue key mentioned anywhere in the body.
// Verifies the priority-based selection in .github/lib/resolve-work-keys.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkKeys } from "../.github/lib/resolve-work-keys.mjs";

// 1. Branch wins over body prose (case-insensitive branch extraction)
test("branch wins over body prose", () => {
  assert.deepEqual(
    resolveWorkKeys("docs(spec): AIO-539, AIO-540", "This fixes AIO-531 too.", "feat/aio-539-mutation"),
    ["AIO-539"]
  );
});

// 2. Explicit trailer beats branch
test("explicit trailer beats branch", () => {
  assert.deepEqual(
    resolveWorkKeys("fix(foo)", "AIOS-Work: AIO-540", "feat/aio-539-x"),
    ["AIO-540"]
  );
});

// 3. Title fallback when no trailer or branch match
test("title fallback; body prose ignored", () => {
  assert.deepEqual(
    resolveWorkKeys("fix(foo) (AIO-123)", "This also touches AIO-456.", ""),
    ["AIO-123"]
  );
});

// 4. Body-only mention → no event
test("body-only mention produces no event", () => {
  assert.deepEqual(
    resolveWorkKeys("generic title", "See AIO-999 for context.", ""),
    []
  );
});

// 5. Multiple trailers on separate lines
test("multiple trailers — separate lines", () => {
  assert.deepEqual(
    resolveWorkKeys("generic", "AIOS-Work: AIO-531\nAIOS-Work: AIO-532", ""),
    ["AIO-531", "AIO-532"]
  );
});

// 6. Multiple keys on one trailer line
test("multiple keys on one trailer line", () => {
  assert.deepEqual(
    resolveWorkKeys("generic", "AIOS-Work: AIO-531 AIO-532", ""),
    ["AIO-531", "AIO-532"]
  );
});

// 7. Empty inputs → no event, exit 0
test("empty inputs produce no event", () => {
  assert.deepEqual(resolveWorkKeys("", "", ""), []);
});

// 8. Hierarchical key in title (second alternation W2.5.8)
test("hierarchical key in title", () => {
  assert.deepEqual(
    resolveWorkKeys("feat(x): W2.5.8 support", "", ""),
    ["W2.5.8"]
  );
});

// 9. HTML comment stripped before trailer scan
test("HTML comment stripped before trailer scan", () => {
  assert.deepEqual(
    resolveWorkKeys("generic", "AIOS-Work: <!-- e.g. AIO-72 -->", ""),
    []
  );
});

// 10. Trailer wins over all other sources
test("trailer wins over title, body prose, and branch", () => {
  assert.deepEqual(
    resolveWorkKeys("fix: AIO-100", "AIO-200\nAIOS-Work: AIO-300", "feat/aio-400"),
    ["AIO-300"]
  );
});

// 11. Duplicate trailers are deduped
test("duplicate trailers deduped", () => {
  assert.deepEqual(
    resolveWorkKeys("generic", "AIOS-Work: AIO-531\nAIOS-Work: AIO-531", ""),
    ["AIO-531"]
  );
});

// 12. Hierarchical key in branch (case-insensitive)
test("hierarchical key in branch (lowercase)", () => {
  assert.deepEqual(
    resolveWorkKeys("generic", "", "feat/w2.5.8-support"),
    ["W2.5.8"]
  );
});

// 13. Regression: empty AIOS-Work: line must NOT swallow the next line's key
test("empty trailer line does not capture next-line body mention", () => {
  const body = "AIOS-Work:\nBlocked by AIO-999";
  assert.deepEqual(
    resolveWorkKeys("generic", body, "feat/aio-100"),
    ["AIO-100"]
  );
});
