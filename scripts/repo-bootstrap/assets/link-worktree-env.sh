#!/usr/bin/env bash
set -euo pipefail

# link-worktree-env.sh — generic worktree hydrator, stamped by `aios repo-bootstrap`.
#
# Run from INSIDE a linked worktree after `git worktree add` (the stamped
# post-checkout hook runs it automatically for fresh worktrees). Self-contained:
# it references only THIS repo's primary checkout — never an adjacent toolkit.
#
# What it does:
#   - symlinks per-machine state (node_modules, .env*, .envrc) from the primary;
#   - copies .claude/settings.json from the primary when absent (worktree guard wiring);
#   - writes the .aios/.worktree-hydrated marker (read by the post-checkout hook).
#
# Deleting the marker is always safe — the next post-checkout simply re-hydrates.

common_dir="$(git rev-parse --git-common-dir)"
main_worktree="$(cd "$(dirname "$common_dir")" && pwd)"
here="$(pwd)"

if [[ "$main_worktree" == "$here" ]]; then
  echo "Already in the primary checkout ($here) — nothing to hydrate."
  exit 0
fi

# ── symlinks (safe to share from primary) ────────────────────────────────────
for name in node_modules .envrc .env.keys .env; do
  src="$main_worktree/$name"
  [[ -e "$src" ]] || continue
  if [[ -L "$here/$name" ]]; then
    echo "skip $name — already linked"
  elif [[ -e "$here/$name" ]]; then
    echo "skip $name — real file/dir already exists (not overwriting)"
  else
    ln -sfn "$src" "$here/$name"
    echo "linked $name -> $src"
  fi
done

# ── .claude/settings.json (guard hook wiring) — copy when absent ─────────────
if [[ ! -e "$here/.claude/settings.json" && -f "$main_worktree/.claude/settings.json" ]]; then
  mkdir -p "$here/.claude"
  cp "$main_worktree/.claude/settings.json" "$here/.claude/settings.json"
  echo "copied .claude/settings.json"
fi

# ── direnv ───────────────────────────────────────────────────────────────────
if command -v direnv >/dev/null 2>&1 && [[ -f "$here/.envrc" ]]; then
  direnv allow "$here" || echo "direnv allow failed — run it manually if needed"
fi

# ── hydration marker ─────────────────────────────────────────────────────────
# Written once, last, atomically (write + rename); read only as a boolean
# "hydrated?" test by the stamped post-checkout hook.
mkdir -p "$here/.aios"
printf 'hydrated-by=link-worktree-env.sh\nat=%s\nfrom=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$main_worktree" >"$here/.aios/.worktree-hydrated.tmp"
mv -f "$here/.aios/.worktree-hydrated.tmp" "$here/.aios/.worktree-hydrated"

echo ""
echo "Worktree $here is ready."
