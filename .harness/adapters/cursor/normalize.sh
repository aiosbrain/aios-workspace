#!/bin/sh
# Cursor -> harness protocol 1.0 normalizer.
#
# Cursor hook payloads (stdin JSON) are mapped to the runtime-neutral event contract.
# Cursor honors exit code 2 = deny (== permission "deny"), so the safety policies'
# native exit codes flow straight through run-hook.sh — no permission-JSON needed for
# pre_command / pre_edit / post_edit. Only `stop` needs a {followup_message} response;
# that translation lives in cursor/stop-gate.sh, not here.
#
# Event mapping (see cursor/README.md):
#   pre_command <- beforeShellExecution   {command, cwd}
#   pre_edit    <- preToolUse (Write|Edit) {tool_name, tool_input, cwd}
#   post_edit   <- afterFileEdit          {file_path, edits}
#   stop        <- stop                   {status, loop_count}
# afterFileEdit / stop carry no cwd, so ${CURSOR_PROJECT_DIR:-$PWD} is the fallback.
set -u

EVENT=${1:-}
command -v jq >/dev/null 2>&1 || { echo "cursor adapter: jq not found" >&2; exit 3; }

INPUT=$(cat 2>/dev/null || true)
printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1 || {
  echo "cursor adapter: malformed JSON payload" >&2; exit 3; }

CWD_DEFAULT=${CURSOR_PROJECT_DIR:-${PWD:-.}}

case "$EVENT" in
  pre_command)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "$CWD_DEFAULT" '
      {
        protocol_version:"1.0", event:"pre_command", runtime:{name:"cursor"},
        cwd:(.cwd // $cwd), session_id:(.conversation_id // ""),
        tool_name:(.tool_name // "Shell"), tool_id:(.tool_use_id // ""),
        command:(.command // .tool_input.command // "")
      }' 2>/dev/null) || exit 3
    ;;
  pre_edit)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "$CWD_DEFAULT" '
      (.tool_input // {}) as $ti |
      ($ti.file_path // $ti.filePath // $ti.path // $ti.target_file //
        .file_path // .filePath // "") as $p |
      ([
        $ti.content, $ti.new_string, $ti.newString,
        $ti.edits[]?.new_string, $ti.edits[]?.newString,
        .content, .new_string, .newString,
        .edits[]?.new_string, .edits[]?.newString
      ] | map(select(type == "string" and length > 0)) | join("\n")) as $c |
      {
        protocol_version:"1.0", event:"pre_edit", runtime:{name:"cursor"},
        cwd:(.cwd // $cwd), session_id:(.conversation_id // ""),
        tool_name:(.tool_name // "Write"), tool_id:(.tool_use_id // ""),
        paths:(if $p == "" then [] else [{path:$p, action:"update"}] end),
        added_content:(if ($p == "" or $c == "") then [] else [{path:$p, content:$c}] end)
      }' 2>/dev/null) || exit 3
    ;;
  post_edit)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "$CWD_DEFAULT" '
      (.file_path // .tool_input.file_path // "") as $p |
      {
        protocol_version:"1.0", event:"post_edit", runtime:{name:"cursor"},
        cwd:(.cwd // $cwd), session_id:(.conversation_id // ""),
        tool_name:(.tool_name // "Edit"), tool_id:(.tool_use_id // ""),
        paths:(if $p == "" then [] else [{path:$p, action:"update"}] end)
      }' 2>/dev/null) || exit 3
    ;;
  stop)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "$CWD_DEFAULT" '
      {
        protocol_version:"1.0", event:"stop", runtime:{name:"cursor"},
        cwd:$cwd, session_id:(.conversation_id // ""),
        stop:{
          verification_loop_active:((.loop_count // 0) > 0),
          stop_status:(if (.status // "") | IN("aborted", "error") then .status else "ok" end),
          loop_count:(.loop_count // 0)
        }
      }' 2>/dev/null) || exit 3
    ;;
  session_start)
    # Cursor sessionStart has no startup/resume/compact discriminator; every
    # invocation is normalized as a fresh startup injection.
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "$CWD_DEFAULT" '
      {
        protocol_version:"1.1", event:"session_start", runtime:{name:"cursor"},
        cwd:$cwd, session_id:(.conversation_id // ""),
        session_start:{phase:"startup"}
      }' 2>/dev/null) || exit 3
    ;;
  *)
    echo "cursor adapter: unsupported event '$EVENT'" >&2
    exit 3
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s' "$NORMALIZED" | "$SCRIPT_DIR/../../hooks/validate-event.sh"
