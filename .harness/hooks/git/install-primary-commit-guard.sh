#!/usr/bin/env bash
#
# install-primary-commit-guard.sh — idempotently install the repo-side worktree
# guards into a repo's .git/hooks, chaining any pre-existing hooks.
#
# Installs TWO parse-free backstops, the authoritative pair to the agent hook:
#   pre-commit-primary-guard          -> pre-commit + pre-merge-commit
#       blocks feature commits (and non-ff merges under strict) in the primary.
#   reference-transaction-strand-guard -> reference-transaction
#       blocks moving the primary checkout's HEAD onto a non-default branch
#       (`git checkout -b` / `switch -c` / `switch <feature>`), closing the
#       branch-creation bypasses the command-parsing agent hook can't catch.
#
# Usage:  hooks/git/install-primary-commit-guard.sh [repo-root]
#         (defaults to the current git repo)
#
# Idempotent: re-running is a no-op once installed. If a DIFFERENT hook of the same
# name already exists, it is preserved as `<hook>.chained` and exec'd by the guard
# on success (so a secrets/leak gate or other pre-existing hook keeps running).
set -euo pipefail

SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
COMMIT_GUARD_SRC="$SRC_DIR/pre-commit-primary-guard"
STRAND_GUARD_SRC="$SRC_DIR/reference-transaction-strand-guard"
[[ -f "$COMMIT_GUARD_SRC" ]] || { echo "install-primary-commit-guard: missing $COMMIT_GUARD_SRC" >&2; exit 1; }
[[ -f "$STRAND_GUARD_SRC" ]] || { echo "install-primary-commit-guard: missing $STRAND_GUARD_SRC" >&2; exit 1; }

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$REPO_ROOT" ]] || { echo "install-primary-commit-guard: not a git repo" >&2; exit 1; }

HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks 2>/dev/null)"
[[ "$HOOKS_DIR" = /* ]] || HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR"
mkdir -p "$HOOKS_DIR"

# install_guard <src> <marker> <hook-name>...  — copy <src> to each named hook,
# idempotently, chaining any pre-existing unrelated hook of that name.
install_guard() {
  local src="$1" marker="$2"; shift 2
  local hook target
  for hook in "$@"; do
    target="$HOOKS_DIR/$hook"
    if [[ -f "$target" ]] && grep -q "$marker" "$target" 2>/dev/null; then
      echo "[harness] $marker already installed at $target"
      continue
    fi
    if [[ -e "$target" ]] && ! grep -q "$marker" "$target" 2>/dev/null; then
      cp "$target" "$HOOKS_DIR/$hook.chained"
      chmod +x "$HOOKS_DIR/$hook.chained"
      echo "[harness] preserved existing $hook hook -> $HOOKS_DIR/$hook.chained"
    fi
    cp "$src" "$target"
    chmod +x "$target"
    echo "[harness] installed $marker -> $target"
  done
}

# Commit guard on both commit paths so strict policy forces ff-only advancement.
install_guard "$COMMIT_GUARD_SRC" "pre-commit-primary-guard" pre-commit pre-merge-commit
# Strand guard on the ref machinery so branch creation is caught parse-free.
install_guard "$STRAND_GUARD_SRC" "reference-transaction-strand-guard" reference-transaction
