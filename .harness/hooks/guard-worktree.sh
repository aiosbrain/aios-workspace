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
#   pre_edit     — block edits when HEAD is a non-default branch (you branched into
#                  the primary). Editing on the default branch is allowed (config /
#                  rare hotfix); basenames in HARNESS_PRIMARY_EXEMPT are always
#                  allowed. Each edited path is classified by its own repo.
#
# The default branch is HARNESS_DEFAULT_BRANCH if set, else auto-detected from
# origin/HEAD, else init.defaultBranch, else the main|master allowlist. Detached
# HEAD is treated as "not a feature branch" (allowed) so bisect/tag inspection works.
#
# Overrides: HARNESS_ALLOW_PRIMARY_CHECKOUT=1 disables the guard entirely.
#            HARNESS_PRIMARY_COMMIT_POLICY=strict blocks every primary commit.
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
  [ "$1" = "HEAD" ] && return 0
  if [ -n "${HARNESS_DEFAULT_BRANCH:-}" ]; then [ "$1" = "$HARNESS_DEFAULT_BRANCH" ]; return; fi
  case "$1" in main|master) return 0 ;; esac
  _oh=$(git -C "$2" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
  [ -n "$_oh" ] && [ "$1" = "$_oh" ] && return 0
  _id=$(git -C "$2" config --get init.defaultBranch 2>/dev/null)
  [ -n "$_id" ] && [ "$1" = "$_id" ] && return 0
  return 1
}

# probe <dir> -> "primary <branch>" | "worktree <branch>" | "none". Both git dirs
# are physically resolved (pwd -P) so a /var<->/private symlink can't fool it.
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
  {
    echo "BLOCKED by guard-worktree: $1"
    echo "$2"
    echo "Fix: create a dedicated worktree instead —"
    echo "  aios worktree add feat/<name>        # (or: git worktree add -b feat/<name> ../<repo>-worktrees/<name> origin/<default>)"
    echo "Override for a genuine primary-checkout action: HARNESS_ALLOW_PRIMARY_CHECKOUT=1"
  } >&2
  exit 2
}

# target_dir <command> <fallback> -> the dir a git command actually operates in,
# honoring `git -C <dir>` / `git -C=<dir>` (global option, immediately after git)
# then a leading `cd <dir> &&` / `pushd <dir> &&`. Falls back to the session cwd.
target_dir() {
  _cmd=$1; _fb=$2
  _t=$(printf '%s' "$_cmd" | sed -nE "s/.*(^|[^[:alnum:]_])git[[:space:]]+-C(=|[[:space:]]+)('[^']*'|\"[^\"]*\"|[^[:space:];&|]+).*/\3/p" | head -1)
  if [ -z "$_t" ]; then
    _t=$(printf '%s' "$_cmd" | sed -nE "s/^[[:space:]]*(cd|pushd)[[:space:]]+(--[[:space:]]+)?('[^']*'|\"[^\"]*\"|[^[:space:];&|]+)[[:space:]]*(&&|;).*/\3/p" | head -1)
  fi
  [ -n "$_t" ] || { printf '%s' "$_fb"; return; }
  _t=$(printf '%s' "$_t" | sed "s/^['\"]//; s/['\"]\$//")
  # NEVER eval $_t — it is attacker-controlled, unexecuted command text. Expand a
  # leading ~ / ~/ with a pure string substitution of $HOME; anything else is
  # treated as a path relative to the fallback dir. No shell expansion happens.
  case "$_t" in
    /*)    printf '%s' "$_t" ;;
    "~")   printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${_t#~/}" ;;
    *)     printf '%s' "$_fb/$_t" ;;
  esac
}

# norm_git <command> -> command with the run of git GLOBAL options (right after
# `git`, before the subcommand) stripped, so subcommand patterns match regardless of
# leading globals: `git -C x commit`, `git -c k='v v' commit`, `git --no-pager commit`,
# `git -p checkout -b`, `git --exec-path=/x commit`, equals or space forms. Arg-taking
# options consume their value (a shell word that may contain quoted spaces); value-less
# short (`-p`) and long (`--no-pager`) options are stripped generically so a new global
# option doesn't silently reopen a bypass. Stops at the first non-option token.
norm_git() {
  printf '%s' "$1" | sed -E "s#(^|[^[:alnum:]_])git[[:space:]]+(((-C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--config-env)(=|[[:space:]]+)([^[:space:]'\"]|'[^']*'|\"[^\"]*\")+|--exec-path(=([^[:space:]'\"]|'[^']*'|\"[^\"]*\")+)?|--[A-Za-z][A-Za-z-]*|-[A-Za-z])[[:space:]]+)+#\1git #g"
}

CWD=$(printf '%s' "$EVENT" | jq -r '.cwd // empty')
[ -n "$CWD" ] || CWD=$(pwd)

if [ "$MODE" = "command" ]; then
  CMD=$(printf '%s' "$EVENT" | jq -r '.command // empty') || exit 3
  [ -n "$CMD" ] || exit 3

  TDIR=$(target_dir "$CMD" "$CWD")
  [ -d "$TDIR" ] || TDIR="$CWD"
  set -- $(probe "$TDIR"); KIND=${1:-none}; BRANCH=${2:-}
  [ "$KIND" = "primary" ] || exit 0

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
    if [ "${HARNESS_PRIMARY_COMMIT_POLICY:-default-ok}" = "strict" ]; then
      block "committing in the primary checkout (branch '$BRANCH', strict policy)" \
        "The primary checkout only advances via \`git merge --ff-only\`; author commits in a worktree."
    elif ! is_default_branch "$BRANCH" "$TDIR"; then
      block "committing on non-default branch '$BRANCH' in the primary checkout" \
        "Feature commits belong in a worktree, never on a branch committed in the primary checkout."
    fi
  fi
  exit 0
fi

# MODE = edit — classify EACH edited path by its own repo (not just the first).
FILE_PATHS=$(printf '%s' "$EVENT" | jq -r '.paths[]? | .path, (.from // empty)' | awk 'NF && !seen[$0]++') || exit 3
[ -n "$FILE_PATHS" ] || exit 0

while IFS= read -r p || [ -n "$p" ]; do
  [ -n "$p" ] || continue
  case "$p" in
    /*) pdir=$(dirname "$p") ;;
    *)  pdir="$CWD/$(dirname "$p")" ;;
  esac
  [ -d "$pdir" ] || pdir="$CWD"
  set -- $(probe "$pdir"); KIND=${1:-none}; BRANCH=${2:-}
  [ "$KIND" = "primary" ] || continue
  is_default_branch "$BRANCH" "$pdir" && continue
  base=$(basename "$p")
  _exempt=0
  for e in $EXEMPT_BASENAMES; do [ "$base" = "$e" ] && _exempt=1; done
  [ "$_exempt" = "1" ] && continue
  block "editing '$p' on non-default branch '$BRANCH' in the primary checkout" \
    "You are on a feature branch checked out in the primary checkout — feature work belongs in a linked worktree."
done <<EOF
$FILE_PATHS
EOF
exit 0
