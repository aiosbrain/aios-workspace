#!/bin/sh
set -u

START=$(date +%s)
STDOUT="$HARNESS_RUN_DIR/transcript.jsonl"
STDERR="$HARNESS_RUN_DIR/stderr.log"
FINAL="$HARNESS_RUN_DIR/final.md"
MODEL=${HARNESS_MODEL:-default}

if ! command -v codex >/dev/null 2>&1; then
  STATUS=127
else
  set -- codex exec --json --ephemeral --sandbox workspace-write --ignore-rules --enable hooks \
    --dangerously-bypass-hook-trust -c 'approval_policy="never"' \
    --output-last-message "$FINAL" -C "$HARNESS_WORKSPACE"
  [ "$MODEL" = "default" ] || set -- "$@" --model "$MODEL"
  set -- "$@" "$(cat "$HARNESS_PROMPT_FILE")"
  HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" \
    python3 "$HARNESS_ROOT/evals/lib/exec_timeout.py" "$HARNESS_TIMEOUT" "$STDOUT" "$STDERR" -- "$@"
  STATUS=$?
fi

END=$(date +%s)
USAGE=$(jq -s '
  ([.[] | select(.type == "turn.completed") | .usage] | last // {}) as $u |
  {tokens:(if ($u | length) == 0 then null else (($u.input_tokens // 0) + ($u.output_tokens // 0)) end),
   input_tokens:($u.input_tokens // null),cached_input_tokens:($u.cached_input_tokens // null),
   output_tokens:($u.output_tokens // null),reasoning_output_tokens:($u.reasoning_output_tokens // null),cost_usd:null}
' "$STDOUT" 2>/dev/null || printf '%s' '{"tokens":null,"cost_usd":null}')
jq -n --arg runtime codex --arg model "$MODEL" --arg transcript "$STDOUT" \
  --arg final "$FINAL" --arg stderr "$STDERR" --argjson exit_status "$STATUS" \
  --argjson duration_ms "$(( (END-START)*1000 ))" --argjson usage "$USAGE" \
  '{runtime:$runtime,model:$model,exit_status:$exit_status,duration_ms:$duration_ms,transcript:$transcript,final:$final,stderr:$stderr,usage:$usage}' \
  > "$HARNESS_DRIVER_RECORD"
exit "$STATUS"
