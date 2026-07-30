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
#
# core.hooksPath repos with TRACKED policy hooks (AIO-638): when a resolved
# destination already carries the line-anchored `# aios-tracked-hook` marker (a
# version-controlled policy hook), that file is left untouched and the guard is
# installed machine-locally into `$(git rev-parse --git-common-dir)/hooks/` —
# the chain target every tracked hook execs. When hooksPath is set but no
# tracked marker hook exists, the legacy behavior (install into the hooksPath
# dir) is kept.
set -euo pipefail

SRC_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
COMMIT_GUARD_SRC="$SRC_DIR/pre-commit-primary-guard"
STRAND_GUARD_SRC="$SRC_DIR/reference-transaction-strand-guard"
[[ -f "$COMMIT_GUARD_SRC" ]] || { echo "install-primary-commit-guard: missing $COMMIT_GUARD_SRC" >&2; exit 1; }
[[ -f "$STRAND_GUARD_SRC" ]] || { echo "install-primary-commit-guard: missing $STRAND_GUARD_SRC" >&2; exit 1; }

REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$REPO_ROOT" ]] || { echo "install-primary-commit-guard: not a git repo" >&2; exit 1; }

# `--git-path hooks` honors core.hooksPath (may be a TRACKED dir, e.g. `.githooks/`).
HOOKS_DIR="$(git -C "$REPO_ROOT" rev-parse --git-path hooks 2>/dev/null)"
[[ "$HOOKS_DIR" = /* ]] || HOOKS_DIR="$REPO_ROOT/$HOOKS_DIR"
mkdir -p "$HOOKS_DIR"

# The machine-local chain target: tracked hooks chain `<common-dir>/hooks/<name>`.
COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null)"
[[ "$COMMON_DIR" = /* ]] || COMMON_DIR="$(cd "$REPO_ROOT/$COMMON_DIR" && pwd)"
COMMON_HOOKS_DIR="$COMMON_DIR/hooks"
TRACKED_MARKER='^# aios-tracked-hook'

# install_guard <src> <marker> <hook-name>...  — copy <src> to each named hook,
# idempotently, chaining any pre-existing unrelated hook of that name. A hook
# carrying the line-anchored `# aios-tracked-hook` marker is a version-controlled
# policy hook (AIO-638): it is left untouched and the guard goes to the
# machine-local common-dir hooks (the chain target the tracked hook execs).
install_guard() {
  local src="$1" marker="$2"; shift 2
  local hook dir target
  for hook in "$@"; do
    dir="$HOOKS_DIR"
    if [[ "$dir" != "$COMMON_HOOKS_DIR" && -f "$dir/$hook" ]] \
      && grep -q "$TRACKED_MARKER" "$dir/$hook" 2>/dev/null; then
      echo "[harness] tracked $hook hook at $dir/$hook (core.hooksPath) — installing machine-local guard into $COMMON_HOOKS_DIR (chained by the tracked hook)"
      dir="$COMMON_HOOKS_DIR"
      mkdir -p "$dir"
    fi
    target="$dir/$hook"
    if [[ -f "$target" ]] && grep -q "$marker" "$target" 2>/dev/null; then
      echo "[harness] $marker already installed at $target"
      continue
    fi
    # Never preserve a stray copy of a TRACKED hook: the tracked source still runs
    # via core.hooksPath, and chaining a copy that chains this dir would recurse.
    if [[ -e "$target" ]] && ! grep -q "$marker" "$target" 2>/dev/null \
      && ! grep -q "$TRACKED_MARKER" "$target" 2>/dev/null; then
      cp "$target" "$dir/$hook.chained"
      chmod +x "$dir/$hook.chained"
      echo "[harness] preserved existing $hook hook -> $dir/$hook.chained"
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
