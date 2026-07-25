#!/bin/sh
# Cursor `stop` hook wrapper.
#
# Cursor's stop hook does not block via exit code — it continues the agent when the
# hook returns {"followup_message": "..."} on stdout, bounded by the hooks.json
# `loop_limit`. run-hook.sh's stop channel already translates the portable
# `continue` action to that shape for cursor; this wrapper adds the native
# aborted/error early-out (never continue a killed/errored session) and guarantees
# valid JSON on stdout in every path. Always exits 0.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INPUT=$(cat 2>/dev/null || true)

command -v jq >/dev/null 2>&1 || {
  echo "cursor stop gate: jq not found" >&2
  printf '{}\n'
  exit 0
}

NATIVE_STATUS=$(printf '%s' "$INPUT" | jq -r '.status // ""' 2>/dev/null || true)
case "$NATIVE_STATUS" in
  aborted|error)
    printf '{}\n'
    exit 0
    ;;
esac

ERRFILE=$(mktemp) || { printf '{}\n'; exit 0; }
trap 'rm -f "$ERRFILE"' EXIT
OUT=$(printf '%s' "$INPUT" | "$SCRIPT_DIR/../run-hook.sh" cursor stop stop-verify-gate.sh 2>"$ERRFILE")
STATUS=$?
ERRORS=$(cat "$ERRFILE" 2>/dev/null || true)
[ -z "$ERRORS" ] || printf '%s\n' "$ERRORS" >&2

if [ -n "$OUT" ] && printf '%s' "$OUT" | jq -e '.followup_message | type == "string"' >/dev/null 2>&1; then
  printf '%s\n' "$OUT"
elif [ "$STATUS" -eq 2 ]; then
  # Legacy/could-not-evaluate path: wrap the stderr reason as the continuation.
  [ -n "$ERRORS" ] || ERRORS="Repository verification gate failed; resolve it before stopping."
  printf '%s' "$ERRORS" | jq -Rs '{followup_message: .}'
else
  printf '{}\n'
fi
exit 0
