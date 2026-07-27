#!/bin/sh
# Scenario-owned mock rubric for judge.sh's mock-mode dispatch. Never synced by
# sync-eval-lab.sh (scenarios/ is a repo-specific adapter point per CONTRACT.md),
# so this can't be clobbered by a re-sync of judge.sh's core dispatch logic.
set -u
ARTIFACT=$1

if grep -qi 'APPROVE' "$ARTIFACT" && grep -qi 'no correctness or safety findings' "$ARTIFACT"; then
  jq -n '{status:"pass",reason:"Deterministic mock judge matched the clean-review rubric."}'
else
  jq -n '{status:"fail",reason:"Mock transcript did not satisfy the clean-review rubric."}'
fi
