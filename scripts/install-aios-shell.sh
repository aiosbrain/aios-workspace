#!/usr/bin/env bash
# install-aios-shell.sh — Idempotently install the aios() shell function.
#
# Finds an AIOS IC workspace by walking up from $PWD for aios.yaml, then runs
# bin/aios or scripts/aios.mjs. Works from any subdirectory; no npm run needed.
#
# Usage:
#   scripts/install-aios-shell.sh           # install to ~/.zshrc
#   scripts/install-aios-shell.sh --dry-run   # print the block only
#   scripts/install-aios-shell.sh --uninstall

set -euo pipefail

MARK_BEGIN="# >>> aios-shell begin >>>"
MARK_END="# <<< aios-shell end <<<"
TARGET="${AIOS_SHELL_RC:-$HOME/.zshrc}"

read -r -d '' BLOCK <<'EOF' || true
# >>> aios-shell begin >>>
# AIOS CLI — finds aios.yaml walking up from cwd; installed by aios-workspace/scripts/install-aios-shell.sh
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

dry_run=false
uninstall=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    --uninstall) uninstall=true ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

strip_block() {
  awk -v b="$MARK_BEGIN" -v e="$MARK_END" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    !skip { print }
  ' "$1"
}

if $uninstall; then
  [[ -f "$TARGET" ]] || exit 0
  strip_block "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
  echo "Removed aios() from $TARGET"
  exit 0
fi

if $dry_run; then
  printf '%s\n' "$BLOCK"
  exit 0
fi

touch "$TARGET"
if grep -qF "$MARK_BEGIN" "$TARGET" 2>/dev/null; then
  strip_block "$TARGET" > "${TARGET}.tmp" && mv "${TARGET}.tmp" "$TARGET"
fi
printf '\n%s\n' "$BLOCK" >> "$TARGET"
echo "Installed aios() in $TARGET — run: source $TARGET"
