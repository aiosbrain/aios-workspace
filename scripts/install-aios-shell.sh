#!/usr/bin/env bash
# install-aios-shell.sh — Idempotently install the aios() shell function.
#
# Finds an AIOS IC workspace by walking up from $PWD for aios.yaml, then runs
# bin/aios or scripts/aios.mjs. Works from any subdirectory; no npm run needed.
#
# Usage:
#   scripts/install-aios-shell.sh           # install to ~/.zshrc
#   scripts/install-aios-shell.sh --agent-workspace <path> # also persist the personal workspace
#   scripts/install-aios-shell.sh --dry-run # print the block only
#   scripts/install-aios-shell.sh --uninstall

set -euo pipefail

MARK_BEGIN="# >>> aios-shell begin >>>"
MARK_END="# <<< aios-shell end <<<"
ENV_MARK_BEGIN="# >>> aios-agent-workspace begin >>>"
ENV_MARK_END="# <<< aios-agent-workspace end <<<"
TARGET="${AIOS_SHELL_RC:-$HOME/.zshrc}"
ENV_TARGET="${AIOS_AGENT_ENV_FILE:-$HOME/.zshenv}"
dry_run=false
uninstall=false
agent_workspace=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) dry_run=true ;;
    --uninstall) uninstall=true ;;
    --agent-workspace)
      shift
      agent_workspace="${1:-}"
      [[ -n "$agent_workspace" ]] || { echo "--agent-workspace needs a path" >&2; exit 1; }
      ;;
    -h|--help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
  shift
done

if [[ -n "$agent_workspace" && ! -f "$agent_workspace/aios.yaml" ]]; then
  echo "--agent-workspace must point to a stamped workspace with aios.yaml: $agent_workspace" >&2
  exit 1
fi

workspace_export=""
if [[ -n "$agent_workspace" ]]; then
  workspace_export="export AIOS_AGENT_WORKSPACE=$(printf '%q' "$agent_workspace")"
fi

ENV_BLOCK=""
if [[ -n "$workspace_export" ]]; then
  ENV_BLOCK="$ENV_MARK_BEGIN
# AIOS personal workspace for non-interactive agent shells.
$workspace_export
$ENV_MARK_END"
fi

read -r -d '' BLOCK <<'EOF' || true
# >>> aios-shell begin >>>
# AIOS CLI — uses the nearest workspace, then the shared toolkit; installed by aios-workspace/scripts/install-aios-shell.sh
aios() {
  local dir="$PWD"
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/aios.yaml" ]]; then
      if [[ -x "$dir/bin/aios" ]]; then
        "$dir/bin/aios" "$@"
        return $?
      fi
      if [[ -f "$dir/scripts/aios.mjs" ]]; then
        node "$dir/scripts/aios.mjs" "$@"
        return $?
      fi
      echo "aios: found aios.yaml at $dir but no bin/aios or scripts/aios.mjs" >&2
      return 1
    fi
    dir="$(dirname "$dir")"
  done
  # Explicit config ALWAYS beats the conventional default — otherwise a legacy
  # AIOS_TOOLKIT_CLI user who also happens to have ~/Projects/aios/aios-workspace on disk
  # would silently run that checkout instead of the one they configured.
  local cli=""
  if [[ -n "${AIOS_TOOLKIT_DIR:-}" && -f "$AIOS_TOOLKIT_DIR/scripts/aios.mjs" ]]; then
    cli="$AIOS_TOOLKIT_DIR/scripts/aios.mjs"
  elif [[ -n "${AIOS_TOOLKIT_CLI:-}" && -f "$AIOS_TOOLKIT_CLI" ]]; then
    cli="$AIOS_TOOLKIT_CLI" # deprecated alias — prefer AIOS_TOOLKIT_DIR
  elif [[ -f "$HOME/Projects/aios/aios-workspace/scripts/aios.mjs" ]]; then
    cli="$HOME/Projects/aios/aios-workspace/scripts/aios.mjs"
  fi
  if [[ -n "$cli" ]]; then
    node "$cli" "$@"
    return $?
  fi
  echo "aios: no workspace found (walk up from cwd for aios.yaml)" >&2
  echo "  hint: cd into your IC workspace or set AIOS_TOOLKIT_DIR" >&2
  return 1
}
# <<< aios-shell end <<<
EOF

strip_block() {
  awk -v b="$2" -v e="$3" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    !skip { print }
  ' "$1"
}

replace_block() {
  local target="$1" begin="$2" end="$3" block="$4"
  touch "$target"
  if grep -qF "$begin" "$target" 2>/dev/null; then
    strip_block "$target" "$begin" "$end" > "${target}.tmp" && mv "${target}.tmp" "$target"
  fi
  printf '\n%s\n' "$block" >> "$target"
}

if $uninstall; then
  if [[ -f "$TARGET" ]]; then
    strip_block "$TARGET" "$MARK_BEGIN" "$MARK_END" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
    echo "Removed aios() from $TARGET"
  fi
  if [[ -f "$ENV_TARGET" ]]; then
    strip_block "$ENV_TARGET" "$ENV_MARK_BEGIN" "$ENV_MARK_END" > "${ENV_TARGET}.tmp" && mv "${ENV_TARGET}.tmp" "$ENV_TARGET"
    echo "Removed AIOS agent workspace from $ENV_TARGET"
  fi
  exit 0
fi

if $dry_run; then
  printf '%s\n' "$BLOCK"
  [[ -z "$ENV_BLOCK" ]] || printf '\n%s\n' "$ENV_BLOCK"
  exit 0
fi

replace_block "$TARGET" "$MARK_BEGIN" "$MARK_END" "$BLOCK"
if [[ -n "$ENV_BLOCK" ]]; then
  replace_block "$ENV_TARGET" "$ENV_MARK_BEGIN" "$ENV_MARK_END" "$ENV_BLOCK"
fi
echo "Installed aios() in $TARGET — run: source $TARGET"
