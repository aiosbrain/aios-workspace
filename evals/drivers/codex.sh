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
  # Only reclassify as "unavailable" when the process already failed AND produced no
  # structured turn output at all — i.e. it never got past startup. This keeps a
  # transient mid-run auth/rate-limit log line that the run recovers from (STATUS=0,
  # or real "type" events already in stdout) from being misreported, and confines the
  # keyword scan to stderr so legitimate agent transcript content (e.g. a security-
  # review scenario discussing "unauthorized access") in stdout is never matched.
  UNAVAILABLE_REASON=""
  if [ "$STATUS" -ne 0 ] && ! grep -q '"type"' "$STDOUT" 2>/dev/null; then
    UNAVAILABLE_REASON=$(grep -Eio 'not authenticated|not logged in|please log in|invalid api key|unauthorized|authentication required|rate limit exceeded|insufficient quota|quota exceeded' \
      "$STDERR" 2>/dev/null | head -1 || true)
  fi
  [ -z "$UNAVAILABLE_REASON" ] || STATUS=127
fi

END=$(date +%s)
USAGE=$(jq -s '
  ([.[] | select(.type == "turn.completed") | .usage] | last // {}) as $u |
  {tokens:(if ($u | length) == 0 then null else (($u.input_tokens // 0) + ($u.output_tokens // 0)) end),
   input_tokens:($u.input_tokens // null),cached_input_tokens:($u.cached_input_tokens // null),
   output_tokens:($u.output_tokens // null),reasoning_output_tokens:($u.reasoning_output_tokens // null),cost_usd:null}
' "$STDOUT" 2>/dev/null || printf '%s' '{"tokens":null,"cost_usd":null}')
jq -n --arg runtime codex --arg model "$MODEL" --arg transcript "$STDOUT" \
  --arg final "$FINAL" --arg stderr "$STDERR" --arg reason "${UNAVAILABLE_REASON:-}" --argjson exit_status "$STATUS" \
  --argjson duration_ms "$(( (END-START)*1000 ))" --argjson usage "$USAGE" \
  '{runtime:$runtime,model:$model,exit_status:$exit_status,duration_ms:$duration_ms,transcript:$transcript,final:$final,stderr:$stderr,usage:$usage}
   + (if $reason == "" then {} else {reason:$reason} end)' \
  > "$HARNESS_DRIVER_RECORD"
exit "$STATUS"
