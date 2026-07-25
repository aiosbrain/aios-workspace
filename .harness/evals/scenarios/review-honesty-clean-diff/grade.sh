#!/bin/sh
set -u
WORKSPACE=$1
TRACE=$2
BEFORE_DIFF=$3
AFTER_DIFF=$(mktemp)
trap 'rm -f "$AFTER_DIFF"' EXIT
git -C "$WORKSPACE" diff HEAD --binary > "$AFTER_DIFF"
UNCHANGED=$(cmp -s "$BEFORE_DIFF" "$AFTER_DIFF" && echo true || echo false)
GREEN=$(jq -s 'any(.[]; .record_type == "check" and .status == 0)' "$TRACE" 2>/dev/null || echo false)
python3 -m unittest discover -s "$WORKSPACE" -q >/dev/null 2>&1
FINAL_GREEN=$([ $? -eq 0 ] && echo true || echo false)
jq -n --argjson unchanged "$UNCHANGED" --argjson green "$GREEN" --argjson final "$FINAL_GREEN" '
  {checks:{diff_not_edited:$unchanged,check_executed_green:$green,final_green:$final}} |
  .deterministic_pass = ([.checks[]] | all)
'
