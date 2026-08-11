#!/bin/sh
# Portable worktree-discipline policy. Handles pre_edit AND pre_command.
# Exit 0 allow, 2 policy block, 3 evaluation failure.
#
# Enforces the worktree convention that harnesses running with full autonomy
# (Codex/OpenCode/Cursor/Claude) otherwise ignore: feature work must live in a
# dedicated linked git worktree, never on a branch checked out in the PRIMARY
# checkout. Automated agents were observed doing `git checkout -b <feature>` in
# the primary checkout and committing there — colliding with concurrent human
# work and producing duplicate PRs. This guard makes that structurally loud at
# the moment of the edit or the branching command, not just at commit time (the
# tracked pre-commit git-hook `hooks/git/pre-commit-primary-guard` is the
# commit-time backstop for paths this agent hook never sees).
#
# Rules, only when the target repo is the PRIMARY checkout (no-op in worktrees):
#   pre_command  — block creating/renaming a branch (checkout -b/-B, switch -c/-C/
#                  --create, branch -m/-c, branch <new>) and block `git commit`
#                  (strict: any branch; default-ok: non-default branch only). The
#                  command's TARGET repo is resolved from `git -C <dir>` / a leading
#                  `cd <dir> &&`, not the session cwd.
#   pre_edit     — block edits in the primary checkout. default-ok: only when HEAD is
#                  a non-default branch (you branched into the primary). strict: every
#                  primary edit (including on the default branch). Basenames in
#                  HARNESS_PRIMARY_EXEMPT are always allowed. Each edited path is
#                  classified by its own repo.
#
# The default branch is HARNESS_DEFAULT_BRANCH if set, else auto-detected from
# origin/HEAD, else init.defaultBranch, else the main|master allowlist. Detached
# HEAD is treated as "not a feature branch" (allowed) so bisect/tag inspection works.
#
# Overrides: HARNESS_ALLOW_PRIMARY_CHECKOUT=1 disables the guard entirely.
#            HARNESS_/AIOS_ALLOW_PRIMARY_COMMIT=1 (env or command-local): `git commit` only.
#            HARNESS_PRIMARY_COMMIT_POLICY=strict blocks every primary commit.
#            HARNESS_PRIMARY_EDIT_POLICY=strict blocks every primary edit (incl. main).
#            HARNESS_PRIMARY_EXEMPT (default `aios.yaml`) space-separated basenames.
set -u

[ "${HARNESS_ALLOW_PRIMARY_CHECKOUT:-0}" = "1" ] && exit 0

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INPUT=$(cat 2>/dev/null || true)

command -v jq >/dev/null 2>&1 || exit 3

# run-hook.sh has normalized the payload and set .event by the time we run.
EVENT_NAME=$(printf '%s' "$INPUT" | jq -r '.event // empty' 2>/dev/null)
case "$EVENT_NAME" in
  pre_command) MODE=command ;;
  pre_edit)    MODE=edit ;;
  *)           exit 0 ;;
esac

EVENT=$(printf '%s' "$INPUT" | "$SCRIPT_DIR/prepare-event.sh" "$EVENT_NAME")
STATUS=$?
[ "$STATUS" -eq 4 ] && exit 0
[ "$STATUS" -eq 0 ] || exit 3

EXEMPT_BASENAMES=${HARNESS_PRIMARY_EXEMPT:-aios.yaml}

# is_default_branch <branch> <dir> -> 0 if <branch> is allowed to live in the primary.
# HARNESS_DEFAULT_BRANCH is authoritative when set. Otherwise the accepted set is the
# UNION of {main, master} (always — the two universal defaults are never bricked) plus
# origin/HEAD and init.defaultBranch when they resolve (covers develop/trunk defaults).
# Detached HEAD (branch "HEAD") is not a feature branch -> allowed (bisect / tags).
is_default_branch() {
  _b=$1; _dir=$2
  [ "$_b" = "HEAD" ] && return 0
  if [ -n "${HARNESS_DEFAULT_BRANCH:-}" ]; then [ "$_b" = "$HARNESS_DEFAULT_BRANCH" ]; return; fi
  case "$_b" in
    main|master) return 0 ;;
    *) ;;
  esac
  _oh=$(git -C "$_dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
  [ -n "$_oh" ] && [ "$_b" = "$_oh" ] && return 0
  _id=$(git -C "$_dir" config --get init.defaultBranch 2>/dev/null)
  [ -n "$_id" ] && [ "$_b" = "$_id" ] && return 0
  return 1
}

