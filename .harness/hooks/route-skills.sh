#!/bin/sh
# route-skills.sh — deterministic literal skill router (protocol 1.1).
#
# Input: a normalized `user_prompt_submit` event on stdin. Output: at most ONE
# `context` action pointing the agent at the single best-matching skill, or nothing
# (exit 0, empty stdout) when no trigger matches. Diagnostics go to stderr.
#
# Fixed semantics (never regex, never model-driven):
#   - each skill's frontmatter `triggers:` is a YAML block list of literal phrases;
#   - literals match case-insensitively as plain substrings of the prompt;
#   - the longest matched literal wins; equal lengths tie-break by skill name asc;
#   - the pointer carries the dedupe marker `<!-- aios-skill-route:<skill> -->`;
#     if the prompt already contains that marker for the winning skill, no action;
#   - prompts over PROMPT_CAP bytes are not scanned; pointer text over POINTER_CAP
#     is dropped (both: no action + stderr diagnostic);
#   - only SKILL.md files physically under the harness root are routable (symlinked
#     entries skipped); malformed `triggers:` lists are skipped with a diagnostic.
#
# `route-skills.sh --validate` checks every skills/*/SKILL.md instead: a missing,
# empty, inline-form, or non-literal `triggers:` list is a named error (exit 3).
set -u

PROMPT_CAP=32768
POINTER_CAP=2048

command -v jq >/dev/null 2>&1 || {
  echo "route-skills: jq not found" >&2
  exit 3
}

SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -P -- "$SCRIPT_DIR/.." && pwd)

