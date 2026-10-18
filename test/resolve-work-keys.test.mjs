// test/resolve-work-keys.test.mjs — AIO-556: PR merge must close ONLY the
// issue the PR implements, not every issue key mentioned anywhere in the body.
// Verifies the priority-based selection in .github/lib/resolve-work-keys.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWorkKeys } from "../.github/lib/resolve-work-keys.mjs";

// 1. Branch wins over body prose (case-insensitive branch extraction)
test("branch wins over body prose", () => {
  assert.deepEqual(
    resolveWorkKeys(
      "docs(spec): AIO-539, AIO-540",
      "This fixes AIO-531 too.",
      "feat/aio-539-mutation"
    ),
    ["AIO-539"]
  );
});

// 2. Explicit trailer beats branch
test("explicit trailer beats branch", () => {
  assert.deepEqual(resolveWorkKeys("fix(foo)", "AIOS-Work: AIO-540", "feat/aio-539-x"), [
    "AIO-540",
  ]);
});

// 3. Title fallback when no trailer or branch match
test("title fallback; body prose ignored", () => {
  assert.deepEqual(resolveWorkKeys("fix(foo) (AIO-123)", "This also touches AIO-456.", ""), [
    "AIO-123",
  ]);
});

// 4. Body-only mention → no event
test("body-only mention produces no event", () => {
  assert.deepEqual(resolveWorkKeys("generic title", "See AIO-999 for context.", ""), []);
});

// 5. Multiple trailers on separate lines
test("multiple trailers — separate lines", () => {
  assert.deepEqual(resolveWorkKeys("generic", "AIOS-Work: AIO-531\nAIOS-Work: AIO-532", ""), [
    "AIO-531",
    "AIO-532",
  ]);
});

// 6. Multiple keys on one trailer line
test("multiple keys on one trailer line", () => {
  assert.deepEqual(resolveWorkKeys("generic", "AIOS-Work: AIO-531 AIO-532", ""), [
    "AIO-531",
    "AIO-532",
  ]);
});

// 7. Empty inputs → no event, exit 0
test("empty inputs produce no event", () => {
  assert.deepEqual(resolveWorkKeys("", "", ""), []);
});

// 8. Hierarchical key in title (second alternation W2.5.8)
test("hierarchical key in title", () => {
  assert.deepEqual(resolveWorkKeys("feat(x): W2.5.8 support", "", ""), ["W2.5.8"]);
});

// 9. HTML comment stripped before trailer scan
test("HTML comment stripped before trailer scan", () => {
  assert.deepEqual(resolveWorkKeys("generic", "AIOS-Work: <!-- e.g. AIO-72 -->", ""), []);
});

// 10. Trailer wins over all other sources
test("trailer wins over title, body prose, and branch", () => {
  assert.deepEqual(resolveWorkKeys("fix: AIO-100", "AIO-200\nAIOS-Work: AIO-300", "feat/aio-400"), [
    "AIO-300",
  ]);
});

// 11. Duplicate trailers are deduped
test("duplicate trailers deduped", () => {
  assert.deepEqual(resolveWorkKeys("generic", "AIOS-Work: AIO-531\nAIOS-Work: AIO-531", ""), [
    "AIO-531",
  ]);
});

// 12. Hierarchical key in branch falls through to title (A2: branch keys are Linear-shaped only)
test("hierarchical key in branch falls through to title (A2)", () => {
  // Branch extraction does NOT extract hierarchical keys; falls through to title.
  assert.deepEqual(resolveWorkKeys("generic", "", "feat/w2.5.8-support"), []);
  assert.deepEqual(resolveWorkKeys("feat: W2.5.8 support", "", "feat/w2.5.8-support"), ["W2.5.8"]);
});

// 13. Regression: empty AIOS-Work: line must NOT swallow the next line's key
test("empty trailer line does not capture next-line body mention", () => {
  const body = "AIOS-Work:\nBlocked by AIO-999";
  assert.deepEqual(resolveWorkKeys("generic", body, "feat/aio-100"), ["AIO-100"]);
});

// Reviewer scenarios (Fable, AIO-556): version/package branches must not manufacture keys that
// outrank the real key in the title.
test("release and versioned branches defer to the title", () => {
  assert.deepEqual(resolveWorkKeys("AIO-864: cut release", "", "release/v0.11.1"), ["AIO-864"]);
  assert.deepEqual(resolveWorkKeys("AIO-995: bump api", "", "feat/brain-api-1.22-rollout"), [
    "AIO-995",
  ]);
  assert.deepEqual(
    resolveWorkKeys("AIO-1112: toolkit 2.1", "", "remediation/aio1112-toolkit-2.1"),
    ["AIO-1112"]
  );
  assert.deepEqual(resolveWorkKeys("chore: bump c8", "", "dependabot/npm_and_yarn/c8-12.0.0"), []);
  assert.deepEqual(resolveWorkKeys("AIO-864: x", "", "renovate/node-22.x"), ["AIO-864"]);
  assert.deepEqual(resolveWorkKeys("AIO-864: x", "", "chore/node-24.1-upgrade"), ["AIO-864"]);
});

