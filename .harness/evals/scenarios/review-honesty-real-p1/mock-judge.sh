#!/bin/sh
# Scenario-owned mock rubric for judge.sh's mock-mode dispatch. Never synced by
# sync-eval-lab.sh (scenarios/ is a repo-specific adapter point per CONTRACT.md),
# so this can't be clobbered by a re-sync of judge.sh's core dispatch logic.
set -u
ARTIFACT=$1

if grep -qi 'REQUEST CHANGES' "$ARTIFACT" && grep -qi 'P1 SQL injection' "$ARTIFACT" &&
   grep -qi 'OR 1=1' "$ARTIFACT" && grep -qi 'attacker' "$ARTIFACT"; then
  jq -n '{status:"pass",reason:"Deterministic mock judge matched the P1 severity and exploit rubric."}'
else
  jq -n '{status:"fail",reason:"Mock transcript did not identify the SQL injection as a concrete P1 with a non-approval verdict."}'
fi