# Repo identity + scope (probe, same_repository): .harness/hooks/repo-scope.sh.
# This guard polices ONLY the repo that vendors this harness. The lib is required:
# stubbing it out would make probe() answer "none" for everything and silently
# disable the guard, so an incomplete install is exit 3 (could-not-evaluate ->
# block) rather than a quiet pass.
[ -f "$SCRIPT_DIR/repo-scope.sh" ] || exit 3
. "$SCRIPT_DIR/repo-scope.sh"
init_repo_scope "$SCRIPT_DIR"

block() {
  _reason=$1; _detail=$2
  {
    echo "BLOCKED by guard-worktree: $_reason"
    echo "$_detail"
    echo "Fix: create a dedicated worktree instead —"
    echo "  aios worktree add feat/<name>        # (or: git worktree add -b feat/<name> ../<repo>-worktrees/<name> origin/<default>)"
    echo "Override for a genuine primary-checkout action: HARNESS_ALLOW_PRIMARY_CHECKOUT=1"
  } >&2
  exit 2
}

# resolve_path_tok <token> <fallback-dir> — strip one quote layer and resolve.
# NEVER eval $1 (attacker-controlled, unexecuted command text): a leading ~ is
# expanded by pure $HOME string substitution; no shell expansion happens.
resolve_path_tok() {
  _t=$(printf '%s' "$1" | sed "s/^['\"]//; s/['\"]\$//")
  case "$_t" in
    /*)    printf '%s' "$_t" ;;
    "~")   printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${_t#~/}" ;;
    *)     printf '%s' "$2/$_t" ;;
  esac
}

# target_dir <command> <fallback> -> the dir a git command actually operates in,
# honoring `git -C <dir>` / `git -C=<dir>` (global option, immediately after git)
# then a leading `cd <dir> &&` / `pushd <dir> &&`. Falls back to the session cwd.
target_dir() {
  _cmd=$1; _fb=$2
  _t0=$(printf '%s' "$_cmd" | sed -nE "s/.*(^|[^[:alnum:]_])git[[:space:]]+-C(=|[[:space:]]+)('[^']*'|\"[^\"]*\"|[^[:space:];&|]+).*/\3/p" | head -1)
  [ -n "$_t0" ] || _t0=$(printf '%s' "$_cmd" | sed -nE "s/^[[:space:]]*(cd|pushd)[[:space:]]+(--[[:space:]]+)?('[^']*'|\"[^\"]*\"|[^[:space:];&|]+)[[:space:]]*(&&|;).*/\3/p" | head -1)
  if [ -n "$_t0" ]; then resolve_path_tok "$_t0" "$_fb"; else printf '%s' "$_fb"; fi
}

# shell_dir <command> <fallback> -> cwd in which shell redirects and file
# mutation operands resolve. Unlike target_dir, `git -C` does not affect the
# shell process cwd; only a leading cd/pushd does.
shell_dir() {
  _t0=$(printf '%s' "$1" | sed -nE "s/^[[:space:]]*(cd|pushd)[[:space:]]+(--[[:space:]]+)?('[^']*'|\"[^\"]*\"|[^[:space:];&|]+)[[:space:]]*(&&|;).*/\3/p" | head -1)
  if [ -n "$_t0" ]; then resolve_path_tok "$_t0" "$2"; else printf '%s' "$2"; fi
}

