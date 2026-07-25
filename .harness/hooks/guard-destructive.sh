#!/bin/sh
# Portable pre_command policy. Exit 0 allow, 2 policy block, 3 evaluation failure.
set -u

[ "${HARNESS_ALLOW_DESTRUCTIVE:-0}" = "1" ] && exit 0

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INPUT=$(cat 2>/dev/null || true)
EVENT=$(printf '%s' "$INPUT" | "$SCRIPT_DIR/prepare-event.sh" pre_command)
STATUS=$?
[ "$STATUS" -eq 4 ] && exit 0
[ "$STATUS" -eq 0 ] || exit 3

command -v jq >/dev/null 2>&1 || exit 3
CMD=$(printf '%s' "$EVENT" | jq -r '.command') || exit 3
[ -n "$CMD" ] || exit 3
PROTECTED_BRANCHES=${HARNESS_PROTECTED_BRANCHES:-main|master|production|release}

block() {
  {
    echo "BLOCKED by guard-destructive: $1"
    echo "Command: $CMD"
    echo "$2"
  } >&2
  exit 2
}

if printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])rm[[:space:]]+(-[a-zA-Z]*[rR][a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*[rR][a-zA-Z]*)[[:space:]]'; then
  if printf '%s' "$CMD" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*[[:space:]]+(--[[:space:]]+)?("?/([^/]|$)|"?~|\$HOME|\.\.)'; then
    block "recursive force-delete outside the repository" \
      "rm -rf against /, ~, \$HOME, or .. requires explicit human approval."
  fi
fi

if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+push[^;|&]*(--force([[:space:]]|$)|(^|[[:space:]])-f([[:space:]]|$))'; then
  block "plain force-push" \
    "Plain --force/-f is conservatively blocked for every branch. Use --force-with-lease or explicit approval."
fi

if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+(reset[[:space:]]+--hard|branch[[:space:]]+-D)[^;|&]*' &&
   printf '%s' "$CMD" | grep -qE "(${PROTECTED_BRANCHES})"; then
  block "hard reset / delete on a protected branch" \
    "This discards commits on a shared branch. Get explicit approval."
fi

if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+(filter-branch|filter-repo|reflog[[:space:]]+expire[^;|&]*--expire=now)'; then
  block "git history rewrite" "History rewrites are unrecoverable for collaborators. Get explicit approval."
fi

if printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:]])(mkfs(\.[a-z0-9]+)?|dd[[:space:]]+[^;|&]*of=/dev/|shred[[:space:]]|diskutil[[:space:]]+erase)'; then
  block "disk-level destructive operation" "Device-level writes require a human at the keyboard."
fi

if printf '%s' "$CMD" | grep -qiE '(DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)|TRUNCATE[[:space:]]+TABLE)' &&
   printf '%s' "$CMD" | grep -qE '(psql|mysql|sqlite3|mongosh)'; then
  block "destructive SQL against a live database" \
    "DROP/TRUNCATE through a DB CLI requires explicit approval."
fi

exit 0
