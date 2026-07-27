#!/bin/sh
# Cross-repo toolkit primary guard for IC workspaces (e.g. john-workspace).
#
# Cursor opened on a personal workstation must never mutate the toolkit PRIMARY
# checkout — feature work belongs in a linked worktree under *-worktrees/.
# This is deterministic enforcement at the tool boundary (not prompt/memory).
#
# Usage (from .cursor/hooks.json):
#   guard-toolkit-primary.sh pre_edit    <- preToolUse (Write|Edit|…)
#   guard-toolkit-primary.sh pre_command <- beforeShellExecution
#
# Exit: 0 allow, 2 block (Cursor deny), 3 evaluation failure (failClosed -> deny).
set -u

MODE=${1:-}
WS=${CURSOR_PROJECT_DIR:-${PWD:-.}}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

[ "${HARNESS_ALLOW_PRIMARY_CHECKOUT:-0}" = "1" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 3

resolve_toolkit_root() {
  if [ -n "${AIOS_TOOLKIT_DIR:-}" ]; then
    _r=$(cd "$AIOS_TOOLKIT_DIR" 2>/dev/null && pwd -P) || return 1
    if [ -d "$_r/.git" ] || git -C "$_r" rev-parse --git-dir >/dev/null 2>&1; then
      printf '%s' "$_r"
      return 0
    fi
  fi
  for rel in "../aios/aios-workspace" "../aios-workspace" "../../aios-workspace"; do
    _c=$(cd "$WS/$rel" 2>/dev/null && pwd -P) || continue
    if [ -f "$_c/scripts/aios.mjs" ]; then
      printf '%s' "$_c"
      return 0
    fi
  done
  return 1
}

TOOLKIT=$(resolve_toolkit_root) || exit 0
HARNESS="$TOOLKIT/.harness"
EXEMPT_BASENAMES=${HARNESS_PRIMARY_EXEMPT:-aios.yaml}

if [ ! -f "$HARNESS/adapters/cursor/normalize.sh" ] || [ ! -f "$HARNESS/hooks/guard-worktree.sh" ]; then
  echo "BLOCKED by guard-toolkit-primary: toolkit harness missing at $HARNESS" >&2
  echo "Fix: clone aios-workspace or set AIOS_TOOLKIT_DIR to a checkout with .harness/." >&2
  exit 2
fi

case "$MODE" in
  pre_command|pre_edit) ;;
  *) echo "guard-toolkit-primary: unsupported mode '$MODE'" >&2; exit 3 ;;
esac

INPUT=$(cat 2>/dev/null || true)
NORMALIZED=$(printf '%s' "$INPUT" | "$HARNESS/adapters/cursor/normalize.sh" "$MODE") || exit 2