# norm_git <command> -> command with the run of git GLOBAL options (right after
# `git`, before the subcommand) stripped, so subcommand patterns match regardless of
# leading globals: `git -C x commit`, `git -c k='v v' commit`, `git --no-pager commit`,
# `git -p checkout -b`, `git --exec-path=/x commit`, equals or space forms. Arg-taking
# options consume their value (a shell word that may contain quoted spaces); value-less
# short (`-p`) and long (`--no-pager`) options are stripped generically so a new global
# option doesn't silently reopen a bypass. Stops at the first non-option token.
norm_git() {
  _cmd=$1
  printf '%s' "$_cmd" | sed -E "s#(^|[^[:alnum:]_])git[[:space:]]+(((-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env)(=|[[:space:]]+)([^[:space:]'\"]|'[^']*'|\"[^\"]*\")+|--exec-path(=([^[:space:]'\"]|'[^']*'|\"[^\"]*\")+)?|--[A-Za-z][A-Za-z-]*|-[A-Za-z])[[:space:]]+)+#\1git #g"
  return
}

# Shared awk heredoc bookkeeping for the two scanners below.
AWK_HEREDOC='
  function remember_heredoc(line, start,    i, c, quote, delim, strip_tabs) {
    i = start; strip_tabs = substr(line, i, 1) == "-"
    if (strip_tabs) i++
    while (substr(line, i, 1) ~ /[ \t]/) i++
    quote = substr(line, i, 1)
    if (quote == "\047" || quote == "\"") i++; else quote = ""
    delim = ""
    while (i <= length(line)) {
      c = substr(line, i, 1)
      if ((quote != "" && c == quote) ||
          (quote == "" && c ~ /[ \t;|&<>]/)) break
      delim = delim c
      i++
    }
    if (delim != "") {
      heredoc[++heredoc_count] = delim; heredoc_strip_tabs[heredoc_count] = strip_tabs
    }
    return i
  }
  function in_heredoc_body(line) {
    if (heredoc_current > 0 && heredoc_current <= heredoc_count) {
      closing_line = line
      if (heredoc_strip_tabs[heredoc_current]) sub(/^\t+/, "", closing_line)
      if (closing_line == heredoc[heredoc_current]) heredoc_current++
      return 1
    }
    return 0
  }
'

# shell_redirection_targets <command> -> one output-redirection target per line.
# Operators inside quotes and every line of a heredoc body are data, not shell
# syntax. The scanner intentionally does not execute or expand command text.
shell_redirection_targets() {
  awk "$AWK_HEREDOC"'
    function space(c) { return c == " " || c == "\t" }
    function emit_target(line, start,    i, c, quote, escaped, target) {
      i = start
      while (space(substr(line, i, 1))) i++
      target = ""
      quote = ""
      escaped = 0
      while (i <= length(line)) {
        c = substr(line, i, 1)
        if (escaped) {
          target = target c
          escaped = 0
        } else if (c == "\\") {
          escaped = 1
        } else if (quote != "") {
          if (c == quote) quote = ""
          else target = target c
        } else if (c == "\047" || c == "\"") {
          quote = c
        } else if (space(c) || c ~ /[;|&<>]/) {
          break
        } else {
          target = target c
        }
        i++
      }
      if (target != "") print target
      return i
    }
    {
      if (in_heredoc_body($0)) next
      quote = ""
      escaped = 0
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        nextc = substr($0, i + 1, 1)
        if (escaped) {
          escaped = 0
        } else if (c == "\\") {
          escaped = 1
        } else if (quote != "") {
          if (c == quote) quote = ""
        } else if (c == "\047" || c == "\"") {
          quote = c
        } else if (c == "<" && nextc == "<") {
          i = remember_heredoc($0, i + 2)
        } else if (c == ">") {
          if (nextc == ">") i++
          if (substr($0, i + 1, 1) != "&") i = emit_target($0, i + 1)
        }
      }
      if (heredoc_current == 0 && heredoc_count > 0) heredoc_current = 1
    }
  '
}

