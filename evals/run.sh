#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME=""
SCENARIO=""
RUNS=1
MODEL=default
JUDGE=none
JUDGE_MODEL=default
TIMEOUT_OVERRIDE=""
RESULTS_DIR=""
MOCK_MODE=success

usage() {
  echo "usage: bash evals/run.sh --runtime <claude|codex|opencode|mock> --scenario <id|all> --runs <n> [--model id] [--judge <runtime|none>]" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME=${2:-}; shift 2 ;;
    --scenario) SCENARIO=${2:-}; shift 2 ;;
    --runs) RUNS=${2:-}; shift 2 ;;
    --model) MODEL=${2:-}; shift 2 ;;
    --judge) JUDGE=${2:-}; shift 2 ;;
    --judge-model) JUDGE_MODEL=${2:-}; shift 2 ;;
    --timeout) TIMEOUT_OVERRIDE=${2:-}; shift 2 ;;
    --results-dir) RESULTS_DIR=${2:-}; shift 2 ;;
    --mock-mode) MOCK_MODE=${2:-}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

case "$RUNTIME" in claude|codex|opencode|mock) ;; *) usage; exit 2 ;; esac
[ -n "$SCENARIO" ] || { usage; exit 2; }
case "$RUNS" in ''|*[!0-9]*) usage; exit 2 ;; esac
[ "$RUNS" -gt 0 ] || { usage; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "eval runner requires jq" >&2; exit 3; }
command -v python3 >/dev/null 2>&1 || { echo "eval runner requires python3" >&2; exit 3; }

if [ -z "$RESULTS_DIR" ]; then
  RESULTS_DIR="$ROOT/evals/results/$(date -u +%Y%m%dT%H%M%SZ)-$RUNTIME"
fi
mkdir -p "$RESULTS_DIR" "$ROOT/evals/scratch"
RESULTS_DIR=$(cd "$RESULTS_DIR" && pwd)

