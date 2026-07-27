#!/bin/sh
set -u

TRACE_FILE=${HARNESS_TRACE_FILE:-}
[ -n "$TRACE_FILE" ] || exit 0

TRACE_PARENT=$(dirname -- "$TRACE_FILE")
[ -d "$TRACE_PARENT" ] || {
  echo "trace-event: parent directory does not exist: $TRACE_PARENT" >&2
  exit 3
}
CANON_PARENT=$(CDPATH='' cd -P -- "$TRACE_PARENT" 2>/dev/null && pwd -P) || exit 3
case "$CANON_PARENT/" in
  */scratch/|*/scratch/*|*/results/|*/results/*) ;;
  *)
    echo "trace-event: HARNESS_TRACE_FILE must be under scratch/ or results/" >&2
    exit 3
    ;;
esac

command -v jq >/dev/null 2>&1 || exit 3
TRACE_FILE="$CANON_PARENT/$(basename -- "$TRACE_FILE")"
[ ! -L "$TRACE_FILE" ] || {
  echo "trace-event: refusing symlink trace target: $TRACE_FILE" >&2
  exit 3
}

POLICY=${1:-unknown}
OUTCOME=${2:-3}
INPUT=$(cat 2>/dev/null || true)
printf '%s' "$INPUT" | jq -c --arg policy "$POLICY" --argjson outcome "$OUTCOME" \
  '. + {trace:{policy:$policy,outcome:$outcome}}' >> "$TRACE_FILE" || exit 3
