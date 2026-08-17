#!/usr/bin/env bash
# clean-container-check.sh — acceptance test for the PUBLISHED artifact in a bare container.
#
# Run inside a plain `node:22`-style image with the packed tarball mounted at /pack. It
# installs globally, scaffolds all three contexts, validates each, and — the part that
# matters — proves the shipped PreToolUse guard does not silently allow a secret.
#
# This exists because the 0.11.0 defect class (undeclared `jq`, before it the OGR09 skill
# library path and `ajv`) is invisible everywhere the maintainers look: macOS ships
# /usr/bin/jq and GitHub's runner image pre-installs it. A bare container is the only place
# the missing dependency shows up. If this script fails, install the missing dependency in
# the PRODUCT or gate it in the code — never in this script.
#
# Usage: bash clean-container-check.sh          # exercises whatever is (not) on PATH
set -euo pipefail

section() { printf '\n=== %s ===\n' "$1"; }
FAILED=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILED=$((FAILED + 1))
}
pass() { printf 'ok: %s\n' "$1"; }

section "environment"
node --version
npm --version
if command -v jq >/dev/null 2>&1; then
  JQ_PRESENT=yes
  echo "jq: $(command -v jq) ($(jq --version))"
else
  JQ_PRESENT=no
  echo "jq: ABSENT  <- the condition that broke 0.11.0"
fi

section "global install"
TARBALL=$(find /pack -maxdepth 1 -name '*.tgz' -print | sort | head -1)
test -n "$TARBALL" || {
  echo "no tarball mounted at /pack — run 'npm pack --pack-destination <dir>' and mount it" >&2
  exit 1
}
echo "installing $TARBALL"
npm install -g "$TARBALL" >/dev/null
aios --version
TOOLKIT=$(npm root -g)/@aiosbrain/aios
echo "toolkit: $TOOLKIT"

# ── 1. Scaffold all three contexts, and validate each via the new subcommand ──────────
for CTX in consultant employee business-owner; do
  section "context: $CTX"
  WS="/root/ws-$CTX"
  rm -rf "$WS"
  bash "$TOOLKIT/scripts/scaffold-project.sh" \
    --context "$CTX" --slug "ws-$CTX" --owner tester --org test-org \
    --output "$WS" </dev/null >/dev/null
  pass "scaffolded $CTX"

  # `aios validate` must work from INSIDE the workspace — the workspace has no
  # validation/validate-all.sh of its own, which is the whole reason the command exists.
  test ! -f "$WS/validation/validate-all.sh" ||
    fail "$CTX: workspace unexpectedly ships validate-all.sh (assumption changed)"

  if (cd "$WS" && aios validate); then
    pass "$CTX: aios validate exit 0"
  else
    fail "$CTX: aios validate exited $? (expected 0)"
  fi
done

# ── 2. The shipped guard must never silently allow a secret ───────────────────────────
section "shipped guard: secret write"
HOOK="/root/ws-consultant/hooks/team-ops-guard.sh"
test -x "$HOOK" || fail "guard hook missing or not executable at $HOOK"

# Split so this file never carries a scannable key literal.
KEY="AKIA""IOSFODNN7EXAMPLE"
EVENT="{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"notes.md\",\"content\":\"k=$KEY\"}}"

set +e
GUARD_ERR=$(printf '%s' "$EVENT" | bash "$HOOK" 2>&1 >/dev/null)
GUARD_CODE=$?
set -e
echo "guard exit=$GUARD_CODE"
printf '%s\n' "$GUARD_ERR"

if [ "$GUARD_CODE" -eq 0 ]; then
  fail "the guard ALLOWED a secret (exit 0) — this is the 0.11.0 silent fail-open"
elif [ "$GUARD_CODE" -eq 2 ]; then
  case "$GUARD_ERR" in
    *"Potential secret detected"*) pass "guard blocked the secret (exit 2, named the pattern)" ;;
    *) fail "guard exited 2 but did not say a secret was detected" ;;
  esac
else
  fail "guard exited $GUARD_CODE — a block must be exit 2 (Claude Code's deny signal)"
fi

# Whatever the verdict, it must never be silent.
if [ -z "$(printf '%s' "$GUARD_ERR" | tr -d '[:space:]')" ]; then
  fail "the guard produced NO output — silence is the defect, independent of the exit code"
else
  pass "guard produced a diagnostic"
fi

section "shipped guard: clean write still allowed"
CLEAN='{"tool_name":"Write","tool_input":{"file_path":"notes.md","content":"hello world"}}'
if printf '%s' "$CLEAN" | bash "$HOOK"; then
  pass "clean write allowed (exit 0)"
else
  fail "a clean write was blocked (exit $?) — the guard is now too strict"
fi

section "summary"
echo "jq present: $JQ_PRESENT"
if [ "$FAILED" -eq 0 ]; then
  echo "ALL CHECKS PASSED"
  exit 0
fi
echo "$FAILED check(s) failed"
exit 1