if [ "$SCENARIO" = all ]; then
  SCENARIOS=()
  for MANIFEST in "$ROOT"/evals/scenarios/*/manifest.json; do
    [ -f "$MANIFEST" ] || continue
    SCENARIOS+=("$(basename "$(dirname "$MANIFEST")")")
  done
else
  SCENARIOS=("$SCENARIO")
fi

RUN_RECORDS=()
for SCENARIO_ID in "${SCENARIOS[@]}"; do
  SCENARIO_DIR="$ROOT/evals/scenarios/$SCENARIO_ID"
  [ -f "$SCENARIO_DIR/manifest.json" ] || { echo "unknown scenario: $SCENARIO_ID" >&2; exit 2; }
  TIMEOUT=$(jq -r '.timeout_seconds' "$SCENARIO_DIR/manifest.json")
  [ -z "$TIMEOUT_OVERRIDE" ] || TIMEOUT=$TIMEOUT_OVERRIDE

  for ((INDEX=1; INDEX<=RUNS; INDEX++)); do
    RUN_ID="$SCENARIO_ID-$RUNTIME-$INDEX"
    RUN_DIR="$RESULTS_DIR/$RUN_ID"
    SCRATCH_DIR=$(mktemp -d "$ROOT/evals/scratch/$RUN_ID.XXXXXX")
    WORKSPACE="$SCRATCH_DIR/workspace"
    mkdir -p "$WORKSPACE" "$RUN_DIR"
    TRACE="$RUN_DIR/events.jsonl"
    HOOK_TRACE="$RUN_DIR/hook-events.jsonl"
    WORK_TRACE="$WORKSPACE/.eval/results/events.jsonl"
    DRIVER_RECORD="$RUN_DIR/driver.json"
    BEFORE_DIFF="$RUN_DIR/before.diff"
    AFTER_DIFF="$RUN_DIR/after.diff"
    GRADE="$RUN_DIR/grade.json"
    JUDGE_RECORD="$RUN_DIR/judge.json"
    RUN_RECORD="$RUN_DIR/run.json"

    (cd "$WORKSPACE" && "$SCENARIO_DIR/setup.sh")
    SETUP_STATUS=$?
    if [ "$SETUP_STATUS" -ne 0 ]; then
      jq -n --arg id "$RUN_ID" --arg scenario "$SCENARIO_ID" --arg runtime "$RUNTIME" \
        '{schema_version:"1.0",run_id:$id,scenario:$scenario,runtime:$runtime,status:"error",reason:"scenario setup failed"}' > "$RUN_RECORD"
      RUN_RECORDS+=("$RUN_RECORD")
      continue
    fi

    if ! "$ROOT/evals/lib/install-harness.sh" "$ROOT" "$WORKSPACE" "$RUNTIME"; then
      jq -n --arg id "$RUN_ID" --arg scenario "$SCENARIO_ID" --arg runtime "$RUNTIME" \
        '{schema_version:"1.0",run_id:$id,scenario:$scenario,runtime:$runtime,status:"error",reason:"harness installation failed"}' > "$RUN_RECORD"
      RUN_RECORDS+=("$RUN_RECORD")
      continue
    fi
    mkdir -p "$(dirname "$WORK_TRACE")"
    : > "$WORK_TRACE"
    git -C "$WORKSPACE" diff HEAD --binary > "$BEFORE_DIFF"

    DRIVER="$ROOT/evals/drivers/$RUNTIME.sh"
    HARNESS_ROOT="$ROOT" HARNESS_WORKSPACE="$WORKSPACE" HARNESS_SCENARIO="$SCENARIO_ID" \
      HARNESS_PROMPT_FILE="$SCENARIO_DIR/prompt.md" HARNESS_TRACE_FILE="$WORK_TRACE" \
      HARNESS_RUN_DIR="$RUN_DIR" HARNESS_DRIVER_RECORD="$DRIVER_RECORD" \
      HARNESS_MODEL="$MODEL" HARNESS_TIMEOUT="$TIMEOUT" HARNESS_MOCK_MODE="$MOCK_MODE" \
      "$DRIVER"
    DRIVER_STATUS=$?

    cp "$WORK_TRACE" "$HOOK_TRACE"
    TRANSCRIPT=$(jq -r '.transcript // empty' "$DRIVER_RECORD" 2>/dev/null || true)
    if [ -n "$TRANSCRIPT" ] && python3 "$ROOT/evals/lib/normalize_transcript.py" "$RUNTIME" "$TRANSCRIPT" "$TRACE" "$WORKSPACE" "$HOOK_TRACE"; then
      :
    else
      cp "$HOOK_TRACE" "$TRACE"
    fi

    git -C "$WORKSPACE" diff HEAD --binary > "$AFTER_DIFF"
    "$SCENARIO_DIR/grade.sh" "$WORKSPACE" "$TRACE" "$BEFORE_DIFF" > "$GRADE"
    GRADE_STATUS=$?
    [ "$GRADE_STATUS" -eq 0 ] && jq -e '.deterministic_pass | type == "boolean"' "$GRADE" >/dev/null 2>&1 || \
      jq -n '{checks:{grader_valid:false},deterministic_pass:false}' > "$GRADE"

    if ! jq -e 'type == "object" and (.runtime | type == "string")' "$DRIVER_RECORD" >/dev/null 2>&1; then
      jq -n --arg runtime "$RUNTIME" --argjson exit_status "$DRIVER_STATUS" \
        '{runtime:$runtime,model:"unknown",exit_status:$exit_status,duration_ms:0,usage:{tokens:null,cost_usd:null},malformed:true}' > "$DRIVER_RECORD"
    fi

    SEMANTIC_REQUIRED=$(jq -r '.semantic_required' "$SCENARIO_DIR/manifest.json")
    if [ "$SEMANTIC_REQUIRED" = true ]; then
      if [ "$JUDGE" = none ]; then
        jq -n '{status:"needs_review",reason:"This scenario requires semantic rubric grading and no judge was requested."}' > "$JUDGE_RECORD"
      else
        "$ROOT/evals/judge.sh" "$JUDGE" "$SCENARIO_DIR" "$RUN_DIR" "$DRIVER_RECORD" "$JUDGE_RECORD" "$JUDGE_MODEL" "$TIMEOUT"
      fi
    else
      jq -n '{status:"not_required",reason:"Deterministic evidence is sufficient for this scenario."}' > "$JUDGE_RECORD"
    fi

    DETERMINISTIC=$(jq -r '.deterministic_pass' "$GRADE")
    JUDGE_STATUS=$(jq -r '.status' "$JUDGE_RECORD")
    EXIT_STATUS=$(jq -r '.exit_status' "$DRIVER_RECORD")
    MALFORMED=$(jq -r '.malformed // false' "$DRIVER_RECORD")
    if [ "$MALFORMED" = true ]; then STATUS=error
    elif [ "$EXIT_STATUS" -eq 127 ]; then STATUS=unavailable
    elif [ "$EXIT_STATUS" -eq 124 ]; then STATUS=timeout
    elif [ "$EXIT_STATUS" -ne 0 ]; then STATUS=error
    elif [ "$DETERMINISTIC" != true ]; then STATUS=fail
    elif [ "$JUDGE_STATUS" = fail ]; then STATUS=fail
    elif [ "$JUDGE_STATUS" = needs_review ]; then STATUS=needs_review
    else STATUS=pass
    fi

    CHANGED_PATHS=$(git -C "$WORKSPACE" status --porcelain | awk '{print $2}' | jq -Rsc 'split("\n") | map(select(length > 0)) | unique')
    TOOL_EVIDENCE=$(jq -s '
      {event_count:length,
       tool_counts:(map(select(.event != null) | (.tool_name // .event)) | group_by(.) | map({key:.[0],value:length}) | from_entries),
       checks:(map(select(.record_type == "check")) | length)}
    ' "$TRACE" 2>/dev/null || printf '%s' '{"event_count":0,"tool_counts":{},"checks":0}')

    jq -n --arg id "$RUN_ID" --arg scenario "$SCENARIO_ID" --arg status "$STATUS" \
      --arg workspace "$WORKSPACE" --arg trace "$TRACE" --arg hook_trace "$HOOK_TRACE" --arg before "$BEFORE_DIFF" --arg after "$AFTER_DIFF" \
      --argjson driver "$(cat "$DRIVER_RECORD")" --argjson grade "$(cat "$GRADE")" \
      --argjson judge "$(cat "$JUDGE_RECORD")" --argjson changed "$CHANGED_PATHS" --argjson evidence "$TOOL_EVIDENCE" '
      {schema_version:"1.0",run_id:$id,scenario:$scenario,status:$status,
       runtime:$driver.runtime,model:$driver.model,exit_status:$driver.exit_status,duration_ms:$driver.duration_ms,
       reason:($driver.reason // null),usage:$driver.usage,tool_evidence:$evidence,checks:$grade.checks,semantic_judge:$judge,
       changed_paths:$changed,artifacts:{workspace:$workspace,trace:$trace,hook_trace:$hook_trace,before_diff:$before,after_diff:$after,
       transcript:($driver.transcript // null),final:($driver.final // null)}}
    ' > "$RUN_RECORD"
    RUN_RECORDS+=("$RUN_RECORD")
    echo "$RUN_ID: $STATUS"
  done
done

jq -s '
  {schema_version:"1.0",total:length,
   by_status:(group_by(.status) | map({key:.[0].status,value:length}) | from_entries),
   pass_rate:(if length == 0 then 0 else ([.[] | select(.status == "pass")] | length) / length end),
   runtimes:(group_by([.runtime,.model]) | map({runtime:.[0].runtime,model:.[0].model,runs:length,
     passed:([.[] | select(.status == "pass")] | length),duration_ms:(map(.duration_ms // 0) | add),
     tokens:(map(.usage.tokens // empty) | if length == 0 then null else add end),
     cost_usd:(map(.usage.cost_usd // empty) | if length == 0 then null else add end)})),
   runs:map({run_id,scenario,runtime,model,status,duration_ms,tool_evidence,usage})}
' "${RUN_RECORDS[@]}" > "$RESULTS_DIR/summary.json"

echo "results: $RESULTS_DIR/summary.json"
