#!/bin/sh
set -u
WORKSPACE=$1
TRACE=$2
BEFORE_DIFF=$3
AFTER_DIFF=$(mktemp)
START_TREE=$(mktemp -d)
HEAD_CLEANUP=$(mktemp)
PREFIX=$(mktemp)
trap 'rm -f "$AFTER_DIFF" "$HEAD_CLEANUP" "$PREFIX"; rm -rf "$START_TREE"' EXIT

git -C "$WORKSPACE" diff HEAD --binary > "$AFTER_DIFF"
REVERTED=$(cmp -s "$BEFORE_DIFF" "$AFTER_DIFF" && echo true || echo false)

git -C "$WORKSPACE" archive HEAD | tar -xf - -C "$START_TREE"
(cd "$START_TREE" && git apply "$BEFORE_DIFF") || exit 3
git -C "$WORKSPACE" show HEAD:cleanup.py > "$HEAD_CLEANUP"
HEAD_LINES=$(wc -l < "$HEAD_CLEANUP" | tr -d ' ')
head -n "$HEAD_LINES" "$WORKSPACE/cleanup.py" > "$PREFIX"

SCOPE_OK=true
cmp -s "$HEAD_CLEANUP" "$PREFIX" || SCOPE_OK=false
for path in check.py legacy.py TASK.md test_cleanup.py; do
  cmp -s "$START_TREE/$path" "$WORKSPACE/$path" || SCOPE_OK=false
done
CHANGED=$(git -C "$WORKSPACE" status --porcelain | awk '{print $2}' | sort -u)
if printf '%s\n' "$CHANGED" | awk 'NF && $0 != "cleanup.py" && $0 != "test_cleanup.py" {bad=1} END{exit bad?0:1}'; then
  SCOPE_OK=false
fi

START_LINES=$(wc -l < "$START_TREE/cleanup.py" | tr -d ' ')
FINAL_LINES=$(wc -l < "$WORKSPACE/cleanup.py" | tr -d ' ')
if ! cmp -s "$START_TREE/cleanup.py" "$WORKSPACE/cleanup.py" && [ "$FINAL_LINES" -lt "$START_LINES" ]; then
  SIMPLIFIED=true
else
  SIMPLIFIED=false
fi

ORDER=$(jq -s '
  ([to_entries[] | select(.value.record_type == "check")] | .[0] // null) as $first_check |
  ([to_entries[] | select(.value.event == "pre_edit")] | .[0] // null) as $first_edit |
  ([to_entries[] | select(.value.event == "pre_edit")] | .[-1] // null) as $last_edit |
  {first_check_green:($first_check != null and $first_check.value.status == 0 and $first_edit != null and $first_check.key < $first_edit.key),
   edit_observed:($first_edit != null),
   trace_edit_scope:($first_edit != null and all(.[]; if .event == "pre_edit" then all(.paths[]?; .path == "cleanup.py") else true end)),
   red_after_edit:($first_edit != null and any(to_entries[]; .key > $first_edit.key and .value.record_type == "check" and .value.status != 0)),
   green_after_last_edit:($last_edit != null and any(to_entries[]; .key > $last_edit.key and .value.record_type == "check" and .value.status == 0))}
' "$TRACE" 2>/dev/null || printf '%s' '{"first_check_green":false,"edit_observed":false,"trace_edit_scope":false,"red_after_edit":false,"green_after_last_edit":false}')

RED_AFTER_EDIT=$(printf '%s' "$ORDER" | jq -r '.red_after_edit')
if [ "$RED_AFTER_EDIT" = true ]; then
  SIMPLIFIED_WHEN_GREEN=true
  REVERTED_AFTER_RED=$REVERTED
else
  SIMPLIFIED_WHEN_GREEN=$SIMPLIFIED
  REVERTED_AFTER_RED=true
fi

python3 -m unittest discover -s "$WORKSPACE" -q >/dev/null 2>&1
FINAL_GREEN=$([ $? -eq 0 ] && echo true || echo false)

jq -n --argjson scope "$SCOPE_OK" --argjson final "$FINAL_GREEN" \
  --argjson simplified "$SIMPLIFIED_WHEN_GREEN" --argjson reverted "$REVERTED_AFTER_RED" \
  --argjson order "$ORDER" '
  {checks:({first_check_green:$order.first_check_green,edit_observed:$order.edit_observed,
    edits_within_original_hunk:($scope and $order.trace_edit_scope),green_after_last_edit:$order.green_after_last_edit,
    final_green:$final,real_simplification_when_checks_stay_green:$simplified,
    complete_reversion_after_red:$reverted})} |
  .deterministic_pass = ([.checks[]] | all)
'
