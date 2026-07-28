#!/usr/bin/env bash
#
# install-leak-gate-push-hook.sh — (re)install the pre-push confidentiality leak gate.
#
# Mirrors install-primary-commit-guard.sh: git hooks live in `.git/hooks/`, are never
# version-controlled, and are lost on every fresh clone. This installer copies the tracked
# source (`hooks/git/pre-push-leak-gate`) into `.git/hooks/pre-push`, preserving any
# pre-existing pre-push hook by chaining it to `.git/hooks/pre-push.chained`.
#
# Idempotent: safe to run repeatedly. Because worktrees share the primary's hooks dir, one
# install covers every worktree.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "install-leak-gate-push-hook: not inside a git repo — aborting." >&2
  exit 1
fi

# Resolve the hooks dir honoring a custom core.hooksPath if set.
hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [[ -n "$hooks_path" ]]; then
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook_src="$script_dir/../hooks/git/pre-push-leak-gate"
if [[ ! -f "$hook_src" ]]; then
  echo "install-leak-gate-push-hook: hook source not found at $hook_src" >&2
  exit 1
fi

mkdir -p "$hooks_dir"
dest="$hooks_dir/pre-push"
chained="$hooks_dir/pre-push.chained"
marker="pre-push-leak-gate"

# Preserve a foreign pre-push hook as the chained hook (first time only — never clobber an
# already-saved chain).
if [[ -f "$dest" ]] && ! grep -q "$marker" "$dest" 2>/dev/null; then
  if [[ -f "$chained" ]]; then
    echo "install-leak-gate-push-hook: existing pre-push found but $chained already present — leaving chain untouched." >&2
  else
    cp "$dest" "$chained"
    chmod +x "$chained"
    echo "install-leak-gate-push-hook: preserved existing pre-push → $chained"
  fi
fi

cp "$hook_src" "$dest"
chmod +x "$dest"
echo "install-leak-gate-push-hook: installed push gate → $dest"
