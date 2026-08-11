#!/bin/sh
# repo-scope.sh — which repository does a policy hook actually police?
#
# SOURCED, not executed: it defines shell functions for guard-worktree.sh.
#
# WHY THIS EXISTS
# ---------------
# The worktree guard classified ANY primary checkout it was handed a path in as
# protected. A personal AIOS workspace, a sibling product repo, and an unrelated
# project on the same disk are all primary checkouts by definition, so an agent
# session anchored on the toolkit refused edits to every one of them. That is the
# cross-repo leak: the guard had no notion of WHICH repo it exists to protect.
#
# `.harness/` is stamped INTO the repo it guards (docs/repo-bootstrap.md), so the
# guarded root is two levels up from the hooks directory. Identity is compared on
# the git COMMON dir rather than the root path, so every linked worktree of the
# guarded repo stays in scope (a worktree shares its primary's common dir) while a
# different repository does not.
#
# FAILURE POSTURE: if the guarded repo cannot be determined — harness copied
# outside a git repo, git unavailable — `same_repository` returns true for
# everything, i.e. exactly the pre-existing behaviour. An unrecognised layout stays
# as protected as it is today rather than silently dropping enforcement, which is
# the wrong direction for a guard to fail.

# common_dir_of <dir> -> physical git common dir, or non-zero when not a repo.
common_dir_of() {
  _cdr=$(git -C "$1" rev-parse --git-common-dir 2>/dev/null) || return 1
  case "$_cdr" in
    /*) (cd "$_cdr" 2>/dev/null && pwd -P) ;;
    *)  (cd "$1" 2>/dev/null && cd "$_cdr" 2>/dev/null && pwd -P) ;;
  esac
}

# init_repo_scope <hooks_dir> — resolve the guarded repo once, into GUARDED_COMMON.
# HARNESS_GUARDED_ROOT names it explicitly. Production never sets it (the script
# location is the honest answer); it exists for harnesses that run this policy
# against fixture repositories, which are out of scope by construction and would
# otherwise assert nothing. See .harness/evals/guards.test.sh.
init_repo_scope() {
  GUARDED_COMMON=$(common_dir_of "${HARNESS_GUARDED_ROOT:-$1/../..}" 2>/dev/null || true)
}

# same_repository <dir> -> 0 when <dir> belongs to the guarded repository, or when
# the guarded repository could not be determined.
same_repository() {
  [ -n "${GUARDED_COMMON:-}" ] || return 0
  _sr=$(common_dir_of "$1" 2>/dev/null) || return 1
  [ "$_sr" = "$GUARDED_COMMON" ]
}

# probe <dir> -> "primary <branch>" | "worktree <branch>" | "none". Both git dirs are
# physically resolved (pwd -P) so a /var<->/private symlink cannot fool the comparison.
probe() {
  _d=$1
  _gd=$(git -C "$_d" rev-parse --absolute-git-dir 2>/dev/null) || { echo none; return; }
  _gd=$(cd "$_gd" 2>/dev/null && pwd -P) || { echo none; return; }
  _cd=$(common_dir_of "$_d") || { echo none; return; }
  [ -n "$_cd" ] || { echo none; return; }
  _br=$(git -C "$_d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
  if [ "$_gd" = "$_cd" ]; then echo "primary $_br"; else echo "worktree $_br"; fi
}
