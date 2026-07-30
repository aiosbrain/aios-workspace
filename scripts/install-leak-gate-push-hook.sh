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
#
# core.hooksPath repos with TRACKED policy hooks (AIO-638): when the resolved destination
# already carries the line-anchored `# aios-tracked-hook` marker (a version-controlled policy
# hook, e.g. aios-team-brain's `.githooks/`), this installer must NOT overwrite it — that
# clobbers a tracked file with an untracked copy. Instead the gate is installed machine-locally
# into `$(git rev-parse --git-common-dir)/hooks/`, which is exactly the chain target every
# tracked hook execs. When hooksPath is set but no tracked marker hook exists (older checkout),
# the legacy behavior (install into the hooksPath dir) is kept.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  echo "install-leak-gate-push-hook: not inside a git repo — aborting." >&2
  exit 1
fi

# Resolve the hooks dir honoring a custom core.hooksPath if set.
common_dir="$(git rev-parse --git-common-dir 2>/dev/null)"
if [[ "$common_dir" != /* ]]; then
  common_dir="$(cd "$common_dir" && pwd)"
fi
common_hooks_dir="$common_dir/hooks"
hooks_path="$(git config --get core.hooksPath 2>/dev/null || true)"
if [[ -n "$hooks_path" ]]; then
  if [[ "$hooks_path" != /* ]]; then
    hooks_dir="$repo_root/$hooks_path"
  else
    hooks_dir="$hooks_path"
  fi
else
  hooks_dir="$common_hooks_dir"
fi

# TRACKED policy hook at the destination (AIO-638): leave it untouched and install the gate
# machine-locally into the common dir — the chain target the tracked hook execs. Marker is
# line-anchored to avoid false positives.
tracked_marker='^# aios-tracked-hook'
if [[ "$hooks_dir" != "$common_hooks_dir" && -f "$hooks_dir/pre-push" ]] \
  && grep -q "$tracked_marker" "$hooks_dir/pre-push" 2>/dev/null; then
  echo "install-leak-gate-push-hook: tracked pre-push hook at $hooks_dir/pre-push (core.hooksPath) — installing machine-local gate into $common_hooks_dir (chained by the tracked hook)."
  hooks_dir="$common_hooks_dir"
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
old_chain_dir="$hooks_dir/pre-push.chained.d"
marker="pre-push-leak-gate"
dispatcher_marker="aios-pre-push-chain-dispatcher"

# Keep every foreign hook. A single `.chained` slot loses the newest hook when another tool
# replaces `pre-push` after AIOS was installed, so the slot dispatches to uniquely named siblings
# in the ORIGINAL hooks directory. Keeping dirname($0) stable preserves hooks that locate helper
# programs beside themselves. Reinstalls deduplicate byte-identical hooks.
preserve_foreign_hook() {
  local source="$1" candidate saved
  [[ -f "$source" ]] || return 0
  # Never preserve a stray copy of a TRACKED hook: the tracked source still runs via
  # core.hooksPath, and re-running a copy that itself chains this dir would recurse.
  if grep -q "$tracked_marker" "$source" 2>/dev/null; then
    return 0
  fi
  for candidate in "$hooks_dir"/pre-push.chained-hook.*; do
    [[ -f "$candidate" ]] || continue
    if cmp -s "$source" "$candidate"; then
      return 0
    fi
  done
  saved=$(mktemp "$hooks_dir/pre-push.chained-hook.XXXXXX")
  cp "$source" "$saved"
  chmod +x "$saved"
  echo "install-leak-gate-push-hook: preserved existing pre-push guard beside $dest"
}

# Migrate guards preserved by the first dispatcher design without deleting its directory:
# local hook state is user-owned, so migration copies and leaves recovery material intact.
if [[ -d "$old_chain_dir" ]]; then
  for old_hook in "$old_chain_dir"/*; do
    [[ -f "$old_hook" ]] || continue
    preserve_foreign_hook "$old_hook"
  done
fi
if [[ -f "$chained" ]] && ! grep -q "$dispatcher_marker" "$chained" 2>/dev/null; then
  preserve_foreign_hook "$chained"
fi
if [[ -f "$dest" ]] && ! grep -q "$marker" "$dest" 2>/dev/null; then
  preserve_foreign_hook "$dest"
fi

if compgen -G "$hooks_dir/pre-push.chained-hook.*" >/dev/null; then
  cat > "$chained" <<'DISPATCHER'
#!/usr/bin/env bash
# aios-pre-push-chain-dispatcher — preserve every pre-existing pre-push guard.
set -u
hooks_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
updates=$(mktemp "${TMPDIR:-/tmp}/aios-pre-push-chain.XXXXXX")
# `chain-slot.` deliberately does NOT match the installer's pre-push.chained-hook.* globs, so a
# slot can never be mistaken for a preserved hook.
slot=$(mktemp -d "$hooks_dir/pre-push.chain-slot.XXXXXX")
trap 'rm -f "$updates"; rm -rf "$slot"' EXIT
cat > "$updates"
# Mirror the real hooks dir beside the slot so dirname($0) still finds helper programs that a
# preserved hook expects next to itself.
for sibling in "$hooks_dir"/*; do
  [[ -e "$sibling" ]] || continue
  [[ "$sibling" == "$slot" ]] && continue
  [[ "$(basename "$sibling")" == "pre-push" ]] && continue
  if ! ln -s "$sibling" "$slot/$(basename "$sibling")"; then
    echo "pre-push-chain: cannot build a faithful hook slot; refusing to skip preserved guards." >&2
    exit 1
  fi
done
for hook in "$hooks_dir"/pre-push.chained-hook.*; do
  [[ -f "$hook" && -x "$hook" ]] || continue
  # Execute the preserved file directly, through a path named `pre-push`. The kernel then reads
  # its original shebang byte-for-byte (so interpreter flags such as `-e` survive), and the path
  # handed to execve keeps basename($0) canonical for hooks that dispatch on it. Reconstructing
  # an interpreter here is what silently dropped both guarantees.
  if ! ln -sfn "$hook" "$slot/pre-push"; then
    echo "pre-push-chain: cannot build a faithful hook slot; refusing to skip preserved guards." >&2
    exit 1
  fi
  "$slot/pre-push" "$@" < "$updates"
  status=$?
  [[ "$status" -eq 0 ]] || exit "$status"
done
DISPATCHER
  chmod +x "$chained"
fi

cp "$hook_src" "$dest"
chmod +x "$dest"
echo "install-leak-gate-push-hook: installed push gate → $dest"
