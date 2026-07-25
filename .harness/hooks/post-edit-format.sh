#!/bin/sh
# Portable post_edit policy. Formatting is best-effort and never blocks.
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INPUT=$(cat 2>/dev/null || true)
EVENT=$(printf '%s' "$INPUT" | "$SCRIPT_DIR/prepare-event.sh" post_edit)
STATUS=$?
[ "$STATUS" -eq 4 ] && exit 0
[ "$STATUS" -eq 0 ] || exit 3
command -v jq >/dev/null 2>&1 || exit 3

CWD=$(printf '%s' "$EVENT" | jq -r '.cwd') || exit 3
REPO_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$CWD")
FILE_PATHS=$(printf '%s' "$EVENT" | jq -r '.paths[] | select(.action != "delete") | .path' | awk 'NF && !seen[$0]++') || exit 3
[ -n "$FILE_PATHS" ] || exit 0

while IFS= read -r FILE_PATH || [ -n "$FILE_PATH" ]; do
  [ -n "$FILE_PATH" ] || continue
  case "$FILE_PATH" in /*) ABS_PATH=$FILE_PATH ;; *) ABS_PATH="$CWD/$FILE_PATH" ;; esac
  [ -f "$ABS_PATH" ] || continue
  case "$ABS_PATH" in
    *.js|*.jsx|*.ts|*.tsx|*.mjs|*.cjs|*.json|*.css|*.scss|*.md|*.html|*.vue|*.svelte|*.yaml|*.yml)
      if [ -x "$REPO_ROOT/node_modules/.bin/prettier" ]; then
        "$REPO_ROOT/node_modules/.bin/prettier" --write "$ABS_PATH" >/dev/null 2>&1 || true
      elif command -v prettier >/dev/null 2>&1; then
        prettier --write "$ABS_PATH" >/dev/null 2>&1 || true
      fi
      ;;
    *.py)
      if command -v ruff >/dev/null 2>&1; then ruff format "$ABS_PATH" >/dev/null 2>&1 || true
      elif command -v black >/dev/null 2>&1; then black -q "$ABS_PATH" >/dev/null 2>&1 || true
      fi
      ;;
    *.php)
      if [ -x "$REPO_ROOT/vendor/bin/pint" ]; then "$REPO_ROOT/vendor/bin/pint" "$ABS_PATH" >/dev/null 2>&1 || true
      elif [ -x "$REPO_ROOT/vendor/bin/php-cs-fixer" ]; then "$REPO_ROOT/vendor/bin/php-cs-fixer" fix "$ABS_PATH" >/dev/null 2>&1 || true
      fi
      ;;
    *.go) command -v gofmt >/dev/null 2>&1 && gofmt -w "$ABS_PATH" >/dev/null 2>&1 || true ;;
    *.rs) command -v rustfmt >/dev/null 2>&1 && rustfmt "$ABS_PATH" >/dev/null 2>&1 || true ;;
  esac
done <<EOF
$FILE_PATHS
EOF

exit 0