# probe <dir> -> "primary <branch>" | "worktree <branch>" | "none"
probe() {
  _d=$1
  _gd=$(git -C "$_d" rev-parse --absolute-git-dir 2>/dev/null) || { echo none; return; }
  _gd=$(cd "$_gd" 2>/dev/null && pwd -P) || { echo none; return; }
  _cd=$(git -C "$_d" rev-parse --git-common-dir 2>/dev/null) || { echo none; return; }
  case "$_cd" in
    /*) _cd=$(cd "$_cd" 2>/dev/null && pwd -P) ;;
    *)  _cd=$(cd "$_d" 2>/dev/null && cd "$_cd" 2>/dev/null && pwd -P) ;;
  esac
  [ -n "$_cd" ] || { echo none; return; }
  _br=$(git -C "$_d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
  if [ "$_gd" = "$_cd" ]; then echo "primary $_br"; else echo "worktree $_br"; fi
}

path_under_toolkit() {
  _p=$1
  case "$_p" in
    "$TOOLKIT"/*) return 0 ;;
    "$TOOLKIT") return 0 ;;
    *) return 1 ;;
  esac
}

block() {
  _reason=$1
  _detail=$2
  {
    echo "BLOCKED by guard-toolkit-primary: $_reason"
    echo "$_detail"
    echo ""
    echo "The toolkit PRIMARY checkout is read-only for agents. All toolkit code changes"
    echo "must happen in a dedicated linked worktree, never in:"
    echo "  $TOOLKIT"
    echo ""
    echo "Fix:"
    echo "  cd $TOOLKIT && aios worktree add feat/<short-name>"
    echo "  # then edit under ../$(basename "$TOOLKIT")-worktrees/feat-<short-name>/"
    echo ""
    echo "Override (genuine primary hotfix only): HARNESS_ALLOW_PRIMARY_CHECKOUT=1"
  } >&2
  exit 2
}

# ── pre_command: delegate git discipline to guard-worktree when target is toolkit primary
if [ "$MODE" = "pre_command" ]; then
  CWD=$(printf '%s' "$NORMALIZED" | jq -r '.cwd // empty')
  [ -n "$CWD" ] || CWD="$WS"
  CMD=$(printf '%s' "$NORMALIZED" | jq -r '.command // empty')
  [ -n "$CMD" ] || exit 0

  # Reuse guard-worktree's target_dir via a minimal inline copy (keep in sync with harness).
  target_dir() {
    _cmd=$1; _fb=$2
    _t=$(printf '%s' "$_cmd" | sed -nE "s/.*(^|[^[:alnum:]_])git[[:space:]]+-C(=|[[:space:]]+)('[^']*'|\"[^\"]*\"|[^[:space:];&|]+).*/\3/p" | head -1)
    if [ -z "$_t" ]; then
      _t=$(printf '%s' "$_cmd" | sed -nE "s/^[[:space:]]*(cd|pushd)[[:space:]]+(--[[:space:]]+)?('[^']*'|\"[^\"]*\"|[^[:space:];&|]+)[[:space:]]*(&&|;).*/\3/p" | head -1)
    fi
    [ -n "$_t" ] || { printf '%s' "$_fb"; return; }
    _t=$(printf '%s' "$_t" | sed "s/^['\"]//; s/['\"]\$//")
    case "$_t" in
      /*)    printf '%s' "$_t" ;;
      "~")   printf '%s' "$HOME" ;;
      "~/"*) printf '%s/%s' "$HOME" "${_t#~/}" ;;
      *)     printf '%s' "$_fb/$_t" ;;
    esac
  }

  TDIR=$(target_dir "$CMD" "$CWD")
  [ -d "$TDIR" ] || TDIR="$CWD"
  path_under_toolkit "$TDIR" || exit 0
  set -- $(probe "$TDIR"); KIND=${1:-none}
  [ "$KIND" = "primary" ] || exit 0

  printf '%s' "$NORMALIZED" | HARNESS_PRIMARY_COMMIT_POLICY=strict "$HARNESS/hooks/guard-worktree.sh"
  exit $?
fi

# ── pre_edit: block EVERY write into the toolkit primary checkout (including main)
CWD=$(printf '%s' "$NORMALIZED" | jq -r '.cwd // empty')
[ -n "$CWD" ] || CWD="$WS"

FILE_PATHS=$(printf '%s' "$NORMALIZED" | jq -r '.paths[]? | .path, (.from // empty)' | awk 'NF && !seen[$0]++') || exit 3
[ -n "$FILE_PATHS" ] || exit 0

while IFS= read -r p || [ -n "$p" ]; do
  [ -n "$p" ] || continue
  case "$p" in
    /*) _abs="$p" ;;
    *)  _abs="$CWD/$p" ;;
  esac
  _abs=$(cd "$(dirname "$_abs")" 2>/dev/null && pwd -P)/$(basename "$_abs") 2>/dev/null || _abs="$p"
  path_under_toolkit "$_abs" || continue
  pdir=$(dirname "$_abs")
  set -- $(probe "$pdir"); KIND=${1:-none}; BRANCH=${2:-}
  [ "$KIND" = "primary" ] || continue
  base=$(basename "$_abs")
  for e in $EXEMPT_BASENAMES; do
    [ "$base" = "$e" ] && continue 2
  done
  block "editing toolkit primary checkout (branch '$BRANCH')" \
    "Attempted path: $_abs"
done <<EOF
$FILE_PATHS
EOF

exit 0
