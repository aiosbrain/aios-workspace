#!/usr/bin/env bash
# hooks/scan-tree-secrets.test.sh — self-test for scan-tree-secrets.sh.
#
# The synthetic secret is assembled AT RUNTIME (string concatenation) so this file
# never contains a literal secret-shaped string for our own scanner (or anyone
# else's) to trip over.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCANNER="$ROOT/hooks/scan-tree-secrets.sh"
PASS=0
FAIL=0

report() {
  local name="$1" status="$2"
  if [ "$status" -eq 0 ]; then
    PASS=$((PASS+1)); echo "PASS: $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $name"
  fi
}

# Runtime-assembled fixture — never a literal secret-shaped string in this file.
AWS_KEY="AKIA""ABCDEFGHIJKLMNOP"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" config user.email test@example.invalid
git -C "$TMP" config user.name "scan-tree-secrets self-test"
printf 'clean file, no secrets here\n' > "$TMP/clean.txt"
git -C "$TMP" add clean.txt
git -C "$TMP" commit -qm init

"$SCANNER" "$TMP" >/dev/null 2>&1
report "clean tree scans clean" $?

printf 'key = %s\n' "$AWS_KEY" > "$TMP/secret.txt"
git -C "$TMP" add secret.txt
git -C "$TMP" commit -qm "add secret"

"$SCANNER" "$TMP" >/dev/null 2>&1
DIRTY_STATUS=$?
if [ "$DIRTY_STATUS" -ne 0 ]; then
  PASS=$((PASS+1)); echo "PASS: tree with a committed secret fails the scan"
else
  FAIL=$((FAIL+1)); echo "FAIL: tree with a committed secret should not scan clean"
fi

# An untracked (not `git add`ed) secret file must not be scanned — scan-tree-secrets
# only walks `git ls-files` (tracked content), matching the CI contract of scanning
# what's actually going to be committed/merged.
rm "$TMP/secret.txt"
git -C "$TMP" add -A
git -C "$TMP" commit -qm "remove secret"
printf 'key = %s\n' "$AWS_KEY" > "$TMP/untracked-secret.txt"
"$SCANNER" "$TMP" >/dev/null 2>&1
report "untracked secret file is ignored (tracked-only scan)" $?
rm -f "$TMP/untracked-secret.txt"

# The patterns file itself is allowlisted (its lines are literally the regexes).
mkdir -p "$TMP/hooks"
cp "$ROOT/hooks/secret-patterns.txt" "$TMP/hooks/secret-patterns.txt"
git -C "$TMP" add hooks/secret-patterns.txt
git -C "$TMP" commit -qm "add patterns file"
"$SCANNER" "$TMP" >/dev/null 2>&1
report "patterns file itself is allowlisted" $?

# Fixtures under evals/fixtures/ are allowlisted.
mkdir -p "$TMP/evals/fixtures"
printf 'key = %s\n' "$AWS_KEY" > "$TMP/evals/fixtures/example.json"
git -C "$TMP" add evals/fixtures/example.json
git -C "$TMP" commit -qm "add fixture"
"$SCANNER" "$TMP" >/dev/null 2>&1
report "evals/fixtures/ content is allowlisted" $?

# Missing patterns file at the scanner's own repo root is a hard setup error, not a
# silent pass — exercised via a bogus HARNESS root would require re-invoking the
# script from elsewhere, which isn't worth the indirection here; covered instead by
# code review of the guard clause in scan-tree-secrets.sh.

echo "scan-tree-secrets.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
