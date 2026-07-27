#!/bin/sh
set -u

START=$(date +%s)
STDOUT="$HARNESS_RUN_DIR/transcript.json"
STDERR="$HARNESS_RUN_DIR/stderr.log"
MODEL=${HARNESS_MODEL:-default}

if ! command -v claude >/dev/null 2>&1; then
  STATUS=127
else
  set -- claude -p --output-format stream-json --verbose --include-hook-events \
    --permission-mode auto --max-turns 80 --no-session-persistence --setting-sources project
  [ "$MODEL" = "default" ] || set -- "$@" --model "$MODEL"
  set -- "$@" "$(cat "$HARNESS_PROMPT_FILE")"
  (
    cd "$HARNESS_WORKSPACE" || exit 3
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" \
      python3 "$HARNESS_ROOT/evals/lib/exec_timeout.py" "$HARNESS_TIMEOUT" "$STDOUT" "$STDERR" -- "$@"
  )
  STATUS=$?
  UNAVAILABLE_REASON=$(jq -rs '
    [.[] | select(.type == "result" and .is_error == true) | .result] | last // "" |
    select(test("credit balance|not authenticated|authentication|log in|login"; "i"))
  ' "$STDOUT" 2>/dev/null || true)
  [ -z "$UNAVAILABLE_REASON" ] || STATUS=127
fi

END=$(date +%s)
USAGE=$(jq -s '
  ([.[] | select(.type == "result")] | last // {}) as $r | ($r.usage // {}) as $u |
  {tokens:(if ($u | length) == 0 then null else (($u.input_tokens // 0) + ($u.output_tokens // 0)) end),
   input_tokens:($u.input_tokens // null),cache_read_input_tokens:($u.cache_read_input_tokens // null),
   output_tokens:($u.output_tokens // null),cost_usd:($r.total_cost_usd // null)}
' "$STDOUT" 2>/dev/null || printf '%s' '{"tokens":null,"cost_usd":null}')
jq -n --arg runtime claude --arg model "$MODEL" --arg transcript "$STDOUT" \
  --arg stderr "$STDERR" --arg reason "${UNAVAILABLE_REASON:-}" --argjson exit_status "$STATUS" \
  --argjson duration_ms "$(( (END-START)*1000 ))" --argjson usage "$USAGE" \
  '{runtime:$runtime,model:$model,exit_status:$exit_status,duration_ms:$duration_ms,transcript:$transcript,stderr:$stderr,usage:$usage}
   + (if $reason == "" then {} else {reason:$reason} end)' \
  > "$HARNESS_DRIVER_RECORD"
exit "$STATUS"
