#!/usr/bin/env node
// test/resolve-work-keys.test.mjs — AIO-556: PR merge must close ONLY the
// issue the PR implements, not every issue key mentioned anywhere in the body.
// Verifies the priority-based selection in .github/lib/resolve-work-keys.mjs.
// Run: node test/resolve-work-keys.test.mjs

import { resolveWorkKeys } from "../.github/lib/resolve-work-keys.mjs";

let failed = 0;
const RED = "\x1b[0;31m",
  GREEN = "\x1b[0;32m",
  NC = "\x1b[0m";
function check(label, cond) {
  if (cond) console.log(`  ${GREEN}✓${NC} ${label}`);
  else {
    console.log(`  ${RED}✗${NC} ${label}`);
    failed++;
  }
}

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ── 1. Branch wins over body prose (case-insensitive branch extraction) ──────
{
  const got = resolveWorkKeys(
    "docs(spec): AIO-539, AIO-540",
    "This fixes AIO-531 too.",
    "feat/aio-539-mutation"
  );
  check("branch wins over body prose", eq(got, ["AIO-539"]));
}

// ── 2. Explicit trailer beats branch ─────────────────────────────────────────
{
  const got = resolveWorkKeys("fix(foo)", "AIOS-Work: AIO-540", "feat/aio-539-x");
  check("explicit trailer beats branch", eq(got, ["AIO-540"]));
}

// ── 3. Title fallback when no trailer or branch match ────────────────────────
{
  const got = resolveWorkKeys("fix(foo) (AIO-123)", "This also touches AIO-456.", "");
  check("title fallback; body prose ignored", eq(got, ["AIO-123"]));
}

// ── 4. Body-only mention → no event ──────────────────────────────────────────
{
  const got = resolveWorkKeys("generic title", "See AIO-999 for context.", "");
  check("body-only mention produces no event", eq(got, []));
}

// ── 5. Multiple trailers on separate lines ────────────────────────────────────
{
  const got = resolveWorkKeys("generic", "AIOS-Work: AIO-531\nAIOS-Work: AIO-532", "");
  check("multiple trailers — separate lines", eq(got, ["AIO-531", "AIO-532"]));
}

// ── 6. Multiple keys on one trailer line ─────────────────────────────────────
{
  const got = resolveWorkKeys("generic", "AIOS-Work: AIO-531 AIO-532", "");
  check("multiple keys on one trailer line", eq(got, ["AIO-531", "AIO-532"]));
}

// ── 7. Empty inputs → no event, exit 0 ───────────────────────────────────────
{
  const got = resolveWorkKeys("", "", "");
  check("empty inputs produce no event", eq(got, []));
}

// ── 8. Hierarchical key in title (second alternation W2.5.8) ─────────────────
{
  const got = resolveWorkKeys("feat(x): W2.5.8 support", "", "");
  check("hierarchical key in title", eq(got, ["W2.5.8"]));
}

// ── 9. HTML comment stripped before trailer scan ─────────────────────────────
{
  const got = resolveWorkKeys("generic", "AIOS-Work: <!-- e.g. AIO-72 -->", "");
  check("HTML comment stripped before trailer scan", eq(got, []));
}

// ── 10. Trailer wins over all other sources ───────────────────────────────────
{
  const got = resolveWorkKeys("fix: AIO-100", "AIO-200\nAIOS-Work: AIO-300", "feat/aio-400");
  check("trailer wins over title, body prose, and branch", eq(got, ["AIO-300"]));
}

// ── 11. Duplicate trailers are deduped ───────────────────────────────────────
{
  const got = resolveWorkKeys("generic", "AIOS-Work: AIO-531\nAIOS-Work: AIO-531", "");
  check("duplicate trailers deduped", eq(got, ["AIO-531"]));
}

// ── 12. Hierarchical key in branch (case-insensitive) ────────────────────────
{
  const got = resolveWorkKeys("generic", "", "feat/w2.5.8-support");
  check("hierarchical key in branch (lowercase)", eq(got, ["W2.5.8"]));
}

// ── summary ──────────────────────────────────────────────────────────────────
if (failed) {
  console.log(`\n${RED}${failed} test(s) failed${NC}`);
  process.exit(1);
} else {
  console.log(`\n${GREEN}All tests passed${NC}`);
}
