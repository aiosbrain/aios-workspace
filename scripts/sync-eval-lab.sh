#!/usr/bin/env bash
# Vendors the domain-agnostic eval-lab core from aios-engineering-harness into
# ./evals here. See evals/README.md for the sync relationship and
# ../aios-engineering-harness/evals/CONTRACT.md for what's core vs. repo-specific.
#
# Usage:
#   scripts/sync-eval-lab.sh              dry-run: show what would change vs. the source's
#                                          current HEAD
#   scripts/sync-eval-lab.sh --apply      copy the core files + stamp the version marker
#   scripts/sync-eval-lab.sh --check      local dev tool: fails if a vendored core file has
#                                          drifted from the exact commit evals/.eval-lab-version
#                                          says it was synced from (i.e. someone hand-edited a
#                                          core file instead of going through this script).
#                                          Not wired into CI — it needs a sibling harness
#                                          checkout with that commit reachable, which a bare
#                                          CI runner doesn't have.
#
# Source repo path defaults to a sibling checkout; override with EVAL_LAB_SOURCE.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${EVAL_LAB_SOURCE:-$ROOT/../aios-engineering-harness}"
MODE=${1:-}
APPLY=false
[ "$MODE" = "--apply" ] && APPLY=true

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

if [ "$MODE" = "--check" ]; then
  PINNED_SHA=$(awk -F= '$1 == "source_commit" { print $2 }' "$ROOT/evals/.eval-lab-version" 2>/dev/null)
  if [ -z "$PINNED_SHA" ] || [ "$PINNED_SHA" = "unknown" ]; then
    echo "no usable source_commit in evals/.eval-lab-version — run --apply at least once first" >&2
    exit 2
  fi
  if ! git -C "$SOURCE" cat-file -e "$PINNED_SHA" 2>/dev/null; then
    echo "pinned commit $PINNED_SHA isn't reachable in $SOURCE (fetch it, or point EVAL_LAB_SOURCE elsewhere)" >&2
    exit 2
  fi
  DRIFTED=false
  for REL in "${CORE_FILES[@]}"; do
    DEST_FILE="$ROOT/$REL"
    PINNED_BLOB=$(git -C "$SOURCE" show "$PINNED_SHA:$REL" 2>/dev/null)
    if [ -z "$PINNED_BLOB" ]; then
      echo "warning: $REL didn't exist at pinned commit $PINNED_SHA, skipping" >&2
      continue
    fi
    if [ ! -f "$DEST_FILE" ] || [ "$(cat "$DEST_FILE" 2>/dev/null)" != "$PINNED_BLOB" ]; then
      echo "drifted from pinned commit: $REL" >&2
      DRIFTED=true
    fi
  done
  if [ "$DRIFTED" = true ]; then
    echo "one or more core files were hand-edited since the last sync-eval-lab.sh --apply" >&2
    exit 1
  fi
  echo "no drift from pinned commit $PINNED_SHA"
  exit 0
fi

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
    cp -p "$SRC_FILE" "$DEST_FILE"
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
