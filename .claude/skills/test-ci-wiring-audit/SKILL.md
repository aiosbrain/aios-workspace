---
name: test-ci-wiring-audit
description: Find test files that exist on disk but run in neither `npm test` nor CI (orphaned tests = false confidence), plus stale/inaccurate coverage reports. Use when the user asks "is this test actually running", "check test wiring", "orphaned tests", or invokes /test-wiring-check. Pure static parsing — flags issues and suggests exact wiring fixes; does not apply them.
---

You are auditing whether every test file on disk is actually wired into `npm test` and/or CI. The 2026-07-09 audit found `gui/server/memory-reviewer.test.mjs` wired into neither `npm test` nor `.github/workflows/ci.yml` — a test that looked like coverage but never ran — and, in a sibling repo, a 12-day-stale `coverage-summary.json` citing a file that had since been deleted.

**This skill flags only. It does not edit `package.json` or CI workflow files** — it suggests the exact wiring fix and stops.

## Step 1 — glob every test file

```bash
find . -type f \( -name "*.test.mjs" -o -name "*.test.ts" -o -name "*.test.tsx" \) -not -path "*/node_modules/*"
```

## Step 2 — parse what `npm test` actually runs

```bash
grep -n "\"test\"" package.json
```

Follow every script the `test` entry chains to (e.g. `pretest`, `test:unit`, `test:e2e`) and resolve whatever glob/path pattern each one invokes (look inside the referenced test runner config too, e.g. `--test` globs, a `vitest.config.*` `include`, or an explicit file list).

## Step 3 — parse what CI actually runs

```bash
grep -n "run:\|test" .github/workflows/*.yml
```

Resolve the same way: follow each `run:` step to the actual command and glob/path pattern it invokes. Don't just grep for the word "test" in a step name — confirm the step's `run:` command actually executes a test file or matches a glob that would include it.

## Step 4 — classify every test file found in step 1

For each file from step 1, check membership against the resolved sets from steps 2 and 3:

- **covered-by-both** — fine.
- **one-only** — flag the inconsistency (e.g. runs in CI but not local `npm test`, or vice versa).
- **neither** — **ORPHANED**. This is the finding: a test that exists, presumably passed at some point, and contributes zero confidence today because nothing executes it.

## Step 5 — coverage report staleness

```bash
ls coverage/coverage-summary.json 2>/dev/null
```

If it exists:

```bash
git log -1 --format=%ci origin/main
stat -f '%Sm' coverage/coverage-summary.json 2>/dev/null || stat -c '%y' coverage/coverage-summary.json
```

Compare the coverage report's mtime against the latest `origin/main` commit date — flag if stale (report predates recent commits by a meaningful margin, e.g. days). Then check that every file the report calls out as a top offender (lowest coverage / most uncovered lines) still exists on disk:

```bash
node -e "const c=require('./coverage/coverage-summary.json'); Object.keys(c).filter(k=>k!=='total').forEach(f=>console.log(f))" | while read -r f; do [ -f "$f" ] || echo "STALE REFERENCE (deleted file): $f"; done
```

## Output format

```
ORPHANED TESTS
gui/server/memory-reviewer.test.mjs      neither npm test nor ci.yml      suggest: add to "test" script glob AND ci.yml test step

ONE-ONLY (inconsistent)
scripts/foo.test.mjs                     CI only, not in local npm test   suggest: add to package.json "test" script

COVERAGE FRESHNESS
coverage/coverage-summary.json           12 days stale vs origin/main HEAD
  references deleted file: src/old-module.ts
```

Suggest the exact `package.json`/`ci.yml` line to add for each orphaned/one-only test, but stop there — apply nothing.
