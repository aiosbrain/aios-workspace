#!/bin/sh
# Portable pre_edit policy. Input is protocol 1.0 JSON; direct Claude payloads are
# accepted temporarily through prepare-event.sh.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INPUT=$(cat 2>/dev/null || true)
EVENT=$(printf '%s' "$INPUT" | "$SCRIPT_DIR/prepare-event.sh" pre_edit)
STATUS=$?
[ "$STATUS" -eq 4 ] && exit 0
[ "$STATUS" -eq 0 ] || exit 3

command -v jq >/dev/null 2>&1 || exit 3
CONTENT=$(printf '%s' "$EVENT" | jq -r '.added_content[].content') || exit 3
[ -n "$CONTENT" ] || exit 0
FILE_PATHS=$(printf '%s' "$EVENT" | jq -r '[.added_content[].path] | unique | join(",")') || exit 3

PATTERNS_FILE="$SCRIPT_DIR/secret-patterns.txt"
if [ -f "$PATTERNS_FILE" ]; then
  while IFS= read -r pattern || [ -n "$pattern" ]; do
    [ -n "$pattern" ] || continue
    case "$pattern" in \#*) continue ;; esac
    if printf '%s' "$CONTENT" | grep -qE -- "$pattern" 2>/dev/null; then
      {
        echo "BLOCKED by guard-secrets: potential secret detected in ${FILE_PATHS:-<unknown>}"
        echo "Pattern matched: $pattern"
        echo "Remove the secret (use an env var / secret manager reference) before writing."
      } >&2
      exit 2
    fi
  done < "$PATTERNS_FILE"
else
  echo "guard-secrets: missing secret-patterns.txt" >&2
  exit 3
fi

exit 0
