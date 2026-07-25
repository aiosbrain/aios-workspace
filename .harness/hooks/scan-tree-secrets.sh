#!/usr/bin/env bash
# hooks/scan-tree-secrets.sh — whole-tree secret scan for CI.
#
# guard-secrets.sh is a stdin protocol-event hook (it inspects a single edit's
# added_content and exits 0 on empty content) — it is NOT a tree scanner and must
# never be repurposed as one. This script instead greps every file tracked by git
# against the same patterns in hooks/secret-patterns.txt, so a secret committed by
# any path (not just an agent-mediated edit) still fails CI.
#
# Usage:
#   hooks/scan-tree-secrets.sh              # scan this repo (git ls-files at $ROOT)
#   hooks/scan-tree-secrets.sh <dir>        # scan a supplied dir instead (must be a
#                                           # git work tree; used by the self-test)
#
# Exit 0 = clean. Exit 1 = at least one tracked file matched a secret pattern, or a
# setup problem (missing patterns file / not a git repo).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATTERNS_FILE="$ROOT/hooks/secret-patterns.txt"
SCAN_DIR="${1:-$ROOT}"

if [ ! -f "$PATTERNS_FILE" ]; then
  echo "scan-tree-secrets: patterns file not found: $PATTERNS_FILE" >&2
  exit 1
fi

if ! git -C "$SCAN_DIR" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "scan-tree-secrets: not a git work tree: $SCAN_DIR" >&2
  exit 1
fi

# Paths (relative to the scanned repo's toplevel) that are expected to contain
# secret-shaped patterns and must never fail the scan:
#   - the patterns file itself (its lines ARE the regexes, so they self-match)
#   - test fixtures, which by design assemble secret-shaped strings at runtime
#     (string concatenation) rather than committing literal ones, but are
#     allowlisted defensively in case a future fixture ever needs a literal
#     example value.
ALLOWLIST='^hooks/secret-patterns\.txt$
^evals/fixtures/'

FOUND=0
TOPLEVEL="$(git -C "$SCAN_DIR" rev-parse --show-toplevel)"
while IFS= read -r -d '' FILE; do
  if printf '%s\n' "$FILE" | grep -Eq -f <(printf '%s\n' "$ALLOWLIST"); then
    continue
  fi
  ABS="$TOPLEVEL/$FILE"
  [ -f "$ABS" ] || continue
  if grep -Eq -f "$PATTERNS_FILE" -- "$ABS" 2>/dev/null; then
    echo "POTENTIAL SECRET: $FILE" >&2
    grep -En -f "$PATTERNS_FILE" -- "$ABS" >&2 || true
    FOUND=1
  fi
done < <(git -C "$TOPLEVEL" ls-files -z)

if [ "$FOUND" -ne 0 ]; then
  echo "scan-tree-secrets: potential secrets found in tracked files (see above)" >&2
  exit 1
fi

echo "scan-tree-secrets: clean ($(git -C "$TOPLEVEL" ls-files | wc -l | tr -d ' ') tracked files scanned)"
exit 0
