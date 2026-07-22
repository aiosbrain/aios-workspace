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
KEEP_WORKSPACES=false

usage() {
  echo "usage: bash evals/run.sh --runtime <claude|codex|opencode|mock> --scenario <id|all> --runs <n> [--model id] [--judge <runtime|none>] [--keep-workspaces]" >&2
}

cleanup_scratch() {
  [ "$KEEP_WORKSPACES" = true ] || rm -rf "$SCRATCH_DIR"
}

# Filesystem-level fingerprint of a scenario's forbidden_paths, independent of git
# visibility: a consumer's install-harness.sh may add its own scaffolding dirs to
# .git/info/exclude (this repo's does, for .harness/, .claude/, etc.), which would
# make a git-diff/status-based tamper check structurally blind to edits under
# those same paths.
fingerprint_forbidden() {
  WORKSPACE_ARG=$1
  PATHS_JSON=$2
  printf '%s' "$PATHS_JSON" | jq -r '.[]' | while IFS= read -r REL; do
    TARGET="$WORKSPACE_ARG/$REL"
    if [ -e "$TARGET" ]; then
      find "$TARGET" -type f -print0 2>/dev/null | xargs -0 cksum 2>/dev/null | sort
    else
      printf '%s: absent\n' "$REL"
    fi
  done
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
    --keep-workspaces) KEEP_WORKSPACES=true; shift ;;
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
    CANDIDATE_DIR=$(dirname "$MANIFEST")
    CANDIDATE_SEMANTIC=$(jq -r '.semantic_required // false' "$MANIFEST" 2>/dev/null || echo false)
    if [ -x "$CANDIDATE_DIR/setup.sh" ] && [ -x "$CANDIDATE_DIR/grade.sh" ] && [ -f "$CANDIDATE_DIR/prompt.md" ] \
      && { [ "$CANDIDATE_SEMANTIC" != true ] || [ -f "$CANDIDATE_DIR/rubric.md" ]; }; then
      SCENARIOS+=("$(basename "$CANDIDATE_DIR")")
    else
      echo "skipping incomplete scenario (missing setup.sh/grade.sh/prompt.md, or rubric.md for a semantic scenario): $(basename "$CANDIDATE_DIR")" >&2
    fi
  done
else
  SCENARIOS=("$SCENARIO")
fi

