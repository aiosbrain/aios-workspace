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

# Resolution failure is treated two different ways on purpose:
#   AIOS_TOOLKIT_DIR set but unresolvable -> MISCONFIGURATION, fail closed. Someone
#     declared a toolkit; a broken pointer must not silently drop the guard.
#   nothing declared and no sibling found -> there is no toolkit checkout on this
#     machine to protect, so allow. Failing closed here would block every command
#     in every IC workspace that legitimately has no toolkit clone.
# Note this guard is not an adversary-proof boundary: an agent that can relocate
# the toolkit checkout can also defeat discovery. The authoritative backstops are
# the tracked pre-commit primary guard inside the toolkit repo and, for the
# product repo, its own .cursor/hooks.json harness wiring.
if ! TOOLKIT=$(resolve_toolkit_root); then
  if [ -n "${AIOS_TOOLKIT_DIR:-}" ]; then
    echo "BLOCKED by guard-toolkit-primary: AIOS_TOOLKIT_DIR is set to '$AIOS_TOOLKIT_DIR' but does not resolve to a git checkout." >&2
    echo "Fix: point AIOS_TOOLKIT_DIR at a real aios-workspace checkout, or unset it if this machine has no toolkit clone." >&2
    exit 2
  fi
  exit 0
fi
HARNESS="$TOOLKIT/.harness"
EXEMPT_BASENAMES=${HARNESS_PRIMARY_EXEMPT:-aios.yaml}

