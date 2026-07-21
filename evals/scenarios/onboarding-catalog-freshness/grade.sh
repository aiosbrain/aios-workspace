#!/bin/sh
set -u
WORKSPACE=$1
TRACE=$2
BEFORE_DIFF=$3
SCENARIO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

CATALOG_FRESH=$(node "$SCENARIO_DIR/check-catalog-fresh.mjs" "$WORKSPACE" 2>/dev/null || echo false)

NEW_SKILL_LISTED=false
grep -q "onboarding-fixture-skill" "$WORKSPACE/.claude/skills/INDEX.md" 2>/dev/null && NEW_SKILL_LISTED=true

jq -n --argjson fresh "$CATALOG_FRESH" --argjson listed "$NEW_SKILL_LISTED" '
  {checks:{catalog_matches_generator_output:$fresh,new_skill_listed_in_index:$listed}} |
  .deterministic_pass = ([.checks[]] | all)
'
