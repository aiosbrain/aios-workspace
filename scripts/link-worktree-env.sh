#!/usr/bin/env bash
set -euo pipefail

# Hydrate a fresh git worktree with config from the primary checkout.
# Run from INSIDE the worktree after `git worktree add` — worktrees live in a
# per-repo container dir one level deeper than a plain sibling, e.g.:
#   <repo>-worktrees/<task>/  ->  ../../<repo>/scripts/link-worktree-env.sh
#
# `main_worktree` below is resolved via `git rev-parse --git-common-dir` (never
# a hardcoded relative path), so every symlink source built from it
# ("$main_worktree/$name") is an absolute path and this script works at any
# worktree depth.
common_dir="$(git rev-parse --git-common-dir)"
main_worktree="$(cd "$(dirname "$common_dir")" && pwd)"
here="$(pwd)"

if [[ "$main_worktree" == "$here" ]]; then
  echo "Already in the primary checkout ($here) — nothing to hydrate."
  exit 0
fi

scaffold="$main_worktree/scaffold"

# ── symlinks (safe to share from primary) ──────────────────────────────────
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

# ── config copies (each worktree gets its own, seeded from primary) ─────────

# opencode.json — permissions, agents, plugin
if [[ ! -e "$here/opencode.json" ]]; then
  if [[ -f "$main_worktree/opencode.json" ]]; then
    cp "$main_worktree/opencode.json" "$here/opencode.json"
    echo "copied opencode.json"
  elif [[ -f "$scaffold/opencode.json" ]]; then
    cp "$scaffold/opencode.json" "$here/opencode.json"
    echo "copied opencode.json (from scaffold)"
  fi
fi

# .claude/settings.json — hooks + rails allowlist. Always copy from primary
# (overwrites any git-tracked version — primary is source of truth).
# `aios asks wire` (run below) corrects hook paths for this worktree.
if [[ -f "$main_worktree/.claude/settings.json" ]]; then
  mkdir -p "$here/.claude"
  cp "$main_worktree/.claude/settings.json" "$here/.claude/settings.json"
  echo "copied .claude/settings.json"
elif [[ -f "$scaffold/.claude/settings.json" ]]; then
  mkdir -p "$here/.claude"
  cp "$scaffold/.claude/settings.json" "$here/.claude/settings.json"
  echo "copied .claude/settings.json (from scaffold)"
fi

# .claude/ — full directory: rules, skills, commands, agents, memory, personalities, rubrics, descriptors
for sub in rules skills commands agents memory personalities rubrics descriptors integrations.json; do
  src="$main_worktree/.claude/$sub"
  dest="$here/.claude/$sub"
  if [[ -e "$src" && ! -e "$dest" ]]; then
    mkdir -p "$(dirname "$dest")"
    ln -sfn "$src" "$dest"
    echo "linked .claude/$sub"
  fi
done

# CLAUDE.md / AGENTS.md — workspace operating manuals
for f in CLAUDE.md AGENTS.md; do
  if [[ ! -e "$here/$f" ]]; then
    if [[ -f "$scaffold/$f" ]]; then
      cp "$scaffold/$f" "$here/$f"
      echo "copied $f (from scaffold)"
    elif [[ -f "$scaffold/$f.tmpl" ]]; then
      cp "$scaffold/$f.tmpl" "$here/$f"
      echo "copied $f (from template)"
    fi
  fi
done

# .mcp.json — MCP server config
if [[ ! -e "$here/.mcp.json" && -f "$scaffold/.mcp.json" ]]; then
  cp "$scaffold/.mcp.json" "$here/.mcp.json"
  echo "copied .mcp.json"
fi

# .opencode/ — agents and plugins. The product Bugbot adapter is tracked, so the
# directory can already exist in a fresh worktree; fill only missing hydrated files.
# NB: `cp -Rn` is NOT safe here under `set -e`. BSD/macOS `cp -n` exits non-zero
# when it *declines* to overwrite an existing file (GNU `cp -n` exits 0), so on a
# fresh worktree — where .opencode/opencode.json + plugins/aios-bugbot.mjs are
# already checked out — it would abort the whole hydration mid-run. Copy each
# missing file individually instead: portable, preserves the fill-only-missing
# intent, and still lets a genuine copy failure (permissions, disk) surface
# rather than being swallowed by a blanket `|| true`.
if [[ -d "$scaffold/.opencode" ]]; then
  mkdir -p "$here/.opencode"
  while IFS= read -r -d '' src; do
    dest="$here/.opencode/${src#"$scaffold/.opencode/"}"
    [[ -e "$dest" ]] && continue
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  done < <(find "$scaffold/.opencode" -type f -print0)
  echo "hydrated .opencode/"
fi

# ── direnv ──────────────────────────────────────────────────────────────────
if command -v direnv >/dev/null 2>&1; then
  direnv allow "$here" || echo "direnv allow failed — run it manually if needed"
fi

# ── aios asks hooks ─────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1 && [[ -f "$main_worktree/scripts/aios.mjs" ]]; then
  node "$main_worktree/scripts/aios.mjs" asks wire --repo "$here" 2>/dev/null || echo "aios asks wire: skipped (CLI may not be built)"
fi

# ── operator-loop build ─────────────────────────────────────────────────────
# `aios loop`/asks/decisions/time/timeline/mode/maturity-week all require
# dist/operator-loop (compiled from src/operator-loop, src/timeline — see
# tsconfig.json). node_modules is symlinked above so tsc is available here;
# build it now so the worktree is demo-ready without a manual step. Best-effort
# and never fails the hydration — loadOperatorLoop()'s lazy self-heal is the
# runtime backstop if this is skipped or the src changes again later.
if command -v node >/dev/null 2>&1 && [[ -f "$here/scripts/ensure-loop-built.mjs" ]]; then
  (cd "$here" && node scripts/ensure-loop-built.mjs) || echo "operator-loop build: skipped (see message above)"
fi

echo ""
echo "Worktree $here is ready."
