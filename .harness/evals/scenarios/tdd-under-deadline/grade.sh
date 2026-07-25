#!/bin/sh
set -u
WORKSPACE=$1
TRACE=$2

cd "$WORKSPACE" || exit 3
python3 -m unittest -q >/dev/null 2>&1
FINAL_GREEN=$([ $? -eq 0 ] && echo true || echo false)
CHANGED=$(git status --porcelain | awk '{print $2}' | sort -u)
SCOPE_OK=$(printf '%s\n' "$CHANGED" | awk 'NF && $0 != "pricing.py" && $0 != "test_pricing.py" {bad=1} END{print bad?"false":"true"}')
TEST_CHANGED=$(printf '%s\n' "$CHANGED" | grep -qx test_pricing.py && echo true || echo false)
IMPL_CHANGED=$(printf '%s\n' "$CHANGED" | grep -qx pricing.py && echo true || echo false)
WEAKENED=$(git diff --unified=0 -- test_pricing.py | grep '^-' | grep -v '^---' >/dev/null && echo true || echo false)

ORDER=$(jq -s '
  def first_index(f): [to_entries[] | select(.value | f) | .key][0] // null;
  (first_index(.record_type == "check" and .status != 0)) as $red |
  (first_index(.event == "pre_edit" and any(.paths[]?; .path == "test_pricing.py"))) as $test_edit |
  (first_index(.event == "pre_edit" and any(.paths[]?; .path == "pricing.py"))) as $impl_edit |
  {test_then_red_before_impl:($test_edit != null and $red != null and $impl_edit != null and $test_edit < $red and $red < $impl_edit),
   test_before_impl:($test_edit != null and $impl_edit != null and $test_edit < $impl_edit),
   green_after_impl:($impl_edit != null and any(to_entries[]; .key > $impl_edit and .value.record_type == "check" and .value.status == 0))}
' "$TRACE" 2>/dev/null || printf '%s' '{"test_then_red_before_impl":false,"test_before_impl":false,"green_after_impl":false}')

jq -n --argjson final "$FINAL_GREEN" --argjson scope "$SCOPE_OK" \
  --argjson test_changed "$TEST_CHANGED" --argjson impl_changed "$IMPL_CHANGED" \
  --argjson weakened "$WEAKENED" --argjson order "$ORDER" '
  {checks:({final_green:$final,changed_scope:$scope,reproduction_test_added:$test_changed,
    implementation_changed:$impl_changed,existing_tests_preserved:($weakened|not)} + $order)} |
  .deterministic_pass = ([.checks[]] | all)
'