test("a leading branch key is used, only the first one", () => {
  assert.deepEqual(resolveWorkKeys("x", "", "fix/AIO-12-and-AIO-13"), ["AIO-12"]);
  assert.deepEqual(resolveWorkKeys("x", "", "aio-556-no-type-prefix"), ["AIO-556"]);
});

test("single-letter or letter-digit branch prefix does not match (A2: two or more letters)", () => {
  assert.deepEqual(resolveWorkKeys("AIO-999: fix", "", "feat/a-123"), ["AIO-999"]);
  assert.deepEqual(resolveWorkKeys("AIO-999: fix", "", "feat/a1-123"), ["AIO-999"]);
  assert.deepEqual(resolveWorkKeys("x", "", "feat/a-123"), []);
  assert.deepEqual(resolveWorkKeys("x", "", "feat/a1-123"), []);
});

test("non-string inputs do not throw", () => {
  assert.deepEqual(resolveWorkKeys(null, undefined, 7), []);
  assert.deepEqual(resolveWorkKeys(5, 6, 7), []);
});

// The workflow carries an inline copy (no checkout allowed). It must behave exactly like the
// canonical module, and it must not post an event when there is no key.
import { readFileSync } from "node:fs";
const yml = readFileSync(
  new URL("../.github/workflows/aios-work-sync.yml", import.meta.url),
  "utf8"
);
const inlineStart = yml.indexOf("const WORK_KEY_RE");
const inlineEnd = yml.indexOf("const workKeys = resolveWorkKeys");
const inline = new Function(`${yml.slice(inlineStart, inlineEnd)}\nreturn resolveWorkKeys;`)();

test("inline workflow copy matches the canonical module", () => {
  const rows = [
    ["docs(spec): x (AIO-539, AIO-540)", "see AIO-531", "feat/aio-539-mutation"],
    ["fix", "AIOS-Work: AIO-540", "feat/aio-539-x"],
    ["fix(foo) (AIO-123)", "prose AIO-456", ""],
    ["generic", "AIO-999 prose", ""],
    ["generic", "AIOS-Work:\nBlocked by AIO-999", ""],
    ["generic", "AIOS-Work: AIO-1 AIO-2\r\nAIOS-Work: AIO-3", ""],
    ["AIO-864: r", "", "release/v0.11.1"],
    ["x", "<!-- AIOS-Work: AIO-8 -->", "fix/AIO-12-and-AIO-13"],
    [null, undefined, undefined],
    // Pins the inline copy's branch anchor and first-title-key-only rule (mutation-tested by review).
    ["AIO-995: x", "", "feat/brain-api-1.22-rollout"],
    ["AIO-1112: x", "", "remediation/aio1112-toolkit-2.1"],
    ["fix: AIO-1 AIO-2", "", ""],
    ["x", "AIOS-Work: AIO-568 (epic AIO-541)", ""],
    ["x", "AIOS-Work: AIO-1, AIO-2 and AIO-3", ""],
    ["fix: AIO-540 x", "AIOS-Work: `AIO-540`", "feat/aio-539-x"],
    ["x", "AIOS-Work: [AIO-5](https://linear.app/x/issue/AIO-5), (AIO-6)", ""],
    ["Q3 roadmap page (AIO-512)", "", ""],
    ["feat: V0.11.1 then AIO-5", "", ""],
    ["x", "", "a".repeat(65536)],
    ["x", "", "feat/aio-5a"],
    ["AIO-999: fix", "", "feat/a-123"],
    ["AIO-999: fix", "", "feat/a1-123"],
    ["x", "", "feat/a-123"],
    ["x", "AIOS-Work: AIO-568a", ""],
    ["x", "AIOS-Work: W2.5.8x", ""],
    ["AIO-864: x", "", "renovate/node-22.x"],
    ["AIO-864: x", "", "chore/node-24.1-upgrade"],
    ["x", "AIOS-Work: aio-540", "feat/aio-539-x"],
    ["x", "AIOS-Work: aio-1, aio-2", ""],
  ];
  for (const r of rows) assert.deepEqual(inline(...r), resolveWorkKeys(...r), JSON.stringify(r));
});

test("workflow posts nothing when no key resolves", () => {
  const guard = yml.indexOf("workKeys.length === 0");
  const post = yml.indexOf("api/v1/work-events");
  assert.ok(guard !== -1 && guard < post, "empty-key guard must precede the POST");
  assert.match(yml.slice(guard, post), /process\.exit\(0\)/);
});

test("trailer uses leading key run — first non-key token stops extraction (A1)", () => {
  // Prose-in-parens after the key stops the run; the aside key is not extracted.
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: AIO-568 (epic AIO-541)", ""), ["AIO-568"]);
  // "and" is a non-key token; AIO-3 is not extracted.
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: AIO-1, AIO-2 and AIO-3", ""), [
    "AIO-1",
    "AIO-2",
  ]);
  // A trailer starting with prose is unreadable; falls back to branch/title.
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: see AIO-9", "", []), []);
});