# canon <path> -> physical path. Resolves (a) an existing symlink LEAF (a link
# inside the workspace pointing into the toolkit must not mask its target),
# then (b) symlinks in the deepest EXISTING ancestor, walking up past
# not-yet-created components (mkdir -p / redirects may create several levels).
# Falls back to the raw path only when nothing along it exists.
canon() {
  _cp=$1
  _n=0
  while [ -L "$_cp" ] && [ "$_n" -lt 8 ]; do
    _lt=$(readlink "$_cp" 2>/dev/null) || break
    case "$_lt" in
      /*) _cp=$_lt ;;
      *)  _cp=$(dirname -- "$_cp")/$_lt ;;
    esac
    _n=$((_n+1))
  done
  if [ -d "$_cp" ]; then
    (CDPATH= cd -- "$_cp" 2>/dev/null && pwd -P) || printf '%s' "$_cp"
    return
  fi
  _cdir=$(dirname -- "$_cp")
  _cbase=$(basename -- "$_cp")
  while [ ! -d "$_cdir" ] && [ "$_cdir" != "/" ] && [ "$_cdir" != "." ]; do
    _cbase=$(basename -- "$_cdir")/$_cbase
    _cdir=$(dirname -- "$_cdir")
  done
  _cres=$(CDPATH= cd -- "$_cdir" 2>/dev/null && pwd -P) || { printf '%s' "$_cp"; return; }
  printf '%s/%s' "$_cres" "$_cbase"
}

path_under_toolkit() {
  _p=$(canon "$1")
  case "$_p" in
    "$TOOLKIT"/*) return 0 ;;
    "$TOOLKIT") return 0 ;;
    *) return 1 ;;
  esac
}

# target_dir <command> <fallback> -> the dir a command operates in, honoring
# `git -C <dir>` then a leading `cd <dir> &&` / `pushd <dir> &&`. Kept as a
# minimal inline copy of guard-worktree.sh's target_dir (keep in sync).
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

# scan_paths_touch_toolkit <scan> <cwd> <tdir> -> 0 if any path-like token in
# the command resolves under the toolkit (relative tokens are resolved against
# BOTH the session cwd and the command's cd/-C target). This keeps the
# pre_command fast path honest: a relative `../aios-workspace/...` reference
# must reach the full guard even though the absolute toolkit path never
# appears in the command text.
scan_paths_touch_toolkit() {
  _sc=$1; _b1=$2; _b2=$3
  for _tk in $(printf '%s\n' "$_sc" | tr ';|&(){}<>' ' ' | tr ' \t' '\n\n' | awk 'NF && $0 !~ /^-/' | sed "s/^['\"]//; s/['\"]\$//" | awk 'NF && !seen[$0]++'); do
    case "$_tk" in *=/*|*=../*|*=~/*) _tk=${_tk#*=} ;; esac
    case "$_tk" in
      "~") _tk=$HOME ;;
      "~/"*) _tk=$HOME/${_tk#\~/} ;;
    esac
    case "$_tk" in
      */*|..) ;;
      *) continue ;;
    esac
    case "$_tk" in
      /*) path_under_toolkit "$_tk" && return 0 ;;
      *)
        path_under_toolkit "$_b1/$_tk" && return 0
        [ "$_b2" = "$_b1" ] || { path_under_toolkit "$_b2/$_tk" && return 0; }
        ;;
    esac
  done
  return 1
}

case "$MODE" in
  pre_command|pre_edit) ;;
  *) echo "guard-toolkit-primary: unsupported mode '$MODE'" >&2; exit 3 ;;
esac

INPUT=$(cat 2>/dev/null || true)

# The hook is failClosed: an unparseable payload must deny (exit 3), never
# silently allow — otherwise a malformed event fails open past the guard.
printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1 || exit 3

# Fast path: if the pending event cannot possibly target the toolkit primary tree,
# do not require the harness (IC-local edits must never be blocked by a missing
# sibling checkout's .harness/).
touches_toolkit_primary() {
  _cwd=$1
  _raw=$2
  case "$_raw" in
    /*) _p=$_raw ;;
    *)  _p="$_cwd/$_raw" ;;
  esac
  path_under_toolkit "$(canon "$_p")"
}

RAWCWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || RAWCWD=""
case "$RAWCWD" in /*) ;; *) RAWCWD=$WS ;; esac

if [ "$MODE" = "pre_edit" ]; then
  _cwd=${RAWCWD}
  _any=0
  FILE_PATHS=$(printf '%s' "$INPUT" | jq -r '
    (.tool_input // {}) as $ti |
    [$ti.file_path, $ti.filePath, $ti.path, $ti.target_file, .file_path, .filePath] |
    map(select(type == "string" and length > 0)) | unique | .[]' 2>/dev/null) || exit 3
  if [ -n "$FILE_PATHS" ]; then
    while IFS= read -r _p || [ -n "$_p" ]; do
      [ -n "$_p" ] || continue
      if touches_toolkit_primary "$_cwd" "$_p"; then _any=1; break; fi
    done <<EOF
$FILE_PATHS
EOF
  fi
  [ "$_any" = "1" ] || exit 0
elif [ "$MODE" = "pre_command" ]; then
  _cmd=$(printf '%s' "$INPUT" | jq -r '.command // .tool_input.command // empty' 2>/dev/null) || exit 3
  [ -n "$_cmd" ] || exit 0
  _scan=$(printf '%s' "$_cmd" | sed "s|\${AIOS_TOOLKIT_DIR}|$TOOLKIT|g; s|\$AIOS_TOOLKIT_DIR|$TOOLKIT|g")
  # The absolute-path text match alone is bypassable: a command run FROM the
  # toolkit primary (pathless), a `cd ../aios-workspace && …`, or a relative
  # `../aios-workspace/<file>` token never contains the absolute toolkit path.
  # Check the session cwd, the command's cd/-C target, and every path-like
  # token before concluding the toolkit cannot be touched.
  _fasttd=$(target_dir "$_scan" "$RAWCWD")
  case "$_scan" in
    *"$TOOLKIT"*) ;;
    *)
      path_under_toolkit "$RAWCWD" || path_under_toolkit "$_fasttd" ||
        scan_paths_touch_toolkit "$_scan" "$RAWCWD" "$_fasttd" || exit 0
      ;;
  esac
fi

if [ ! -f "$HARNESS/adapters/cursor/normalize.sh" ] || [ ! -f "$HARNESS/hooks/guard-worktree.sh" ] || [ ! -f "$HARNESS/hooks/guard-destructive.sh" ]; then
  echo "BLOCKED by guard-toolkit-primary: toolkit harness missing at $HARNESS" >&2
  echo "Fix: clone aios-workspace or set AIOS_TOOLKIT_DIR to a checkout with .harness/." >&2
  exit 2
fi

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

  # Resolve the target dir from the SUBSTITUTED command so a
  # `cd $AIOS_TOOLKIT_DIR && …` classifies against the real toolkit path.
  SCAN=$(printf '%s' "$CMD" | sed "s|\${AIOS_TOOLKIT_DIR}|$TOOLKIT|g; s|\$AIOS_TOOLKIT_DIR|$TOOLKIT|g")
  TDIR=$(target_dir "$SCAN" "$CWD")
  [ -d "$TDIR" ] || TDIR="$CWD"
  TDIR=$(canon "$TDIR")

  # ── shell file mutations aimed at the toolkit primary (>, >>, cp, mv, rm, sed -i,
  # tee, curl -o, …). pre_edit blocks Write/Edit into the primary; this closes the
  # equivalent shell route. Runs BEFORE the git-discipline delegation so a primary
  # cwd/-C target cannot skip it (guard-worktree pre_command is git-only). Relative
  # candidates resolve against TDIR, so `cd <toolkit> && echo x > file` is caught.
  # Known limits (defense-in-depth, not the sole boundary — the pre-commit primary
  # guard and pre_edit hook remain authoritative): interpreter one-liners
  # (node -e / python -c), arbitrary command substitution, and variables other than
  # $AIOS_TOOLKIT_DIR are not evaluated.
  MUTATORS='rm|tee|truncate|ln|touch|mkdir|chmod|chown|dd|install|curl|wget'
  CANDIDATES=$(printf '%s' "$SCAN" | grep -oE '(^|[^>&])>>?[[:space:]]*[^&[:space:];|]+' | sed 's/^[^>]*>>*[[:space:]]*//')
  if printf '%s' "$SCAN" | grep -Eq '(^|[[:space:]&;|({])('"$MUTATORS"')[[:space:]]|sed[[:space:]]+(-[[:alnum:]]*i|--in-place)'; then
    CANDIDATES="$CANDIDATES
