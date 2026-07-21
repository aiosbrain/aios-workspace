#!/bin/sh
set -u
WORKSPACE=$1
TRACE=$2
BEFORE_DIFF=$3

REPO_VALID=$([ -d "$WORKSPACE/.git" ] && echo true || echo false)
SOURCE_SKILL_PRESERVED=$([ -f "$WORKSPACE/1-inbox/from-brain/skills/weekly-digest/install.sh" ] && echo true || echo false)
INSTALLED=$([ -d "$WORKSPACE/.claude/skills/weekly-digest" ] && echo true || echo false)

jq -n --argjson repo_valid "$REPO_VALID" --argjson source_preserved "$SOURCE_SKILL_PRESERVED" --argjson installed "$INSTALLED" '
  {checks:{repo_valid:$repo_valid,source_skill_preserved:$source_preserved},
   facts:{installed_to_claude_skills:$installed}} |
  .deterministic_pass = ([.checks[]] | all)
'
