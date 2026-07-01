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

# Exclusions: VCS, this script, binaries, LICENSE (copyright holder), build output,
# vendored upstream skills, and deliberately-malicious scanner test fixtures.
EXCLUDES=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv
  --exclude-dir=__pycache__ --exclude-dir=store
  --exclude-dir=skill-library --exclude-dir=skill-scan-fixtures
  --exclude-dir=target
  --exclude-dir=evidence --exclude=.env --exclude=.env.local --exclude=.env.keys
  --exclude=.git --exclude=leak-gate.sh --exclude=leak-gate-terms.sh --exclude=LICENSE
  --exclude=*.png --exclude=*.jpg --exclude=*.pdf --exclude=*.lock)
# skill-library/ — vendored, integrity-locked official upstream skills (OGR09).
# skill-scan-fixtures/ — DELIBERATELY-malicious scanner test inputs; never shipped.
# target/ — Rust/Tauri build output; gitignored. evidence/ — gitignored UX harness output.
# .env* — local-only config (gitignored).
# (docs/strategy/ is NO LONGER excluded — this is an open project; strategy ships and is
#  scanned like everything else.)

fail=0
hit() { echo "LEAK: $1"; echo "$2" | sed 's/^/    /'; fail=1; }

if [ -n "${STRONG:-}" ]; then
  out=$(grep -rEIn "${EXCLUDES[@]}" -i -- "$STRONG" "$ROOT" 2>/dev/null || true)
  [ -n "$out" ] && hit "client/person/firm identifier (substring)" "$out"
fi
if [ -n "${WORDS:-}" ]; then
  out=$(grep -rEwIn "${EXCLUDES[@]}" -- "$WORDS" "$ROOT" 2>/dev/null || true)
  [ -n "$out" ] && hit "client/person identifier (word)" "$out"
fi
if [ -n "${PATTERNS:-}" ]; then
  out=$(grep -rEIn "${EXCLUDES[@]}" -- "$PATTERNS" "$ROOT" 2>/dev/null || true)
  [ -n "$out" ] && hit "business-data pattern (ticket/CO/invoice/amount)" "$out"
fi

if [ "$fail" -eq 0 ]; then
  echo "leak-gate: CLEAN — no forbidden identifiers found under $ROOT"
  exit 0
else
  echo "leak-gate: FAILED — forbidden identifiers above must be removed."
  exit 1
fi
