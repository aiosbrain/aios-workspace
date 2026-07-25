#!/usr/bin/env bash
# leak-gate.sh — confidentiality leak gate for the AIOS workspace toolkit.
#
# Scans the tree for any confidential identifier that must never appear in this
# open-source repository: client/firm names, person names, venture/product
# codenames, and business-data patterns. A clean run returns ZERO matches.
#
# IMPORTANT (public-repo design): the confidential term set is NOT stored in this
# repo — that would itself enumerate the protected identifiers. Terms load from a
# local, untracked file so the open-source tree never carries them:
#   1. $AIOS_LEAK_TERMS_FILE                  (explicit path), else
#   2. ~/.config/aios-nda/leak-gate-terms.sh  (default local install), else
#   3. $AIOS_LEAK_TERMS_B64                    (base64 of the same file — for CI via a repo secret)
# The terms file is shell-sourceable and defines three vars: STRONG, WORDS, PATTERNS
# (each a grep -E alternation). See leak-gate-terms.example.sh for the format.
#
# If no term set is configured, the gate runs in NO-OP mode (prints a notice, exits 0):
# the standing protection is the local write-time PreToolUse hook + the pre-commit hook,
# which read the same term file. Set $AIOS_LEAK_TERMS_B64 as a CI secret to enforce in CI too.
#
# Usage: scripts/leak-gate.sh [ROOT]   (defaults to repo root)
# Exit 0 = clean (or no term set configured); exit 1 = at least one forbidden term found.

set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

# ── load the confidential term set (never hardcoded in this public repo) ─────
TERMS_FILE="${AIOS_LEAK_TERMS_FILE:-$HOME/.config/aios-nda/leak-gate-terms.sh}"
if [ -f "$TERMS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$TERMS_FILE"
elif [ -n "${AIOS_LEAK_TERMS_B64:-}" ]; then
  # shellcheck disable=SC1090
  . <(printf '%s' "$AIOS_LEAK_TERMS_B64" | base64 --decode)
else
  echo "leak-gate: no term set configured (set \$AIOS_LEAK_TERMS_FILE, install" \
       "~/.config/aios-nda/leak-gate-terms.sh, or set \$AIOS_LEAK_TERMS_B64 in CI)."
  echo "leak-gate: SKIPPED — local write-time + pre-commit hooks still enforce."
  exit 0
fi

# ── enumerate scan targets via GIT, never a filesystem walk (AIO-517) ───────
# A recursive grep descends into gitignored build trees (`src-tauri/target` is 1.6 GB /
# 35k files) and dies of resource exhaustion — a scanner that fails by NOT finishing is
# worse than one that finds nothing. Git's file list (tracked + untracked-but-not-ignored)
# is exactly the content that can ever be published, and it makes every ignored tree
# structurally invisible instead of relying on an ad-hoc exclude list that drifts.
# Non-git targets (a single file from `aios promote`, a throwaway render dir from
# `aios timeline`, the change-set dir from `aios build`) keep the walk — they hold only
# the material being gated, so there is no ignored tree to descend into.
#
# Exclusions still applied on top: VCS, this script, binaries, LICENSE (copyright holder),
# vendored upstream skills, and deliberately-malicious scanner test fixtures.
# skill-library/ — vendored, integrity-locked official upstream skills (OGR09).
# skill-scan-fixtures/ — DELIBERATELY-malicious scanner test inputs; never shipped.
# target/ — Rust/Tauri build output; gitignored. evidence/ — gitignored UX harness output.
# .env* — local-only config (gitignored).
# (docs/strategy/ was deleted from the repo entirely (PR #336) — nothing strategy-related is
#  excluded; the full docs tree is scanned like everything else.)
FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/aios-leak-gate.XXXXXX")
trap 'rm -f "$FILE_LIST"' EXIT

# $1 = path relative to $ROOT. Emits the path to scan, NUL-terminated, when in scope.
emit_if_scannable() {
  case "/$1" in
    */.git/* | */node_modules/* | */.venv/* | */__pycache__/* | */store/*) return 0 ;;
    */skill-library/* | */skill-scan-fixtures/* | */target/* | */evidence/*) return 0 ;;
    */.git | */.env | */.env.local | */.env.keys) return 0 ;;
    */leak-gate.sh | */leak-gate-terms.sh | */LICENSE) return 0 ;;
    *.png | *.jpg | *.pdf | *.lock) return 0 ;;
  esac
  local abs="$ROOT/$1"
  [ -L "$abs" ] && return 0
  [ -f "$abs" ] || return 0
  printf '%s\0' "$abs"
}

if [ -d "$ROOT" ] && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  {
    git -C "$ROOT" ls-files -z
    git -C "$ROOT" ls-files -z -o --exclude-standard
  } | while IFS= read -r -d '' rel; do
    emit_if_scannable "$rel"
  done > "$FILE_LIST"
elif [ -d "$ROOT" ]; then
  find "$ROOT" -not -path "*/.git/*" -not -path "*/node_modules/*" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' abs; do
      emit_if_scannable "${abs#"$ROOT"/}"
    done > "$FILE_LIST" || true
else
  # A single file (aios promote scans one copied deliverable).
  printf '%s\0' "$ROOT" > "$FILE_LIST"
fi

fail=0
hit() { echo "LEAK: $1"; echo "$2" | sed 's/^/    /'; fail=1; }

# `grep -I` still skips binary files; the file list only decides WHICH files are opened.
# Guard the empty list: xargs with no input would run grep with no file operands, which
# reads stdin and hangs.
sweep() { # $1 = extra grep flag(s) or "", $2 = pattern
  [ -s "$FILE_LIST" ] || return 0
  # shellcheck disable=SC2086
  # -H is required: with an explicit file list, grep omits the filename prefix whenever a
  # batch happens to contain exactly one file (recursive grep always printed it), so a hit
  # in the last xargs batch would be reported with no path.
  xargs -0 grep -EInH $1 -e "$2" -- < "$FILE_LIST" 2>/dev/null || true
}

if [ -n "${STRONG:-}" ]; then
  out=$(sweep -i "$STRONG")
  [ -n "$out" ] && hit "client/person/firm identifier (substring)" "$out"
fi
if [ -n "${WORDS:-}" ]; then
  out=$(sweep -w "$WORDS")
  [ -n "$out" ] && hit "client/person identifier (word)" "$out"
fi
if [ -n "${PATTERNS:-}" ]; then
  out=$(sweep "" "$PATTERNS")
  [ -n "$out" ] && hit "business-data pattern (ticket/CO/invoice/amount)" "$out"
fi

if [ "$fail" -eq 0 ]; then
  echo "leak-gate: CLEAN — no forbidden identifiers found under $ROOT"
  exit 0
else
  echo "leak-gate: FAILED — forbidden identifiers above must be removed."
  exit 1
fi
