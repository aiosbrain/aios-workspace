#!/bin/sh
set -u

START=$(date +%s)
STDOUT="$HARNESS_RUN_DIR/transcript.jsonl"
STDERR="$HARNESS_RUN_DIR/stderr.log"
MODEL=${HARNESS_MODEL:-default}

if ! command -v opencode >/dev/null 2>&1; then
  STATUS=127
elif [ "$MODEL" = "default" ] && ! opencode debug agent build 2>/dev/null | jq -e '.model != null' >/dev/null; then
  UNAVAILABLE_REASON='OpenCode has no default model configured; pass --model <provider/model>.'
  printf '%s\n' "$UNAVAILABLE_REASON" > "$STDERR"
  : > "$STDOUT"
  STATUS=127
else
  set -- opencode run --format json --auto --dir "$HARNESS_WORKSPACE"
  [ "$MODEL" = "default" ] || set -- "$@" --model "$MODEL"
  set -- "$@" "$(cat "$HARNESS_PROMPT_FILE")"
  HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" \
    python3 "$HARNESS_ROOT/evals/lib/exec_timeout.py" "$HARNESS_TIMEOUT" "$STDOUT" "$STDERR" -- "$@"
  STATUS=$?
fi

END=$(date +%s)
USAGE=$(jq -s '
  [.[] | select(.type == "step_finish") | .part] as $steps |
  {tokens:(if ($steps | length) == 0 then null else ($steps | map(.tokens.total // 0) | add) end),
   input_tokens:(if ($steps | length) == 0 then null else ($steps | map(.tokens.input // 0) | add) end),
   output_tokens:(if ($steps | length) == 0 then null else ($steps | map(.tokens.output // 0) | add) end),
   reasoning_output_tokens:(if ($steps | length) == 0 then null else ($steps | map(.tokens.reasoning // 0) | add) end),
   cost_usd:(if ($steps | length) == 0 then null else ($steps | map(.cost // 0) | add) end)}
' "$STDOUT" 2>/dev/null || printf '%s' '{"tokens":null,"cost_usd":null}')
jq -n --arg runtime opencode --arg model "$MODEL" --arg transcript "$STDOUT" \
  --arg stderr "$STDERR" --arg reason "${UNAVAILABLE_REASON:-}" --argjson exit_status "$STATUS" \
  --argjson duration_ms "$(( (END-START)*1000 ))" --argjson usage "$USAGE" \
  '{runtime:$runtime,model:$model,exit_status:$exit_status,duration_ms:$duration_ms,transcript:$transcript,stderr:$stderr,usage:$usage}
   + (if $reason == "" then {} else {reason:$reason} end)' \
  > "$HARNESS_DRIVER_RECORD"
exit "$STATUS"
