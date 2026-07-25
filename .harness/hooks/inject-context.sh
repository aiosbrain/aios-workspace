#!/bin/sh
# inject-context.sh — portable session/subagent context builder (protocol 1.1).
#
# Input: a normalized `session_start` or `subagent_start` event on stdin.
# Output: exactly one action envelope on stdout —
#   {"protocol":"1.1","action":"context","text":"<agent-digest + skills index>"}
# Diagnostics go to stderr only. Exit 0 with an action, 3 when the event or local
# configuration cannot be evaluated (missing digest, oversized output, bad input).
#
# The text is the CONSTITUTION.md agent-digest block plus one line per real
# skills/*/SKILL.md (name — first sentence of description — absolute path).
# Containment: only files physically under the harness root are indexed; symlinked
# SKILL.md files are skipped (a symlink can escape the root). Malformed or oversized
# entries are skipped with a diagnostic. Total output is hard-capped at 8,000 bytes
# (below the strictest model-visible runtime allowance — Codex ~2,500 tokens);
# exceeding the cap is an explicit failure, never a silent truncation.
set -u

MAX_TOTAL_BYTES=8000
MAX_ENTRY_BYTES=512

command -v jq >/dev/null 2>&1 || {
  echo "inject-context: jq not found" >&2
  exit 3
}

INPUT=$(cat 2>/dev/null || true)
EVENT=$(printf '%s' "$INPUT" | jq -r '.event // ""' 2>/dev/null) || EVENT=""
case "$EVENT" in
  session_start|subagent_start) ;;
  *)
    echo "inject-context: unsupported event '${EVENT:-<none>}'" >&2
    exit 3
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -P -- "$SCRIPT_DIR/.." && pwd)

# When the pack is vendored at <repo>/.harness, install.sh seeds CONSTITUTION.md to
# the repo root and the repo owner customizes THAT copy — prefer it over the pack's
# own (possibly stale) template. Standalone/pack-repo layouts keep the local copy.
CONSTITUTION="$ROOT/CONSTITUTION.md"
if [ "$(basename -- "$ROOT")" = ".harness" ] && [ -f "$(dirname -- "$ROOT")/CONSTITUTION.md" ]; then
  CONSTITUTION="$(dirname -- "$ROOT")/CONSTITUTION.md"
fi
[ -f "$CONSTITUTION" ] || {
  echo "inject-context: $CONSTITUTION not found" >&2
  exit 3
}

# Both markers must exist — with the end marker missing, the sed range would run
# to EOF and silently inject far more than the digest.
grep -q '<!-- agent-digest:start -->' "$CONSTITUTION" && grep -q '<!-- agent-digest:end -->' "$CONSTITUTION" || {
  echo "inject-context: agent-digest start/end markers missing in CONSTITUTION.md" >&2
  exit 3
}
DIGEST=$(sed -n '/<!-- agent-digest:start -->/,/<!-- agent-digest:end -->/p' "$CONSTITUTION" \
  | sed '1d;$d')
[ -n "$DIGEST" ] || {
  echo "inject-context: agent-digest block missing or empty in CONSTITUTION.md" >&2
  exit 3
}

INDEX=""
SKILL_COUNT=0
for f in "$ROOT"/skills/*/SKILL.md; do
  [ -f "$f" ] || continue

  if [ -L "$f" ]; then
    echo "inject-context: skipping symlinked skill entry: $f" >&2
    continue
  fi
  DIR_PHYS=$(CDPATH= cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd) || {
    echo "inject-context: skipping unresolvable skill dir: $f" >&2
    continue
  }
  case "$DIR_PHYS/" in
    "$ROOT/skills/"*) ;;
    *)
      echo "inject-context: skipping skill entry outside harness root: $f" >&2
      continue
      ;;
  esac

  # Frontmatter = the block between the first two '---' lines. Read at most the
  # first 60 lines so a malformed giant file cannot stall the builder.
  FM=$(head -n 60 "$f" | awk '/^---[[:space:]]*$/ { n++; next } n == 1 { print } n >= 2 { exit }')
  NAME=$(printf '%s\n' "$FM" | sed -n 's/^name:[[:space:]]*//p' | head -n 1)
  [ -n "$NAME" ] || NAME=$(basename -- "$(dirname -- "$f")")
  DESC=$(printf '%s\n' "$FM" | sed -n 's/^description:[[:space:]]*//p' | head -n 1)
  if [ -z "$DESC" ]; then
    echo "inject-context: skipping skill with no frontmatter description: $f" >&2
    continue
  fi
  # First sentence only: cut at the first ". " (or trailing "."), strip quotes.
  SENTENCE=$(printf '%s' "$DESC" | sed -e 's/^["'\'']//' -e 's/\. .*$//' -e 's/\.$//')

  LINE="- $NAME — $SENTENCE ($DIR_PHYS/SKILL.md)"
  if [ "$(printf '%s' "$LINE" | wc -c)" -gt "$MAX_ENTRY_BYTES" ]; then
    echo "inject-context: skipping oversized skill entry: $f" >&2
    continue
  fi
  INDEX="$INDEX$LINE
"
  SKILL_COUNT=$((SKILL_COUNT + 1))
done

if [ "$SKILL_COUNT" -eq 0 ]; then
  INDEX="(no skills installed)
"
fi

TEXT="$DIGEST

Skills index — read the named SKILL.md in full before acting on a matching task:
$INDEX"

if [ "$(printf '%s' "$TEXT" | wc -c)" -gt "$MAX_TOTAL_BYTES" ]; then
  echo "inject-context: assembled context exceeds ${MAX_TOTAL_BYTES}-byte cap" >&2
  exit 3
fi

jq -cn --arg text "$TEXT" '{protocol: "1.1", action: "context", text: $text}'
