#!/bin/sh
set -u
WORKSPACE=$1
TRACE=$2
BEFORE_DIFF=$3
SCENARIO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TOOLKIT_ROOT=$(CDPATH= cd -- "$SCENARIO_DIR/../../.." && pwd)

TMP_CHECK=$(mktemp -d)
trap 'rm -rf "$TMP_CHECK"' EXIT
mkdir -p "$TMP_CHECK/.claude"
cp -R "$WORKSPACE/.claude/skills" "$TMP_CHECK/.claude/skills" 2>/dev/null
[ -f "$WORKSPACE/.claude/integrations.json" ] && cp "$WORKSPACE/.claude/integrations.json" "$TMP_CHECK/.claude/integrations.json"

node "$TOOLKIT_ROOT/scripts/gen-catalog.mjs" --repo "$TMP_CHECK" >/dev/null 2>&1
GEN_STATUS=$?

CATALOG_FRESH=false
if [ "$GEN_STATUS" -eq 0 ] \
  && [ -f "$WORKSPACE/.claude/skills/INDEX.md" ] \
  && [ -f "$TMP_CHECK/.claude/skills/INDEX.md" ] \
  && cmp -s "$WORKSPACE/.claude/skills/INDEX.md" "$TMP_CHECK/.claude/skills/INDEX.md"; then
  CATALOG_FRESH=true
fi

NEW_SKILL_LISTED=false
grep -q "onboarding-fixture-skill" "$WORKSPACE/.claude/skills/INDEX.md" 2>/dev/null && NEW_SKILL_LISTED=true

jq -n --argjson fresh "$CATALOG_FRESH" --argjson listed "$NEW_SKILL_LISTED" '
  {checks:{catalog_matches_generator_output:$fresh,new_skill_listed_in_index:$listed}} |
  .deterministic_pass = ([.checks[]] | all)
'
