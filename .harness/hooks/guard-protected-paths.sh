#!/bin/sh
# Portable pre_edit path policy. Runtime-specific extraction belongs to adapters.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INPUT=$(cat 2>/dev/null || true)
EVENT=$(printf '%s' "$INPUT" | "$SCRIPT_DIR/prepare-event.sh" pre_edit)
STATUS=$?
[ "$STATUS" -eq 4 ] && exit 0
[ "$STATUS" -eq 0 ] || exit 3

command -v jq >/dev/null 2>&1 || exit 3
CWD=$(printf '%s' "$EVENT" | jq -r '.cwd') || exit 3
FILE_PATHS=$(printf '%s' "$EVENT" | jq -r '.paths[] | .path, (.from // empty)' | awk 'NF && !seen[$0]++') || exit 3
[ -n "$FILE_PATHS" ] || exit 3

REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$CWD")
REPO_LIST="$REPO_ROOT/.harness/protected-paths.txt"
DEFAULT_LIST="$SCRIPT_DIR/protected-paths.txt"
LIST_FILE="$DEFAULT_LIST"
[ -f "$REPO_LIST" ] && LIST_FILE="$REPO_LIST"
[ -f "$LIST_FILE" ] || {
  echo "guard-protected-paths: missing protected path configuration" >&2
  exit 3
}

while IFS= read -r FILE_PATH || [ -n "$FILE_PATH" ]; do
  [ -n "$FILE_PATH" ] || continue
  while IFS= read -r pattern || [ -n "$pattern" ]; do
    [ -n "$pattern" ] || continue
    case "$pattern" in \#*) continue ;; esac
    if printf '%s' "$FILE_PATH" | grep -qE "$pattern" 2>/dev/null; then
      {
        echo "BLOCKED by guard-protected-paths: $FILE_PATH matches protected pattern '$pattern'"
        echo "This path only changes through a deliberate human action or its dedicated tool."
        echo "Ask the human, or update $LIST_FILE if this protection is wrong for the repo."
      } >&2
      exit 2
    fi
  done < "$LIST_FILE"
done <<EOF
$FILE_PATHS
EOF

exit 0