# raw_trigger_items <file> — every "- item" line under triggers:, unfiltered.
# CRLF is stripped per line (a Windows checkout must not silently kill routing);
# frontmatter only counts when the opening fence is LINE 1 (no body smuggling).
raw_trigger_items() {
  head -n 80 "$1" | awk '
    { sub(/\r$/, "") }
    NR == 1 && $0 !~ /^---[[:space:]]*$/ { exit }
    /^---[[:space:]]*$/ { n++; next }
    n >= 2 { exit }
    n == 1 {
      if ($0 ~ /^triggers:[[:space:]]*$/) { t = 1; next }
      if (t == 1) {
        if ($0 ~ /^[[:space:]]+-[[:space:]]*[^[:space:]]/) {
          sub(/^[[:space:]]+-[[:space:]]*/, "")
          print
        } else if ($0 !~ /^[[:space:]]*(#.*)?$/) { t = 0 }
      }
    }'
}

# extract_triggers <file> — only PLAIN-SCALAR literals (quotes stripped). Nested
# maps (`- name: x`), flow collections (`- [a]`), block scalars (`- |`), and YAML
# anchors/aliases are NOT literal phrases and never become triggers.
extract_triggers() {
  raw_trigger_items "$1" | awk '
    /^[\[{|>&*]/ { next }
    /:[[:space:]]/ { next }
    /:$/ { next }
    {
      gsub(/^["'\''"]|["'\''"]$/, "")
      if ($0 != "") print
    }'
}

# has_triggers_key <file> — 0 when the frontmatter declares a triggers: key at all.
has_triggers_key() {
  head -n 80 "$1" | awk '
    { sub(/\r$/, "") }
    NR == 1 && $0 !~ /^---[[:space:]]*$/ { exit 1 }
    /^---[[:space:]]*$/ { n++; next }
    n >= 2 { exit (found ? 0 : 1) }
    n == 1 && /^triggers:/ { found = 1; exit }
    END { exit found ? 0 : 1 }'
}

# has_inline_triggers <file> — 0 when the FRONTMATTER (only) uses the inline form.
has_inline_triggers() {
  head -n 80 "$1" | awk '
    { sub(/\r$/, "") }
    NR == 1 && $0 !~ /^---[[:space:]]*$/ { exit 1 }
    /^---[[:space:]]*$/ { n++; next }
    n >= 2 { exit (found ? 0 : 1) }
    n == 1 && /^triggers:[[:space:]]*\[/ { found = 1; exit }
    END { exit found ? 0 : 1 }'
}

# --emit-map: print the literal trigger→skill routing map (used by install.sh to
# regenerate Cursor's always-apply rule — static-rule routing, Cursor's guaranteed
# path; never claimed as dynamic injection).
if [ "${1:-}" = "--emit-map" ]; then
  for f in "$ROOT"/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    [ -L "$f" ] && continue
    DIR_PHYS=$(CDPATH= cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd) || continue
    case "$DIR_PHYS/" in
      "$ROOT/skills/"*) ;;
      *) continue ;;
    esac
    NAME=$(basename -- "$DIR_PHYS")
    extract_triggers "$f" | awk -v n="$NAME" -v p="$DIR_PHYS/SKILL.md" \
      '$0 != "" { printf "- when the task mentions \"%s\", read %s in full before acting (skill `%s`)\n", $0, p, n }'
  done
  exit 0
fi

if [ "${1:-}" = "--validate" ]; then
  BAD=0
  for f in "$ROOT"/skills/*/SKILL.md; do
    [ -f "$f" ] || continue
    NAME=$(basename -- "$(dirname -- "$f")")
    if ! has_triggers_key "$f"; then
      echo "route-skills: $NAME: missing triggers: list in frontmatter" >&2
      BAD=1
      continue
    fi
    if has_inline_triggers "$f"; then
      echo "route-skills: $NAME: inline [..] triggers form is not allowed — use a block list" >&2
      BAD=1
      continue
    fi
    COUNT=$(extract_triggers "$f" | grep -c . || true)
    RAW_COUNT=$(raw_trigger_items "$f" | grep -c . || true)
    if [ "$COUNT" -eq 0 ]; then
      echo "route-skills: $NAME: triggers: list is empty or malformed" >&2
      BAD=1
    elif [ "$RAW_COUNT" -ne "$COUNT" ]; then
      echo "route-skills: $NAME: triggers: list contains non-scalar entries (maps/flow/block scalars are not literal phrases)" >&2
      BAD=1
    elif extract_triggers "$f" | LC_ALL=C grep -q '[^ -~]'; then
      # Printable-ASCII only: tabs break the candidate encoding, and non-ASCII
      # length/tolower semantics differ between BSD awk and gawk (nondeterministic
      # longest-match across platforms).
      echo "route-skills: $NAME: triggers must be printable ASCII (no tabs/control/non-ASCII characters)" >&2
      BAD=1
    fi
  done
  [ "$BAD" -eq 0 ] || exit 3
  echo "route-skills: triggers valid" >&2
  exit 0
fi

INPUT=$(cat 2>/dev/null || true)
EVENT=$(printf '%s' "$INPUT" | jq -r '.event // ""' 2>/dev/null) || EVENT=""
if [ "$EVENT" != "user_prompt_submit" ]; then
  echo "route-skills: unsupported event '${EVENT:-<none>}'" >&2
  exit 3
fi

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // ""')
[ -n "$PROMPT" ] || exit 0

if [ "$(printf '%s' "$PROMPT" | wc -c)" -gt "$PROMPT_CAP" ]; then
  echo "route-skills: prompt exceeds ${PROMPT_CAP}-byte cap — not scanned" >&2
  exit 0
fi

# Build "name<TAB>trigger<TAB>abs-path" candidate lines with the same containment
# rules as inject-context.sh.
CANDIDATES=""
for f in "$ROOT"/skills/*/SKILL.md; do
  [ -f "$f" ] || continue
  if [ -L "$f" ]; then
    echo "route-skills: skipping symlinked skill entry: $f" >&2
    continue
  fi
  DIR_PHYS=$(CDPATH= cd -P -- "$(dirname -- "$f")" 2>/dev/null && pwd) || continue
  case "$DIR_PHYS/" in
    "$ROOT/skills/"*) ;;
    *)
      echo "route-skills: skipping skill entry outside harness root: $f" >&2
      continue
      ;;
  esac
  NAME=$(basename -- "$DIR_PHYS")
  TRIGGERS=$(extract_triggers "$f")
  [ -n "$TRIGGERS" ] || continue
  CANDIDATES="$CANDIDATES$(printf '%s\n' "$TRIGGERS" | awk -v n="$NAME" -v p="$DIR_PHYS/SKILL.md" -F'\n' '$0 != "" { print n "\t" $0 "\t" p }')
"
done

[ -n "$CANDIDATES" ] || exit 0

# Single deterministic pass: literal, case-insensitive, longest-wins, name asc.
# Routing markers are metadata, not user text — strip them BEFORE matching so a
# marker's own "aios-skill-route:<name>" text can never win a trigger match. The
# ORIGINAL prompt is still what the winner's dedupe check below inspects.
ROUTE_PROMPT=$(printf '%s' "$PROMPT" | sed 's/<!-- aios-skill-route:[^>]*-->//g')
export ROUTE_PROMPT
WINNER=$(printf '%s' "$CANDIDATES" | awk -F'\t' '
  BEGIN { p = tolower(ENVIRON["ROUTE_PROMPT"]); bestlen = 0; bestname = ""; bestpath = "" }
  NF == 3 {
    t = tolower($2)
    if (t == "" || index(p, t) == 0) next
    l = length(t)
    if (l > bestlen || (l == bestlen && ($1 < bestname))) {
      bestlen = l; bestname = $1; bestpath = $3
    }
  }
  END { if (bestname != "") print bestname "\t" bestpath }')

[ -n "$WINNER" ] || exit 0
NAME=${WINNER%%	*}
SKILL_PATH=${WINNER#*	}

case "$PROMPT" in
  *"<!-- aios-skill-route:$NAME -->"*)
    # The EXACT emitted marker is present for this skill — never double-inject.
    # (Plain text mentioning "aios-skill-route:<name>-ish" strings is not a marker.)
    exit 0
    ;;
esac

POINTER="Task matches skill \`$NAME\` — read $SKILL_PATH in full before acting. <!-- aios-skill-route:$NAME -->"
if [ "$(printf '%s' "$POINTER" | wc -c)" -gt "$POINTER_CAP" ]; then
  echo "route-skills: pointer exceeds ${POINTER_CAP}-byte cap — dropped" >&2
  exit 0
fi

jq -cn --arg text "$POINTER" '{protocol: "1.1", action: "context", text: $text}'
