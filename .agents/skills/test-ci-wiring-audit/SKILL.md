---
name: test-ci-wiring-audit
description: Find test files that exist on disk but run in neither the local test command nor CI (orphaned tests = false confidence), plus stale coverage reports. Use when asked "is this test actually running", "check test wiring", "orphaned tests". Flags and suggests exact fixes; applies nothing.
source: AIOS toolkit skill, born from finding a test wired into neither `npm test` nor CI — coverage that never ran
am_pattern: B2, C8
triggers:
  - orphaned tests
  - tests not running
  - ci wiring
  - test suite audit
  - tests skipped in ci
---

You are auditing whether every test file on disk is actually executed by the local test
command and/or CI. An orphaned test is worse than no test: it looks like coverage,
presumably passed once, and contributes zero confidence today.

**This skill flags only. It does not edit build files or CI workflows** — it suggests
the exact wiring fix and stops.

## Step 1 — glob every test file

Use the stack's conventions (from `AGENTS.md` or by inspection), e.g.:

```bash
# JS/TS            # Python                    # PHP                  # Go
*.test.{js,mjs,ts,tsx}, *.spec.*   test_*.py, *_test.py   *Test.php   *_test.go
find . -type f \( -name "*.test.*" -o -name "*_test.*" -o -name "test_*" -o -name "*Test.php" -o -name "*.spec.*" \) -not -path "*/node_modules/*" -not -path "*/vendor/*" -not -path "*/.venv/*"
```

## Step 2 — resolve what the local test command actually runs

Find the canonical test entry (`AGENTS.md` Commands; else `package.json` `"test"`,
`Makefile` `test:`, `composer.json` scripts, `pyproject.toml`, `tox.ini`). **Follow the
chain**: every sub-script it calls, and the runner config each one loads (vitest/jest
`include`/`testMatch`, pytest `testpaths`, phpunit.xml `<testsuites>`, `go test ./...`
package patterns). Resolve to the concrete set of files it would execute.

## Step 3 — resolve what CI actually runs

Open the CI config (`.github/workflows/*.yml`, `.gitlab-ci.yml`, `Jenkinsfile`, …) and
follow each job's actual `run:` command the same way. Don't trust a step *named* "test"
— confirm the command executes a runner and which globs it matches.

## Step 4 — classify every file from step 1

- **covered-by-both** — fine.
- **one-only** — inconsistent (e.g. runs in CI but not locally, or vice versa). Flag.
- **neither** — **ORPHANED**. The headline finding.

## Step 5 — coverage-report staleness (if a report is committed/cached)

Compare the report's mtime against the latest default-branch commit date; flag if it
predates recent commits by days. Then check that files the report names still exist on
disk — a report citing deleted files is actively misleading.

## Output

```
ORPHANED TESTS
services/billing/refund_test.py     neither `make test` nor ci.yml     suggest: covered by pytest testpaths? add "services" to testpaths in pyproject.toml AND ci job `test`

ONE-ONLY (inconsistent)
gui/server/session.test.mjs         CI only, not local `npm test`      suggest: add glob to package.json "test"

COVERAGE FRESHNESS
coverage/coverage-summary.json      12 days stale vs default-branch HEAD; references deleted file src/old-module.ts
```

Suggest the exact line/glob to add for each finding, then stop — apply nothing.