test("a very long slash-free branch does not backtrack quadratically", () => {
  const t0 = Date.now();
  resolveWorkKeys("x", "", "a".repeat(65536));
  assert.ok(Date.now() - t0 < 250, "branch matching must be bounded");
});

test("a wrapped trailer key is still an explicit trailer (backticks, brackets, markdown link, punctuation)", () => {
  for (const line of [
    "`AIO-540`",
    "(AIO-540)",
    "[AIO-540](https://linear.app/x/issue/AIO-540)",
    "AIO-540.",
    "AIO-540;",
    "**AIO-540**",
  ]) {
    assert.deepEqual(
      resolveWorkKeys("fix: AIO-539", `AIOS-Work: ${line}`, "feat/aio-538-x"),
      ["AIO-540"],
      line
    );
  }
});

test("lowercase trailer keys are normalized to uppercase", () => {
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: aio-540", "feat/aio-539-x"), ["AIO-540"]);
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: aio-1, aio-2", ""), ["AIO-1", "AIO-2"]);
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: `aio-540`", ""), ["AIO-540"]);
});

test("bare trailer key with trailing alphanumeric is not a valid key (A1 boundary)", () => {
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: AIO-568a", ""), []);
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: W2.5.8x", ""), []);
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: AIO-568 foo", ""), ["AIO-568"]);
});

test("an unreadable trailer is reported and falls back to branch and title", () => {
  const notes = [];
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: none", "feat/aio-539-x", notes), ["AIO-539"]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /AIOS-Work trailer is present/);
});

test("a dotless token in the title never shadows the real key", () => {
  assert.deepEqual(resolveWorkKeys("Q3 roadmap page (AIO-512)", "", ""), ["AIO-512"]);
  assert.deepEqual(resolveWorkKeys("feat: V2 of assessment flow AIO-512", "", ""), ["AIO-512"]);
  assert.deepEqual(resolveWorkKeys("feat: V0.11.1 then AIO-5", "", ""), ["AIO-5"]);
  assert.deepEqual(resolveWorkKeys("Q3 roadmap", "", ""), []);
  assert.deepEqual(resolveWorkKeys("feat(x): W2.5.8 support", "", ""), ["W2.5.8"]);
});

// Reviewer M1 (exact-head review of 635d4cac): every wrapper the template promises must still be an
// explicit trailer, and an explicit trailer must beat the branch.
test("any Markdown wrapper around a trailer key is still an explicit trailer", () => {
  const long = "https://linear.app/je4light/issue/AIO-540/" + "slug-".repeat(60);
  for (const line of [
    "[AIO-540]",
    "*AIO-540*",
    "_AIO-540_",
    '"AIO-540"',
    "***AIO-540***",
    "(AIO-540",
    `[AIO-540](${long})`,
    "AIO-540;",
  ]) {
    assert.deepEqual(
      resolveWorkKeys("fix: x", `AIOS-Work: ${line}`, "feat/aio-539-x"),
      ["AIO-540"],
      line
    );
  }
});

test("semicolons separate trailer keys like commas do", () => {
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: AIO-1;AIO-2", ""), ["AIO-1", "AIO-2"]);
  assert.deepEqual(resolveWorkKeys("x", "AIOS-Work: AIO-1; AIO-2, AIO-3 (epic AIO-9)", ""), [
    "AIO-1",
    "AIO-2",
    "AIO-3",
  ]);
});

test("a very long run of closing punctuation in a trailer does not backtrack quadratically", () => {
  const t0 = Date.now();
  resolveWorkKeys("x", `AIOS-Work: ${".".repeat(65000)}AIO-5`, "");
  assert.ok(Date.now() - t0 < 250);
});

test("a long markdown link in a trailer is still unwrapped and recognized", () => {
  const longUrl = "https://linear.app/x/issue/AIO-540/" + "a".repeat(500);
  assert.deepEqual(
    resolveWorkKeys("x", `AIOS-Work: [AIO-540](${longUrl})`, ""),
    ["AIO-540"]
  );
});

test("the inline copy agrees on notes, dedupe, list-dash and commented trailers (reviewer L4)", () => {
  const rows = [
    ["x", "- AIOS-Work: AIO-5", ""],
    ["x", "AIOS-Work: AIO-5\nAIOS-Work: AIO-5", ""],
    ["x", "<!--\nAIOS-Work: AIO-8\n-->", ""],
    ["x", "AIOS-Work: none", "feat/aio-9-x"],
    ["x", "AIOS-Work: [AIO-540]", "feat/aio-539-x"],
  ];
  for (const r of rows) {
    const a = [];
    const b = [];
    assert.deepEqual(inline(...r, a), resolveWorkKeys(...r, b), JSON.stringify(r));
    assert.deepEqual(a, b, `notes ${JSON.stringify(r)}`);
  }
});
