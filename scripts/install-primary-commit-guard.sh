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
# Idempotent: safe to run repeatedly. Run by hand from the primary checkout. The
# toolkit never installs it automatically: it is a machine-local preference, and it
# only installs into repos listed under "protect" in ~/.claude/branch-protection.json
# (override: AIOS_BRANCH_PROTECTION_CONFIG). Anywhere else it is a no-op.
#
# NOTE: because worktrees share the primary's hooks dir, this single install
# covers every worktree; the guard itself NO-OPs inside linked worktrees.
#
# core.hooksPath repos with TRACKED policy hooks (AIO-638): when the resolved
# destination already carries the line-anchored `# aios-tracked-hook` marker (a
# version-controlled policy hook, e.g. aios-team-brain's `.githooks/`), this
# installer must NOT overwrite it — that clobbers a tracked file with an
# untracked copy whose chain resolution is broken there. Instead the guard is
# installed machine-locally into `$(git rev-parse --git-common-dir)/hooks/`,
# which is exactly the chain target every tracked hook execs. When hooksPath is
# set but no tracked marker hook exists (older checkout), the legacy behavior
# (install into the hooksPath dir) is kept.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "install-primary-commit-guard: not inside a git repo — aborting." >&2
  exit 1
fi

# Locate the tracked guard source relative to this script.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guard_src="$script_dir/../hooks/git/pre-commit-primary-guard"
if [[ ! -f "$guard_src" ]]; then
  echo "install-primary-commit-guard: guard source not found at $guard_src" >&2
  exit 1
fi

# Machine-local opt-in only: install solely into repos listed under `protect` in
# ~/.claude/branch-protection.json (override: AIOS_BRANCH_PROTECTION_CONFIG). The
# guard itself answers the scope question, so installer and guard cannot drift. It
# judges the PRIMARY checkout's root, so running this from a linked worktree of a
# protected repo installs into the shared hooks dir as before.
if ! (cd "$repo_root" && AIOS_PRIMARY_GUARD_SCOPE_CHECK=1 bash "$guard_src"); then
  scope_file="${AIOS_BRANCH_PROTECTION_CONFIG:-${HOME:-~}/.claude/branch-protection.json}"
  echo "install-primary-commit-guard: the primary checkout of $repo_root is not listed under \"protect\" in $scope_file — not installing."
  exit 0
fi

# Resolve the hooks dir honoring a custom core.hooksPath if set.
common_dir="$(git rev-parse --git-common-dir 2>/dev/null)"
if [[ "$common_dir" != /* ]]; then
  common_dir="$(cd "$common_dir" && pwd)"
fi
common_hooks_dir="$common_dir/hooks"
hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [[ -n "$hooks_path" ]]; then
  # core.hooksPath may be relative to the repo root.
  if [[ "$hooks_path" != /* ]]; then
    hooks_dir="$repo_root/$hooks_path"
  else
    hooks_dir="$hooks_path"
  fi
else
  hooks_dir="$common_hooks_dir"
fi

# TRACKED policy hook at the destination (AIO-638): leave it untouched and
# install the guard machine-locally into the common dir — the chain target the
# tracked hook execs. Marker is line-anchored to avoid false positives.
tracked_marker='^# aios-tracked-hook'
if [[ "$hooks_dir" != "$common_hooks_dir" && -f "$hooks_dir/pre-commit" ]] \
  && grep -q "$tracked_marker" "$hooks_dir/pre-commit" 2>/dev/null; then
  echo "install-primary-commit-guard: tracked pre-commit hook at $hooks_dir/pre-commit (core.hooksPath) — installing machine-local guard into $common_hooks_dir (chained by the tracked hook)."
  hooks_dir="$common_hooks_dir"
fi

mkdir -p "$hooks_dir"
dest="$hooks_dir/pre-commit"
chained="$hooks_dir/pre-commit.chained"

guard_marker="pre-commit-primary-guard"

# If a pre-commit already exists and is NOT our guard, preserve it as the chained
# hook (only the first time — don't clobber an already-saved chain). A stray copy
# of a TRACKED hook is never preserved: the tracked source still runs via
# core.hooksPath, and chaining a copy that itself chains this dir would recurse.
if [[ -f "$dest" ]] && ! grep -q "$guard_marker" "$dest" 2>/dev/null \
  && ! grep -q "$tracked_marker" "$dest" 2>/dev/null; then
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
