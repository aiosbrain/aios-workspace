#!/usr/bin/env bash
#
# install-primary-commit-guard.sh — (re)install the primary-checkout commit guard.
#
# git hooks in `.git/hooks/` are local-only and easily lost (never version
# controlled). This installer copies the tracked guard source
# (`hooks/git/pre-commit-primary-guard`) into `.git/hooks/pre-commit`, preserving
# any pre-existing pre-commit hook by chaining it to `.git/hooks/pre-commit.chained`
# (the guard execs it on success — so the NDA leak gate keeps running).
#
# Idempotent: safe to run repeatedly. Re-run after cloning or if the hook is lost.
# Invoked automatically by `aios worktree add` (via the shared hook-install path)
# and can be run by hand from the primary checkout.
#
# NOTE: because worktrees share the primary's hooks dir, this single install
# covers every worktree; the guard itself NO-OPs inside linked worktrees.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "install-primary-commit-guard: not inside a git repo — aborting." >&2
  exit 1
fi

# Resolve the hooks dir honoring a custom core.hooksPath if set.
hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [[ -n "$hooks_path" ]]; then
  # core.hooksPath may be relative to the repo root.
  if [[ "$hooks_path" != /* ]]; then
    hooks_dir="$repo_root/$hooks_path"
  else
    hooks_dir="$hooks_path"
  fi
else
  common_dir="$(git rev-parse --git-common-dir 2>/dev/null)"
  if [[ "$common_dir" != /* ]]; then
    common_dir="$(cd "$common_dir" && pwd)"
  fi
  hooks_dir="$common_dir/hooks"
fi

# Locate the tracked guard source relative to this script.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard_src="$script_dir/../hooks/git/pre-commit-primary-guard"
if [[ ! -f "$guard_src" ]]; then
  echo "install-primary-commit-guard: guard source not found at $guard_src" >&2
  exit 1
fi

mkdir -p "$hooks_dir"
dest="$hooks_dir/pre-commit"
chained="$hooks_dir/pre-commit.chained"

guard_marker="pre-commit-primary-guard"

# If a pre-commit already exists and is NOT our guard, preserve it as the chained
# hook (only the first time — don't clobber an already-saved chain).
if [[ -f "$dest" ]] && ! grep -q "$guard_marker" "$dest" 2>/dev/null; then
  if [[ -f "$chained" ]]; then
    echo "install-primary-commit-guard: existing pre-commit found but $chained already present — leaving chain untouched." >&2
  else
    cp "$dest" "$chained"
    chmod +x "$chained"
    echo "install-primary-commit-guard: preserved existing pre-commit → $chained"
  fi
fi

cp "$guard_src" "$dest"
chmod +x "$dest"
echo "install-primary-commit-guard: installed guard → $dest"
if [[ -x "$chained" ]]; then
  echo "install-primary-commit-guard: chained hook active → $chained"
fi