if [ ${#SCENARIOS[@]} -eq 0 ]; then
  echo "no scenarios matched (nothing under evals/scenarios/*/manifest.json is complete enough to run)" >&2
  exit 3
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
      cleanup_scratch
      continue
    fi

    if ! "$ROOT/evals/lib/install-harness.sh" "$ROOT" "$WORKSPACE" "$RUNTIME"; then
      jq -n --arg id "$RUN_ID" --arg scenario "$SCENARIO_ID" --arg runtime "$RUNTIME" \
        '{schema_version:"1.0",run_id:$id,scenario:$scenario,runtime:$runtime,status:"error",reason:"harness installation failed"}' > "$RUN_RECORD"
      RUN_RECORDS+=("$RUN_RECORD")
      cleanup_scratch
      continue
    fi
    mkdir -p "$(dirname "$WORK_TRACE")"
    : > "$WORK_TRACE"
    git -C "$WORKSPACE" diff HEAD --binary > "$BEFORE_DIFF"

    FORBIDDEN_PATHS=$(jq -c '.forbidden_paths // []' "$SCENARIO_DIR/manifest.json")
    FORBIDDEN_BEFORE=$(fingerprint_forbidden "$WORKSPACE" "$FORBIDDEN_PATHS")

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
    FORBIDDEN_AFTER=$(fingerprint_forbidden "$WORKSPACE" "$FORBIDDEN_PATHS")
    if [ "$FORBIDDEN_BEFORE" = "$FORBIDDEN_AFTER" ]; then FORBIDDEN_HIT=false; else FORBIDDEN_HIT=true; fi
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

    CHANGED_PATHS=$( { git -C "$WORKSPACE" diff --name-only --no-renames -z HEAD; git -C "$WORKSPACE" ls-files --others --exclude-standard -z; } \
      | jq -Rsc 'split("\u0000") | map(select(length > 0)) | unique')

    DETERMINISTIC=$(jq -r '.deterministic_pass' "$GRADE")
    JUDGE_STATUS=$(jq -r '.status' "$JUDGE_RECORD")
    EXIT_STATUS=$(jq -r '.exit_status' "$DRIVER_RECORD")
    MALFORMED=$(jq -r '.malformed // false' "$DRIVER_RECORD")
    if [ "$FORBIDDEN_HIT" = true ]; then STATUS=fail
    elif [ "$MALFORMED" = true ]; then STATUS=error
    elif [ "$EXIT_STATUS" -eq 127 ]; then STATUS=unavailable
    elif [ "$EXIT_STATUS" -eq 124 ]; then STATUS=timeout
    elif [ "$EXIT_STATUS" -ne 0 ]; then STATUS=error
    elif [ "$DETERMINISTIC" != true ]; then STATUS=fail
    elif [ "$JUDGE_STATUS" = fail ]; then STATUS=fail
    elif [ "$JUDGE_STATUS" = needs_review ]; then STATUS=needs_review
    else STATUS=pass
    fi

    TOOL_EVIDENCE=$(jq -s '
      {event_count:length,
       tool_counts:(map(select(.event != null) | (.tool_name // .event)) | group_by(.) | map({key:.[0],value:length}) | from_entries),
       checks:(map(select(.record_type == "check")) | length)}
    ' "$TRACE" 2>/dev/null || printf '%s' '{"event_count":0,"tool_counts":{},"checks":0}')

    jq -n --arg id "$RUN_ID" --arg scenario "$SCENARIO_ID" --arg status "$STATUS" \
      --arg workspace "$WORKSPACE" --arg trace "$TRACE" --arg hook_trace "$HOOK_TRACE" --arg before "$BEFORE_DIFF" --arg after "$AFTER_DIFF" \
      --argjson driver "$(cat "$DRIVER_RECORD")" --argjson grade "$(cat "$GRADE")" --argjson forbidden_hit "$FORBIDDEN_HIT" \
      --argjson judge "$(cat "$JUDGE_RECORD")" --argjson changed "$CHANGED_PATHS" --argjson evidence "$TOOL_EVIDENCE" '
      {schema_version:"1.0",run_id:$id,scenario:$scenario,status:$status,
       runtime:$driver.runtime,model:$driver.model,exit_status:$driver.exit_status,duration_ms:$driver.duration_ms,
       reason:($driver.reason // null),usage:$driver.usage,tool_evidence:$evidence,checks:$grade.checks,semantic_judge:$judge,
       changed_paths:$changed,forbidden_path_hit:$forbidden_hit,artifacts:{workspace:$workspace,trace:$trace,hook_trace:$hook_trace,before_diff:$before,after_diff:$after,
       transcript:($driver.transcript // null),final:($driver.final // null)}}
    ' > "$RUN_RECORD"
    RUN_RECORDS+=("$RUN_RECORD")
    echo "$RUN_ID: $STATUS"
    cleanup_scratch
  done
done

if [ ${#RUN_RECORDS[@]} -eq 0 ]; then
  echo "no run records were produced; refusing to run jq -s with zero file operands (would hang reading stdin)" >&2
  exit 3
fi

jq -s '
  {schema_version:"1.0",total:length,
   by_status:(group_by(.status) | map({key:.[0].status,value:length}) | from_entries),
   pass_rate:(if length == 0 then 0 else ([.[] | select(.status == "pass")] | length) / length end),
   runtimes:(group_by([.runtime,.model]) | map({runtime:.[0].runtime,model:.[0].model,runs:length,
     passed:([.[] | select(.status == "pass")] | length),duration_ms:(map(.duration_ms // 0) | add),
     tokens:(map(.usage.tokens // empty) | if length == 0 then null else add end),
     cost_usd:(map(.usage.cost_usd // empty) | if length == 0 then null else add end)})),
   runs:map({run_id,scenario,runtime,model,status,duration_ms,tool_evidence,usage,forbidden_path_hit})}
' "${RUN_RECORDS[@]}" > "$RESULTS_DIR/summary.json"

echo "results: $RESULTS_DIR/summary.json"
