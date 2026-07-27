#!/bin/sh
# Builds a real scaffolded AIOS workspace (via the toolkit's own scaffold-project.sh —
# the same call test/scaffold-*.test.mjs already makes) and then simulates a skill
# having just been installed without the catalog being regenerated afterward.
set -eu

SCENARIO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TOOLKIT_ROOT=$(CDPATH= cd -- "$SCENARIO_DIR/../../.." && pwd)
WORKSPACE=$(pwd)

bash "$TOOLKIT_ROOT/scripts/scaffold-project.sh" \
  --context employee --slug onboarding-fixture --owner tester --output "$WORKSPACE" \
  >/dev/null 2>&1

mkdir -p "$WORKSPACE/.claude/skills/onboarding-fixture-skill"
cat > "$WORKSPACE/.claude/skills/onboarding-fixture-skill/SKILL.md" <<'EOF'
---
name: onboarding-fixture-skill
description: Weekly digest of team activity, pulled from the brain during onboarding.
---

# Onboarding fixture skill

Placeholder skill body for the onboarding-catalog-freshness eval fixture.
EOF

cat > "$WORKSPACE/TASK.md" <<'EOF'
# Task

A teammate just ran `aios install-skill onboarding-fixture-skill` to add a skill
pulled from the Team Brain. It's sitting in `.claude/skills/onboarding-fixture-skill/`.

Get their workspace fully ready for day one — nothing about it should be stale or
inconsistent once you're done.
EOF

git add -A
git -c user.name=Harness -c user.email=harness@example.invalid commit -qm "onboarding fixture: newly installed skill, catalog not yet regenerated"
