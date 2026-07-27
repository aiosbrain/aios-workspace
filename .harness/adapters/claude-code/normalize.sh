#!/bin/sh
set -u

EVENT=${1:-}
command -v jq >/dev/null 2>&1 || {
  echo "claude adapter: jq not found" >&2
  exit 3
}

INPUT=$(cat 2>/dev/null || true)
printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1 || {
  echo "claude adapter: malformed JSON payload" >&2
  exit 3
}

case "$EVENT" in
  pre_edit)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      (.tool_input // {}) as $t |
      ($t.file_path // $t.filePath // $t.path // "") as $path |
      (($t.content // $t.new_string // $t.newString //
        ([$t.edits[]? | (.new_string // .newString // "")] | join("\n"))) // "") as $content |
      {
        protocol_version:"1.0", event:"pre_edit", runtime:{name:"claude"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        tool_name:(.tool_name // ""), tool_id:(.tool_use_id // ""),
        paths:[{path:$path, action:(if (.tool_name // "") == "Write" then "add" else "update" end)}],
        added_content:[{path:$path, content:$content}]
      }
    ' 2>/dev/null) || exit 3
    ;;
  pre_command)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.0", event:"pre_command", runtime:{name:"claude"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        tool_name:(.tool_name // ""), tool_id:(.tool_use_id // ""),
        command:(.tool_input.command // "")
      }
    ' 2>/dev/null) || exit 3
    ;;
  post_edit)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      (.tool_input // {}) as $t |
      ($t.file_path // $t.filePath // $t.path // "") as $path |
      {
        protocol_version:"1.0", event:"post_edit", runtime:{name:"claude"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        tool_name:(.tool_name // ""), tool_id:(.tool_use_id // ""),
        paths:[{path:$path, action:(if (.tool_name // "") == "Write" then "add" else "update" end)}]
      }
    ' 2>/dev/null) || exit 3
    ;;
  stop)
    # Claude fires Stop only for completed turns (an aborted session never reaches
    # the hook), so stop_status is "ok". stop_hook_active is a BINARY flag — it
    # cannot count continuations, so loop_count is deliberately omitted and the
    # portable gate bounds binary runtimes at one continuation.
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.0", event:"stop", runtime:{name:"claude"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        stop:{
          verification_loop_active:(.stop_hook_active // false),
          stop_status:"ok"
        }
      }
    ' 2>/dev/null) || exit 3
    ;;
  session_start)
    # Claude SessionStart matchers: startup | resume | compact (also clear/fork,
    # which behave like a fresh context and normalize to startup).
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.1", event:"session_start", runtime:{name:"claude"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        session_start:{phase:(if (.source // "") | IN("resume", "compact")
                              then .source else "startup" end)}
      }
    ' 2>/dev/null) || exit 3
    ;;
  subagent_start)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.1", event:"subagent_start", runtime:{name:"claude"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        subagent_start:{agent_type:(.agent_type // ""), agent_id:(.agent_id // "")}
      }
    ' 2>/dev/null) || exit 3
    ;;
  user_prompt_submit)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.1", event:"user_prompt_submit", runtime:{name:"claude"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        prompt:(.prompt // .user_prompt // "")
      }
    ' 2>/dev/null) || exit 3
    ;;
  *)
    echo "claude adapter: unsupported event '$EVENT'" >&2
    exit 3
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s' "$NORMALIZED" | "$SCRIPT_DIR/../../hooks/validate-event.sh"
