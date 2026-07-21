#!/usr/bin/env bash
# Vendors the domain-agnostic eval-lab core from aios-engineering-harness into
# ./evals here. See evals/README.md for the sync relationship and
# ../aios-engineering-harness/evals/CONTRACT.md for what's core vs. repo-specific.
#
# Usage:
#   scripts/sync-eval-lab.sh              dry-run: show what would change
#   scripts/sync-eval-lab.sh --apply      copy the core files + stamp the version marker
#
# Source repo path defaults to a sibling checkout; override with EVAL_LAB_SOURCE.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${EVAL_LAB_SOURCE:-$ROOT/../aios-engineering-harness}"
APPLY=false
[ "${1:-}" = "--apply" ] && APPLY=true

if [ ! -d "$SOURCE/evals" ]; then
  echo "eval-lab source not found at $SOURCE (set EVAL_LAB_SOURCE)" >&2
  exit 2
fi
command -v git >/dev/null 2>&1 || { echo "sync requires git" >&2; exit 3; }

SOURCE_SHA=$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || echo unknown)

# Core paths only — see CONTRACT.md in the source repo. Repo-specific adapter
# points (lib/install-harness.sh, drivers/mock.sh, scenarios/) are never synced;
# this repo owns its own versions of those.
CORE_FILES=(
  "evals/run.sh"
  "evals/judge.sh"
  "evals/judge.schema.json"
  "evals/lib/exec_timeout.py"
  "evals/lib/normalize_transcript.py"
  "evals/drivers/claude.sh"
  "evals/drivers/codex.sh"
  "evals/drivers/opencode.sh"
)

CHANGED=false
for REL in "${CORE_FILES[@]}"; do
  SRC_FILE="$SOURCE/$REL"
  DEST_FILE="$ROOT/$REL"
  if [ ! -f "$SRC_FILE" ]; then
    echo "missing in source, skipping: $REL" >&2
    continue
  fi
  if [ -f "$DEST_FILE" ] && cmp -s "$SRC_FILE" "$DEST_FILE"; then
    continue
  fi
  CHANGED=true
  if [ "$APPLY" = true ]; then
    mkdir -p "$(dirname "$DEST_FILE")"
    cp "$SRC_FILE" "$DEST_FILE"
    chmod --reference="$SRC_FILE" "$DEST_FILE" 2>/dev/null || true
    echo "synced: $REL"
  else
    echo "would sync: $REL"
    diff -u "$DEST_FILE" "$SRC_FILE" 2>/dev/null | head -20
  fi
done

if [ "$APPLY" = true ]; then
  printf 'source=%s\nsource_commit=%s\nsynced_files=%s\n' \
    "aiosbrain/aios-engineering-harness" "$SOURCE_SHA" "${#CORE_FILES[@]}" > "$ROOT/evals/.eval-lab-version"
  echo "wrote evals/.eval-lab-version (source_commit=$SOURCE_SHA)"
elif [ "$CHANGED" = true ]; then
  echo
  echo "dry run only — re-run with --apply to write these files"
else
  echo "up to date with $SOURCE_SHA"
fi
