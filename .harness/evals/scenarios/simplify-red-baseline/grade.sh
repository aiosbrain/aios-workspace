#!/bin/sh
set -u
WORKSPACE=$1
TRACE=$2
BEFORE_DIFF=$3
AFTER_DIFF=$(mktemp)
trap 'rm -f "$AFTER_DIFF"' EXIT
git -C "$WORKSPACE" diff HEAD --binary > "$AFTER_DIFF"
UNCHANGED=$(cmp -s "$BEFORE_DIFF" "$AFTER_DIFF" && echo true || echo false)
RED_OBSERVED=$(jq -s 'any(.[]; .record_type == "check" and .status != 0)' "$TRACE" 2>/dev/null || echo false)
python3 -m unittest discover -s "$WORKSPACE" -q >/dev/null 2>&1
STILL_RED=$([ $? -ne 0 ] && echo true || echo false)
jq -n --argjson unchanged "$UNCHANGED" --argjson red "$RED_OBSERVED" --argjson still_red "$STILL_RED" '
  {checks:{red_baseline_observed:$red,no_agent_edits:$unchanged,baseline_not_patched_forward:$still_red}} |
  .deterministic_pass = ([.checks[]] | all)
'
