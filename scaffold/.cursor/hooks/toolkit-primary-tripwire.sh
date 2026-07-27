#!/bin/sh
# Session-stop tripwire: if the agent dirtied the toolkit PRIMARY checkout, force
# a follow-up turn to revert or move changes into a worktree. Cursor stop hooks
# continue via {"followup_message": "..."} on stdout (always exit 0).
set -u

WS=${CURSOR_PROJECT_DIR:-${PWD:-.}}

command -v jq >/dev/null 2>&1 || { printf '{}\n'; exit 0; }

INPUT=$(cat 2>/dev/null || true)
NATIVE_STATUS=$(printf '%s' "$INPUT" | jq -r '.status // ""' 2>/dev/null || true)
case "$NATIVE_STATUS" in
  aborted|error) printf '{}\n'; exit 0 ;;
esac

resolve_toolkit_root() {
  if [ -n "${AIOS_TOOLKIT_DIR:-}" ]; then
    _r=$(cd "$AIOS_TOOLKIT_DIR" 2>/dev/null && pwd -P) || return 1
    git -C "$_r" rev-parse --git-dir >/dev/null 2>&1 || return 1
    printf '%s' "$_r"
    return 0
  fi
  for rel in "../aios/aios-workspace" "../aios-workspace" "../../aios-workspace"; do
    _c=$(cd "$WS/$rel" 2>/dev/null && pwd -P) || continue
    [ -f "$_c/scripts/aios.mjs" ] && { printf '%s' "$_c"; return 0; }
  done
  return 1
}

TOOLKIT=$(resolve_toolkit_root) || { printf '{}\n'; exit 0; }

_git_dir=$(git -C "$TOOLKIT" rev-parse --absolute-git-dir 2>/dev/null) || { printf '{}\n'; exit 0; }
_common=$(git -C "$TOOLKIT" rev-parse --git-common-dir 2>/dev/null) || { printf '{}\n'; exit 0; }
case "$_common" in
  /*) _common=$(cd "$_common" 2>/dev/null && pwd -P) ;;
  *)  _common=$(cd "$TOOLKIT" 2>/dev/null && cd "$_common" 2>/dev/null && pwd -P) ;;
esac
[ "$_git_dir" = "$_common" ] || { printf '{}\n'; exit 0; }

DIRTY=$(git -C "$TOOLKIT" status --porcelain 2>/dev/null | head -20)
[ -n "$DIRTY" ] || { printf '{}\n'; exit 0; }

BRANCH=$(git -C "$TOOLKIT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
MSG=$(cat <<EOF
TRIPWIRE: toolkit PRIMARY checkout has uncommitted changes (branch $BRANCH):

$DIRTY

Revert these changes in the primary checkout OR move them into a linked worktree before stopping:
  cd $TOOLKIT && aios worktree add feat/<name>
Then cherry-pick / re-apply only the intended toolkit edits there.
EOF
)

printf '%s' "$MSG" | jq -Rs '{followup_message: .}'
exit 0
