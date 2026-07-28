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
chain_dir="$hooks_dir/pre-push.chained.d"
marker="pre-push-leak-gate"
dispatcher_marker="aios-pre-push-chain-dispatcher"

# Keep every foreign hook. A single `.chained` slot loses the newest hook when another tool
# replaces `pre-push` after AIOS was installed, so the slot is a dispatcher over a private hook
# directory. Reinstalls deduplicate byte-identical hooks and never overwrite an earlier guard.
preserve_foreign_hook() {
  local source="$1" candidate saved
  [[ -f "$source" ]] || return 0
  mkdir -p "$chain_dir"
  for candidate in "$chain_dir"/*; do
    [[ -f "$candidate" ]] || continue
    if cmp -s "$source" "$candidate"; then
      return 0
    fi
  done
  saved=$(mktemp "$chain_dir/hook.XXXXXX")
  cp "$source" "$saved"
  chmod +x "$saved"
  echo "install-leak-gate-push-hook: preserved existing pre-push guard in $chain_dir"
}

if [[ -f "$chained" ]] && ! grep -q "$dispatcher_marker" "$chained" 2>/dev/null; then
  preserve_foreign_hook "$chained"
fi
if [[ -f "$dest" ]] && ! grep -q "$marker" "$dest" 2>/dev/null; then
  preserve_foreign_hook "$dest"
fi

if [[ -d "$chain_dir" ]]; then
  cat > "$chained" <<'DISPATCHER'
#!/usr/bin/env bash
# aios-pre-push-chain-dispatcher — preserve every pre-existing pre-push guard.
set -u
chain_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pre-push.chained.d"
updates=$(mktemp "${TMPDIR:-/tmp}/aios-pre-push-chain.XXXXXX")
trap 'rm -f "$updates"' EXIT
cat > "$updates"
for hook in "$chain_dir"/*; do
  [[ -x "$hook" ]] || continue
  "$hook" "$@" < "$updates"
  status=$?
  [[ "$status" -eq 0 ]] || exit "$status"
done
DISPATCHER
  chmod +x "$chained"
fi

cp "$hook_src" "$dest"
chmod +x "$dest"
echo "install-leak-gate-push-hook: installed push gate → $dest"
