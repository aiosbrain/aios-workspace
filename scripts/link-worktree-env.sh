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
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── symlinks (safe to share from primary) ──────────────────────────────────
# node_modules is special: a partial install in the primary makes every linked
# worktree partial too. Verify the lockfile-declared root dependencies and, when
# needed, restore the primary with npm ci BEFORE creating the shared link.
if [[ -f "$script_dir/worktree-init.mjs" ]]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "[aios] node is required to verify shared worktree dependencies; node_modules was not linked" >&2
    exit 1
  fi
  node "$script_dir/worktree-init.mjs" --primary "$main_worktree" --worktree "$here"
else
  src="$main_worktree/node_modules"
  if [[ -e "$src" && ! -e "$here/node_modules" ]]; then
    ln -sfn "$src" "$here/node_modules"
    echo "linked node_modules -> $src"
  fi
fi

for name in .envrc .env.keys .env; do
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

# .claude/settings.json — hooks + rails allowlist. Semantics (AIO-920):
#
#   * COMMITTED in the branch (HEAD has it): the branch's copy is authoritative.
#     Present on disk → leave it alone; missing/unreadable → RESTORE it from
#     HEAD (a bare skip would let a self-heal after an agent deletes the file
#     report success while the worktree runs with no guards and no rails
#     allowlist). Hydration must never impose the primary's copy: the file is
#     test-asserted (test/adapter-worktree-guard.test.mjs reads it from the
#     repo root), so the old always-copy made guard-test results depend on the
#     primary checkout's position — a stale primary produced a false RED
#     (AIO-751), and a primary ahead of the branch could green a genuinely
#     broken change.
#
#   * ABSENT from HEAD: seed only when nothing is on disk ([[ ! -e ]], matching
#     every other seeded file) — primary first, scaffold fallback. HEAD alone
#     cannot distinguish "branch predates the file" from "branch committed its
#     deletion"; seed-if-absent is the accepted trade, and it never overwrites
#     a file someone has put (or left) on disk.
#
# HEAD — not the index — is deliberate: a staged deletion (git rm --cached)
# keeps the branch content on disk and must not re-open the primary-copy path,
# and a merely staged, never-committed file must not be described as committed.
# Hydration exists to supply UNTRACKED local config (.envrc, .mcp.json,
# node_modules); a committed file comes from the branch. Re-runs (the
# per-session self-heal, hooks/worktree-self-heal.mjs) are no-ops on every
# already-present file, so nothing churns mtimes.
seed_settings_from() {
  mkdir -p "$here/.claude"
  cp "$1" "$here/.claude/settings.json"
  echo "copied .claude/settings.json$2"
}
if git -C "$here" cat-file -e "HEAD:.claude/settings.json" 2>/dev/null; then
  if [[ -f "$here/.claude/settings.json" && -r "$here/.claude/settings.json" ]]; then
    echo "skip .claude/settings.json — committed in this branch (branch copy wins)"
  else
    git -C "$here" checkout -- .claude/settings.json
    echo "restored .claude/settings.json from HEAD (branch copy wins)"
  fi
elif [[ ! -e "$here/.claude/settings.json" ]]; then
  if [[ -f "$main_worktree/.claude/settings.json" ]]; then
    seed_settings_from "$main_worktree/.claude/settings.json" ""
  elif [[ -f "$scaffold/.claude/settings.json" ]]; then
    seed_settings_from "$scaffold/.claude/settings.json" " (from scaffold)"
  fi
fi

# Staleness signal (AIO-1014): keeping the branch's committed settings.json is
# correct, but it pins the worktree to its branch-point hook set — a hook that
# landed on main later never reaches this worktree, and the skip above reads as
# success. Print a one-line "branch settings behind main" notice when main's
# committed hook list has entries the branch lacks. Read-only, never a rewrite
# (picking hooks up is a merge decision), and never fails hydration.
if command -v node >/dev/null 2>&1 && [[ -f "$main_worktree/scripts/worktree-settings-notice.mjs" ]]; then
  node "$main_worktree/scripts/worktree-settings-notice.mjs" --worktree "$here" || true
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
# --hydration: wire must never edit a settings.json committed in this branch's
# HEAD (AIO-920/AIO-1014 — the branch copy is authoritative; the staleness
# notice above is the signal for missing hooks). Untracked settings still get
# wired, `${CLAUDE_PROJECT_DIR}`-relative when the repo carries the hooks.
if command -v node >/dev/null 2>&1 && [[ -f "$main_worktree/scripts/aios.mjs" ]]; then
  node "$main_worktree/scripts/aios.mjs" asks wire --hydration --repo "$here" 2>/dev/null || echo "aios asks wire: skipped (CLI may not be built)"
fi

# ── native-module ABI guard ─────────────────────────────────────────────────
# node_modules is symlinked from the primary above, so this worktree runs the
# primary's compiled better_sqlite3.node. If the active Node's ABI differs from
# what that addon was built for (the classic ABI 127-vs-147 crash), the
# operator-loop DB tests fail for an environment-only reason. Probe it now and
# auto-rebuild or point at the pinned Node (.nvmrc). Do not stamp hydration as
# ready when the shared native dependency is still unusable.
if command -v node >/dev/null 2>&1 && [[ -f "$here/scripts/ensure-native-abi.mjs" ]]; then
  if ! (cd "$here" && node scripts/ensure-native-abi.mjs); then
    echo "native-abi: better-sqlite3 remains unusable; hydration was not marked ready" >&2
    exit 1
  fi
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

# ── hydration marker ────────────────────────────────────────────────────────
# Derived, disposable, per-worktree local state under the gitignored `.aios/`.
# Written once, last, atomically (write + rename); read only as a boolean
# "hydrated?" test by hooks/git/post-checkout and hooks/worktree-self-heal.mjs.
# Deleting it is always safe — the next session simply re-hydrates.
mkdir -p "$here/.aios"
printf 'hydrated-by=link-worktree-env.sh\nat=%s\nfrom=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$main_worktree" > "$here/.aios/.worktree-hydrated.tmp"
mv -f "$here/.aios/.worktree-hydrated.tmp" "$here/.aios/.worktree-hydrated"

echo ""
echo "Worktree $here is ready."