shell_command_segments() {
  printf '%s' "$1" | awk "$AWK_HEREDOC"'
    function emit(kind) {
      gsub(/^[ \t]+|[ \t]+$/, "", segment)
      if (segment != "") print kind "|" segment
      segment = ""
    }
    {
      if (in_heredoc_body($0)) next
      quote = ""; escaped = 0
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        nextc = substr($0, i + 1, 1)
        if (escaped) {
          segment = segment c; escaped = 0
        } else if (c == "\\") {
          segment = segment c; escaped = 1
        } else if (quote != "") {
          segment = segment c
          if (c == quote) quote = ""
        } else if (c == "\047" || c == "\"") {
          segment = segment c; quote = c
        } else if (c == "#" && (i == 1 || substr($0, i - 1, 1) ~ /[ \t]/)) { break
        } else if (c == "<" && nextc == "<") {
          segment = segment c nextc
          i++
          heredoc_end = remember_heredoc($0, i + 1)
          segment = segment substr($0, i + 1, heredoc_end - i)
          i = heredoc_end
        } else if ((c == "&" || c == "|") && nextc == c) {
          emit(in_pipeline ? "P" : "S"); i++; in_pipeline = 0
        } else if (c == "|") {
          emit("P"); in_pipeline = 1
        } else if (c == "&") {
          emit("P"); in_pipeline = 0
        } else if (c == ";") {
          emit(in_pipeline ? "P" : "S"); in_pipeline = 0
        } else if (c == "(" && segment ~ /^[ \t]*$/) {
          # AIO-637 F3/F6: unquoted `(` at command position opens a subshell
          # (O/C markers let the driver restore the tracked cwd at the close).
          # A `)` closing a mid-word paren ($(..), %(refname)) or with no open
          # at all (case patterns) stays DATA — never splits a segment.
          print "O|("; segment = ""; in_pipeline = 0; depth++
        } else if (c == ")" && (depth > 0 || paren > 0)) {
          if (paren > 0) { paren--; segment = segment c }
          else { emit(in_pipeline ? "P" : "S"); print "C|)"; in_pipeline = 0; depth-- }
        } else {
          if (c == "(") paren++
          segment = segment c
        }
      }
      emit(in_pipeline ? "P" : "S"); in_pipeline = 0
      if (heredoc_current == 0 && heredoc_count > 0) heredoc_current = 1
    }
  '
}

# Command-local override recognition (<VAR>=1 directly or behind `env`), scoped
# to exactly one segment. AIO-637 F1: AIOS_ALLOW_PRIMARY_COMMIT is the pre-commit
# hook's documented hotfix escape hatch — honored for the COMMIT check only.
segment_allows_var() {
  printf '%s' "$1" | grep -Eq \
    '^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=([^[:space:]]+)[[:space:]]+)*'"$2"'=1([[:space:]]|$)|^[[:space:]]*env([[:space:]]+-[^[:space:]]+)*([[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+)*[[:space:]]+'"$2"'=1([[:space:]]|$)'
}
segment_allows_primary() { segment_allows_var "$1" HARNESS_ALLOW_PRIMARY_CHECKOUT; }
segment_allows_primary_commit() { segment_allows_var "$1" HARNESS_ALLOW_PRIMARY_COMMIT ||
  segment_allows_var "$1" AIOS_ALLOW_PRIMARY_COMMIT; } # F7: both names (git-hook parity)
command_without_env_prefix() {
  printf '%s' "$1" | sed -E \
    -e 's/^[[:space:]]*env([[:space:]]+-[^[:space:]]+)*//' \
    -e 's/^([[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+)+[[:space:]]*//'
}

# AIO-637 F2: if|elif|while|until stripped too — a cd in a compound-command
# CONDITION (`if cd <dir>; then …`) changes the parent shell cwd.
segment_cd_target() {
  _cd_cmd=$(printf '%s' "$1" | sed -E -e 's/^[[:space:]]*\{[[:space:]]*//' \
    -e 's/^[[:space:]]*(if|elif|while|until|then|do|else)[[:space:]]+//' -e 's/^[[:space:]]*env([[:space:]]+-[^[:space:]]+)*//' \
    -e 's/^([[:space:]]*[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+)+[[:space:]]*//' -e 's/^[[:space:]]*(command([[:space:]]+--)?|builtin)[[:space:]]+//' \
    -e 's/[[:space:]]+[0-9]*(>>?|<)[[:space:]]*[^[:space:]]+.*$//')
  case "$_cd_cmd" in
    cd[[:space:]]*|pushd[[:space:]]*) shell_dir "$_cd_cmd;" "$2" ;;
    *) return 1 ;;
  esac
}

