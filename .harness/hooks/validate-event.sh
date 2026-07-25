#!/bin/sh
set -u

command -v jq >/dev/null 2>&1 || {
  echo "validate-event: jq not found" >&2
  exit 3
}

INPUT=$(cat 2>/dev/null || true)
[ -n "$INPUT" ] || {
  echo "validate-event: empty input" >&2
  exit 3
}

printf '%s' "$INPUT" | jq -e '
  type == "object" and
  (.protocol_version | IN("1.0", "1.1")) and
  (.event | IN("pre_edit", "pre_command", "post_edit", "stop", "session_start", "subagent_start", "user_prompt_submit")) and
  (.runtime | type == "object") and
  (.runtime.name | IN("claude", "codex", "opencode", "cursor", "mock")) and
  (.cwd | type == "string" and length > 0) and
  (if .event == "pre_edit" then
     (.paths | type == "array" and length > 0) and
     (.added_content | type == "array") and
     (all(.paths[]; (.path | type == "string" and length > 0) and
       (.action | IN("add", "update", "delete", "rename", "unknown")))) and
     (all(.added_content[]; (.path | type == "string" and length > 0) and
       (.content | type == "string")))
   elif .event == "pre_command" then
     (.command | type == "string" and length > 0)
   elif .event == "post_edit" then
     (.paths | type == "array" and length > 0) and
     all(.paths[]; (.path | type == "string" and length > 0) and
       (.action | IN("add", "update", "delete", "rename", "unknown")))
   elif .event == "session_start" then
     .protocol_version == "1.1" and
     (.session_start | type == "object") and
     (.session_start.phase | IN("startup", "resume", "compact"))
   elif .event == "subagent_start" then
     .protocol_version == "1.1" and
     (.subagent_start | type == "object") and
     (.subagent_start.agent_type == null or (.subagent_start.agent_type | type == "string")) and
     (.subagent_start.agent_id == null or (.subagent_start.agent_id | type == "string"))
   elif .event == "user_prompt_submit" then
     .protocol_version == "1.1" and
     (.prompt | type == "string")
   else
     (.stop | type == "object") and
     (.stop.verification_loop_active | type == "boolean") and
     (.stop.stop_status == null or (.stop.stop_status | IN("ok", "failed", "aborted", "error"))) and
     (.stop.loop_count == null or (.stop.loop_count | type == "number" and . >= 0 and floor == .))
   end)
' >/dev/null 2>&1 || {
  echo "validate-event: malformed or unsupported protocol event" >&2
  exit 3
}

printf '%s\n' "$INPUT"
