#!/bin/sh
# Compatibility boundary. Policy scripts call this before evaluating an event.
set -u

EVENT=${1:-}
INPUT=$(cat 2>/dev/null || true)
[ -n "$EVENT" ] || exit 3

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if command -v jq >/dev/null 2>&1 &&
   printf '%s' "$INPUT" | jq -e '.protocol_version == "1.0"' >/dev/null 2>&1; then
  printf '%s' "$INPUT" | "$SCRIPT_DIR/validate-event.sh"
  exit $?
fi

# v0 compatibility: direct Claude-shaped payloads only. New configs call the
# adapter explicitly. Empty objects were historically a no-op and remain one.
if [ "$EVENT" != "stop" ] && { [ -z "$INPUT" ] || [ "$INPUT" = "{}" ]; }; then
  exit 4
fi

printf '%s' "$INPUT" | "$SCRIPT_DIR/../adapters/claude-code/normalize.sh" "$EVENT"