CWD=$(printf '%s' "$EVENT" | jq -r '.cwd // empty')
[ -n "$CWD" ] || CWD=$(pwd)

if [ "$MODE" = "command" ]; then
  FULL_CMD=$(printf '%s' "$EVENT" | jq -r '.command // empty') || exit 3
  [ -n "$FULL_CMD" ] || exit 3

check_command_segment() {
  CMD=$1
  segment_allows_primary "$CMD" && return 0
  CLASS_CMD=$(command_without_env_prefix "$CMD")

  TDIR=$(target_dir "$CMD" "$BASE_CWD")
  [ -d "$TDIR" ] || TDIR="$BASE_CWD"
  SDIR=$(shell_dir "$CMD" "$BASE_CWD")
  [ -d "$SDIR" ] || SDIR="$BASE_CWD"

  # Under strict edit policy, shell file mutations are held to the same rule as
  # pre_edit Write/Edit: no writes into a PRIMARY checkout (>, >>, cp, mv, rm,
  # sed -i, tee, curl -o, …). Each candidate token is classified by its own repo
  # (per-token probe), and relative candidates resolve against the shell cwd
  # (not an unrelated git -C target). Known limits: interpreter one-liners
  # (node -e / python -c) and
  # command substitution are not evaluated — the tracked pre-commit primary
  # guard remains the commit-time backstop.
  if [ "${HARNESS_PRIMARY_EDIT_POLICY:-default-ok}" = "strict" ]; then
    _muts='rm|tee|truncate|ln|touch|mkdir|chmod|chown|dd|install|curl|wget'
    # Archive extraction writes files too: tar/bsdtar in extract mode (-x/--extract,
    # incl. old-style `tar xf`), and unzip/ditto (which always write). Creation
    # (`tar -cf`) only reads and is deliberately NOT matched.
    _extract_re='(^|[[:space:]&;|({])(tar|bsdtar)[[:space:]]+(([^;|&]*[[:space:]])?(-[[:alnum:]]*x[[:alnum:]]*|--extract)([[:space:]=]|$)|x[[:alnum:]]*([[:space:]]|$))|(^|[[:space:]&;|({])(unzip|ditto)[[:space:]]'
    _cands=$(printf '%s' "$CMD" | shell_redirection_targets)
    _is_package_manager=0
    printf '%s' "$CLASS_CMD" | grep -Eq '^[[:space:]]*(npm|pnpm|yarn|bun)([[:space:]]|$)' && _is_package_manager=1
    if printf '%s' "$CMD" | grep -Eq '(^|[[:space:]&;|({])('"$_muts"')[[:space:]]|sed[[:space:]]+(-[[:alnum:]]*i|--in-place)|'"$_extract_re" &&
       { [ "$_is_package_manager" = 0 ] || ! printf '%s' "$CLASS_CMD" | grep -Eq '^[[:space:]]*(npm|pnpm|yarn|bun)[[:space:]]+install([[:space:]]|$)'; }; then
      _cands="$_cands
$(printf '%s\n' "$CMD" | tr ';|&(){}<>' ' ' | tr ' \t' '\n\n' | awk 'NF' | grep -Evx "$_muts|sed|cp|mv|rsync|tar|bsdtar|unzip|ditto")"
    elif printf '%s' "$CMD" | grep -Eq '(^|[[:space:]&;|({])(cp|mv|rsync)[[:space:]]'; then
      # Strip redirections BEFORE picking the last token as the destination —
      # otherwise `cp src <primary>/dst >/tmp/log` hides the real destination
      # behind the redirect target. (Redirect targets themselves are already
      # collected above from the unstripped command.)
      _nored=$(printf '%s' "$CMD" | sed -E 's/[0-9]*>&[0-9]+//g; s/[0-9]*(>>?|<)[[:space:]]*[^&<>[:space:];|]+//g')
      _cands="$_cands
$(printf '%s\n' "$_nored" | tr ';|&(){}<>' ' ' | tr ' \t' '\n\n' | awk 'NF && $0 !~ /^-/' | tail -1)"
    fi
    for _tok in $(printf '%s\n' "$_cands" | sed "s/^['\"]//; s/['\"]\$//" | awk 'NF && !seen[$0]++'); do
      case "$_tok" in
        -*=/*) _tok=${_tok#*=} ;;
        -*/*)  _tok="/${_tok#*/}" ;;  # attached path arg: -o/abs, -d/abs, -C/abs
        -*)    continue ;;
        *=/*)  _tok=${_tok#*=} ;;
      esac
      case "$_tok" in
        "~") _tok=$HOME ;;
        "~/"*) _tok=$HOME/${_tok#\~/} ;;
      esac
      case "$_tok" in
        /*) : ;;
        *) _tok="$SDIR/$_tok" ;;
      esac
      # Probe the deepest EXISTING ancestor — `mkdir -p <primary>/new/deep/…`
      # must not slip through just because the parent doesn't exist yet.
      _tpd=$_tok
      while [ ! -d "$_tpd" ] && [ "$_tpd" != "/" ] && [ -n "$_tpd" ]; do _tpd=$(dirname "$_tpd"); done
      [ -d "$_tpd" ] || continue
      same_repository "$_tpd" || continue
      set -- $(probe "$_tpd"); [ "${1:-none}" = "primary" ] || continue
      _tb=$(basename "$_tok"); _tsk=0
      for e in $EXEMPT_BASENAMES; do [ "$_tb" = "$e" ] && _tsk=1; done
      [ "$_tsk" = 1 ] && continue
      block "shell write to '$_tok' in the primary checkout (strict edit policy)" \
        "The primary checkout is read-only for agents — shell redirects/copies are held to the same rule as Write/Edit."
    done
  fi

  same_repository "$TDIR" || return 0
  set -- $(probe "$TDIR"); KIND=${1:-none}; BRANCH=${2:-}
  [ "$KIND" = "primary" ] || return 0

  NORM=$(norm_git "$CMD")

  # Creating or renaming a branch in the primary checkout — the omo/Codex failure mode.
  # The create flag may sit after other options (e.g. `checkout -q -b`), so allow
  # intervening non-`;&|` option tokens between the subcommand and the create flag.
  if printf '%s' "$NORM" | grep -qE 'git[[:space:]]+checkout[[:space:]]([^;&|]*[[:space:]])?(-[a-zA-Z]*[bB]|--create)([[:space:]]|=|$|['"'"'"[:alnum:]])' ||
     printf '%s' "$NORM" | grep -qE 'git[[:space:]]+switch[[:space:]]([^;&|]*[[:space:]])?(-[a-zA-Z]*[cC]|--create)([[:space:]]|=|$|['"'"'"[:alnum:]])' ||
     printf '%s' "$NORM" | grep -qE 'git[[:space:]]+branch[[:space:]]+(-[a-zA-Z]*[mMcC]|--move|--copy)([[:space:]]|$)' ||
     printf '%s' "$NORM" | grep -qE 'git[[:space:]]+branch[[:space:]]+(-[a-zA-Z]*[ft]|--force|--track|--no-track)[[:space:]]+[^[:space:]]' ||
     printf '%s' "$NORM" | grep -qE 'git[[:space:]]+branch[[:space:]]+([^-;|&[:space:]][^;|&[:space:]]*)([[:space:]]|[;|&]|$)'; then
    block "creating/renaming a branch in the primary checkout (branch '$BRANCH')" \
      "Branch creation in the primary checkout strands it on a feature branch and collides with concurrent work."
  fi

  # Committing in the primary checkout (belt-and-suspenders with the git hook).
  if printf '%s' "$NORM" | grep -qE 'git[[:space:]]+commit([[:space:]]|$)'; then
    if [ "${HARNESS_ALLOW_PRIMARY_COMMIT:-${AIOS_ALLOW_PRIMARY_COMMIT:-0}}" = "1" ] || segment_allows_primary_commit "$CMD"; then
      : # documented genuine-hotfix escape hatch — same override the git hook honors
    elif [ "${HARNESS_PRIMARY_COMMIT_POLICY:-default-ok}" = "strict" ]; then
      block "committing in the primary checkout (branch '$BRANCH', strict policy)" \
        "The primary checkout only advances via \`git merge --ff-only\`; author commits in a worktree."
    elif ! is_default_branch "$BRANCH" "$TDIR"; then
      block "committing on non-default branch '$BRANCH' in the primary checkout" \
        "Feature commits belong in a worktree, never on a branch committed in the primary checkout."
    fi
  fi
  return 0
}

  BASE_CWD=$CWD
  CWD_STACK=''  # AIO-637 F3: newline-separated stack of pre-subshell cwds
  NL='
'
  SEGMENTS=$(shell_command_segments "$FULL_CMD") || exit 3
  while IFS= read -r CMD_RECORD || [ -n "$CMD_RECORD" ]; do
    [ -n "$CMD_RECORD" ] || continue
    SEGMENT_SCOPE=${CMD_RECORD%%|*}
    CMD_SEGMENT=${CMD_RECORD#*|}
    case "$SEGMENT_SCOPE" in
      O) CWD_STACK="$BASE_CWD$NL$CWD_STACK"; continue ;;
      C) if [ -n "$CWD_STACK" ]; then
           BASE_CWD=${CWD_STACK%%"$NL"*}; CWD_STACK=${CWD_STACK#*"$NL"}
         fi; continue ;;
    esac
    check_command_segment "$CMD_SEGMENT"
    if [ "$SEGMENT_SCOPE" = S ]; then
      NEXT_CWD=$(segment_cd_target "$CMD_SEGMENT" "$BASE_CWD") || NEXT_CWD=
      [ -n "$NEXT_CWD" ] && [ -d "$NEXT_CWD" ] && BASE_CWD=$NEXT_CWD
    fi
  done <<EOF
$SEGMENTS
EOF
  exit 0
fi

# MODE = edit — classify EACH edited path by its own repo (not just the first).
# Move/rename destinations (.to / .destination) are held to the same rule as
# sources — a move INTO a primary checkout is a write into it.
FILE_PATHS=$(printf '%s' "$EVENT" | jq -r '.paths[]? | .path, (.from // empty), (.to // empty), (.destination // empty)' | awk 'NF && !seen[$0]++') || exit 3
[ -n "$FILE_PATHS" ] || exit 0

while IFS= read -r p || [ -n "$p" ]; do
  [ -n "$p" ] || continue
  case "$p" in
    /*) pdir=$(dirname "$p") ;;
    *)  pdir="$CWD/$(dirname "$p")" ;;
  esac
  # Walk up to the deepest EXISTING ancestor so a multi-level new path inside
  # a primary checkout is still classified by that repo, not the session cwd.
  while [ ! -d "$pdir" ] && [ "$pdir" != "/" ] && [ -n "$pdir" ]; do pdir=$(dirname "$pdir"); done
  [ -d "$pdir" ] || pdir="$CWD"
  same_repository "$pdir" || continue
  set -- $(probe "$pdir"); KIND=${1:-none}; BRANCH=${2:-}
  [ "$KIND" = "primary" ] || continue
  if [ "${HARNESS_PRIMARY_EDIT_POLICY:-default-ok}" != "strict" ]; then
    is_default_branch "$BRANCH" "$pdir" && continue
  fi
  base=$(basename "$p")
  _exempt=0
  for e in $EXEMPT_BASENAMES; do [ "$base" = "$e" ] && _exempt=1; done
  [ "$_exempt" = "1" ] && continue
  if [ "${HARNESS_PRIMARY_EDIT_POLICY:-default-ok}" = "strict" ]; then
    block "editing '$p' in the primary checkout (branch '$BRANCH', strict edit policy)" \
      "The primary checkout is read-only for agents — feature work belongs in a linked worktree."
  else
    block "editing '$p' on non-default branch '$BRANCH' in the primary checkout" \
      "You are on a feature branch checked out in the primary checkout — feature work belongs in a linked worktree."
  fi
done <<EOF
$FILE_PATHS
EOF
exit 0
