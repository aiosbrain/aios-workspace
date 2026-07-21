#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHECK="$ROOT/evals/scenarios/onboarding-catalog-freshness/check-catalog-fresh.mjs"
PASS=0
FAIL=0
TMP=$(mktemp -d /tmp/check-catalog-fresh-test.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

report() {
  local name="$1" status="$2"
  if [ "$status" -eq 0 ]; then
    PASS=$((PASS+1)); echo "PASS: $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $name"
  fi
}

node "$CHECK" >/dev/null 2>&1
[ "$?" -eq 1 ]
report "missing argument -> exit 1" $?

node "$CHECK" "relative/path" >/dev/null 2>&1
[ "$?" -eq 1 ]
report "relative path argument -> exit 1" $?

node "$CHECK" "$TMP/does-not-exist" >/dev/null 2>&1
[ "$?" -eq 1 ]
report "nonexistent directory argument -> exit 1" $?

FILE_ARG="$TMP/a-file"
touch "$FILE_ARG"
node "$CHECK" "$FILE_ARG" >/dev/null 2>&1
[ "$?" -eq 1 ]
report "a file (not a directory) argument -> exit 1" $?

VALID="$TMP/valid-workspace"
mkdir -p "$VALID/.claude/skills"
node "$ROOT/scripts/gen-catalog.mjs" --repo "$VALID" >/dev/null 2>&1
OUT=$(node "$CHECK" "$VALID" 2>&1)
[ "$?" -eq 0 ] && [ "$OUT" = "true" ]
report "freshly-generated INDEX.md matches -> exit 0, prints true" $?

STALE="$TMP/stale-workspace"
mkdir -p "$STALE/.claude/skills"
node "$ROOT/scripts/gen-catalog.mjs" --repo "$STALE" >/dev/null 2>&1
printf '# stale content\n' > "$STALE/.claude/skills/INDEX.md"
OUT_STALE=$(node "$CHECK" "$STALE" 2>&1)
[ "$?" -eq 0 ] && [ "$OUT_STALE" = "false" ]
report "hand-edited stale INDEX.md does not match -> exit 0, prints false" $?

echo "check-catalog-fresh.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