$(printf '%s\n' "$SCAN" | tr ';|&(){}<>' ' ' | tr ' \t' '\n\n' | awk 'NF' | grep -Evx "$MUTATORS|sed|cp|mv|rsync")"
  elif printf '%s' "$SCAN" | grep -Eq '(^|[[:space:]&;|({])(cp|mv|rsync)[[:space:]]'; then
    # Strip redirections BEFORE picking the last token as the destination —
    # otherwise `cp src <primary>/dst >/tmp/log` hides the real destination
    # behind the redirect target. (Redirect targets themselves are already
    # collected above from the unstripped command.)
    NORED=$(printf '%s' "$SCAN" | sed -E 's/[0-9]*>&[0-9]+//g; s/[0-9]*(>>?|<)[[:space:]]*[^&<>[:space:];|]+//g')
    CANDIDATES="$CANDIDATES
$(printf '%s\n' "$NORED" | tr ';|&(){}<>' ' ' | tr ' \t' '\n\n' | awk 'NF && $0 !~ /^-/' | tail -1)"
  fi
  if [ -n "$(printf '%s' "$CANDIDATES" | awk 'NF')" ]; then
    for tok in $(printf '%s\n' "$CANDIDATES" | sed "s/^['\"]//; s/['\"]\$//" | awk 'NF && !seen[$0]++'); do
      case "$tok" in -*) continue ;; *=/*) tok=${tok#*=} ;; esac
      case "$tok" in
        "~") tok=$HOME ;;
        "~/"*) tok=$HOME/${tok#\~/} ;;
      esac
      case "$tok" in
        /*) : ;;
        *) tok="$TDIR/$tok" ;;
      esac
      path_under_toolkit "$tok" || continue
      # Probe the deepest EXISTING ancestor — `mkdir -p <primary>/new/deep/…`
      # must not slip through just because the parent doesn't exist yet.
      _pd=$tok
      while [ ! -d "$_pd" ] && [ "$_pd" != "/" ] && [ -n "$_pd" ]; do _pd=$(dirname "$_pd"); done
      [ -d "$_pd" ] || continue
      set -- $(probe "$_pd"); [ "${1:-none}" = "primary" ] || continue
      _b=$(basename "$tok"); _skip=0
      for e in $EXEMPT_BASENAMES; do [ "$_b" = "$e" ] && _skip=1; done
      [ "$_skip" = 1 ] && continue
      block "shell write targeting toolkit primary checkout" "Command: $CMD
Attempted path: $tok"
    done
  fi

  # ── git discipline: delegate to the harness guards when the target is toolkit
  # primary. guard-destructive runs first — commit policy alone does not cover
  # force-push/hard-reset/restore-style rewrites of the primary.
  if path_under_toolkit "$TDIR"; then
    set -- $(probe "$TDIR"); KIND=${1:-none}
    if [ "$KIND" = "primary" ]; then
      # Working-tree rewrites are categorically destructive against a checkout
      # that is read-only for agents — guard-destructive only catches these when
      # a protected branch is named, which reset/restore/checkout-- rarely do.
      if printf '%s' "$CMD" | grep -qE 'git[[:space:]]+[^;|&]*(reset[[:space:]]+[^;|&]*--hard|[[:space:]]restore([[:space:]]|$)|checkout[[:space:]]+([^;|&]*[[:space:]])?--([[:space:]]|$)|[[:space:]](apply|am)([[:space:]]|$)|clean[[:space:]]+[^;|&]*-[a-zA-Z]*f|stash[[:space:]]+(pop|apply|drop|clear))'; then
        block "destructive git operation against the toolkit primary checkout" \
          "Command: $CMD"
      fi
      # Delegate with the SUBSTITUTED command so the harness guards resolve
      # `$AIOS_TOOLKIT_DIR`-based targets to the real primary path too.
      DELEGATED=$(printf '%s' "$NORMALIZED" | jq -c --arg c "$SCAN" '.command = $c') || exit 3
      printf '%s' "$DELEGATED" | "$HARNESS/hooks/guard-destructive.sh"
      _rc=$?
      [ "$_rc" -eq 0 ] || exit "$_rc"
      printf '%s' "$DELEGATED" | HARNESS_PRIMARY_COMMIT_POLICY=strict "$HARNESS/hooks/guard-worktree.sh"
      exit $?
    fi
  fi
  exit 0
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
  _abs=$(canon "$_abs")
  path_under_toolkit "$_abs" || continue
  base=$(basename "$_abs")
  for e in $EXEMPT_BASENAMES; do
    [ "$base" = "$e" ] && continue 2
  done
  block "editing toolkit primary checkout" \
    "Attempted path: $_abs"
done <<EOF
$FILE_PATHS
EOF

exit 0
