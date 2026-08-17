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

# Repo identity + scope (probe, same_repository): .harness/hooks/repo-scope.sh. This
# guard polices ONLY the repo that vendors this harness. The lib is REQUIRED: a missing
# or truncated one sources cleanly yet leaves same_repository undefined, and an undefined
# call returns non-zero — which callers read as "not our repo", silently disabling the
# guard. So verify the whole surface arrived; anything less is exit 3 (block).
# shellcheck source=./repo-scope.sh
# shellcheck disable=SC1091  # path resolved at runtime; the function check below is the real gate
[ -f "$SCRIPT_DIR/repo-scope.sh" ] && . "$SCRIPT_DIR/repo-scope.sh" || exit 3
for _f in init_repo_scope same_repository probe; do command -v "$_f" >/dev/null 2>&1 || exit 3; done
init_repo_scope "$SCRIPT_DIR"

# Quote-aware command scanners: .harness/hooks/shell-parse.sh. Held to the same
# REQUIRED-surface rule as repo-scope.sh above — a truncated lib sources cleanly and
# leaves the scanners undefined, which would silently produce an empty write-candidate
# list, i.e. enforcement dropped without a word. So verify the whole surface arrived.
# shellcheck source=./shell-parse.sh
# shellcheck disable=SC1091  # path resolved at runtime; the function check below is the real gate
[ -f "$SCRIPT_DIR/shell-parse.sh" ] && . "$SCRIPT_DIR/shell-parse.sh" || exit 3
for _f in shell_redirection_targets shell_words shell_command_segments split_segment \
  drop_first_operand has_operand; do
  command -v "$_f" >/dev/null 2>&1 || exit 3
done

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
    # AIO-864: write candidates come from (a) shell output redirections and (b) the
    # ARGUMENTS OF A MUTATING COMMAND, identified by the segment's command WORD.
    # The raw command text is never shattered into tokens, so a mutating verb that
    # only appears inside a quoted argument contributes nothing.
    _cands=$(printf '%s' "$CMD" | shell_redirection_targets)
    split_segment "$CLASS_CMD"
    _mut_cands=''
    case "$SEG_CMD" in
      rm|tee|truncate|ln|touch|mkdir|dd|install)
        _mut_cands=$SEG_OPS ;;
      chmod|chown)
        # The first operand is the mode/owner, not a path.
        _mut_cands=$(drop_first_operand "$SEG_OPS") ;;
      unzip|ditto)
        # Always write, and unzip defaults to the shell cwd.
        _mut_cands="$SEG_OPS
$SDIR" ;;
      tar|bsdtar)
        # Extract mode writes files (-x/--extract, incl. old-style `tar xf`), into
        # the shell cwd unless redirected with -C. Creation (`tar -cf`) only reads
        # and is deliberately NOT matched.
        if has_operand "$SEG_OPS" '^(--extract|-[A-Za-z]*x[A-Za-z]*|x[A-Za-z]*)$'; then
          _mut_cands="$SEG_OPS
$SDIR"
        fi ;;
      sed)
        if has_operand "$SEG_OPS" '^(--in-place([=].*)?|-[A-Za-z]*i.*)$'; then
          # The first non-flag operand is the sed script, not a file.
          _mut_cands=$(drop_first_operand "$SEG_OPS")
        fi ;;
      curl)
        # curl writes nothing unless asked to: -o/--output/--output-dir name the
        # destination, -O/--remote-name writes into the shell cwd. A bare
        # `curl <url>` streams to stdout and is not a write.
        _mut_cands=$(printf '%s\n' "$SEG_OPS" | awk -v sdir="$SDIR" '
          NF {
            if (take) { print; take = 0; next }
            if ($0 == "-o" || $0 == "--output" || $0 == "--output-dir") { take = 1; next }
            if ($0 ~ /^--output(-dir)?=/) { sub(/^[^=]*=/, ""); print; next }
            if ($0 ~ /^-o./ && $0 !~ /^--/) { print substr($0, 3); next }
            if ($0 == "--remote-name" || ($0 ~ /^-[A-Za-z]*O/ && $0 !~ /^--/)) { remote = 1 }
          }
          END { if (remote) print sdir }') ;;
      wget)
        # wget writes into the shell cwd by DEFAULT, so the cwd is a candidate
        # unless an explicit destination was given.
        _mut_cands=$(printf '%s\n' "$SEG_OPS" | awk -v sdir="$SDIR" '
          NF {
            if (take) { print; take = 0; got = 1; next }
            if ($0 == "-O" || $0 == "--output-document" ||
                $0 == "-P" || $0 == "--directory-prefix") { take = 1; next }
            if ($0 ~ /^--(output-document|directory-prefix)=/) { sub(/^[^=]*=/, ""); print; got = 1; next }
            if ($0 ~ /^-[OP]./ && $0 !~ /^--/) { print substr($0, 3); got = 1; next }
          }
          END { if (!got) print sdir }') ;;
      cp|mv|rsync)
        # The destination is the last non-flag operand. Redirection targets were
        # already dropped by the tokenizer, so `cp src <primary>/dst >/tmp/log`
        # cannot hide its real destination behind the redirect.
        _mut_cands=$(printf '%s\n' "$SEG_OPS" | awk 'NF && $0 !~ /^-/' | tail -1) ;;
    esac
    [ -z "$_mut_cands" ] || _cands="$_cands
$_mut_cands"
    while IFS= read -r _tok || [ -n "$_tok" ]; do
      [ -n "$_tok" ] || continue
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
    done <<CANDIDATES_EOF
$(printf '%s\n' "$_cands" | awk 'NF && !seen[$0]++')
CANDIDATES_EOF
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
