#!/bin/sh
set -u

EVENT=${1:-}
command -v jq >/dev/null 2>&1 || {
  echo "codex adapter: jq not found" >&2
  exit 3
}

INPUT=$(cat 2>/dev/null || true)
printf '%s' "$INPUT" | jq -e 'type == "object"' >/dev/null 2>&1 || {
  echo "codex adapter: malformed JSON payload" >&2
  exit 3
}

case "$EVENT" in
  pre_edit|post_edit)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg event "$EVENT" --arg cwd "${PWD:-.}" '
      (.tool_input.command // .tool_input.patch // "") as $patch |
      (reduce ($patch | split("\n")[]) as $line
        ({current:"", paths:[], added_content:[]};
          if ($line | test("^\\*\\*\\* (Add|Update|Delete) File: ")) then
            ($line | capture("^\\*\\*\\* (?<kind>Add|Update|Delete) File: (?<path>.*)$")) as $h |
            .current = $h.path |
            .paths += [{path:$h.path, action:($h.kind | ascii_downcase)}]
          elif ($line | test("^\\*\\*\\* Move to: ")) then
            ($line | capture("^\\*\\*\\* Move to: (?<path>.*)$").path) as $to |
            if (($to == "") or (.current == "") or ((.paths | length) == 0)) then
              error("codex patch rename has no source or destination")
            else
              .paths = ((.paths[0:-1]) + [{path:$to, action:"rename", from:.current}]) |
              .current = $to
            end
          elif ($line | startswith("+")) and (($line | startswith("+++")) | not) then
            .added_content += [{path:(if .current == "" then "<unknown>" else .current end), content:$line[1:]}]
          else . end
        )) as $parsed |
      {
        protocol_version:"1.0", event:$event, runtime:{name:"codex"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        tool_name:(.tool_name // "apply_patch"),
        tool_id:(.tool_use_id // .tool_call_id // ""),
        paths:($parsed.paths | unique_by([.path,.action,(.from // "")]))
      } + (if $event == "pre_edit" then {added_content:$parsed.added_content} else {} end)
    ' 2>/dev/null) || exit 3
    ;;
  pre_command)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.0", event:"pre_command", runtime:{name:"codex"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        tool_name:(.tool_name // "Bash"),
        tool_id:(.tool_use_id // .tool_call_id // ""),
        command:(.tool_input.command // .tool_input.cmd // "")
      }
    ' 2>/dev/null) || exit 3
    ;;
  stop)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.0", event:"stop", runtime:{name:"codex"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        stop:{
          verification_loop_active:(.stop_hook_active // false),
          stop_status:(if (.status // "") | IN("aborted", "error") then .status else "ok" end)
        }
      }
    ' 2>/dev/null) || exit 3
    ;;
  session_start)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.1", event:"session_start", runtime:{name:"codex"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        session_start:{phase:(if (.source // "") | IN("resume", "compact")
                              then .source else "startup" end)}
      }
    ' 2>/dev/null) || exit 3
    ;;
  subagent_start)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.1", event:"subagent_start", runtime:{name:"codex"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        subagent_start:{agent_type:(.agent_type // ""), agent_id:(.agent_id // "")}
      }
    ' 2>/dev/null) || exit 3
    ;;
  user_prompt_submit)
    NORMALIZED=$(printf '%s' "$INPUT" | jq -c --arg cwd "${PWD:-.}" '
      {
        protocol_version:"1.1", event:"user_prompt_submit", runtime:{name:"codex"},
        cwd:(.cwd // $cwd), session_id:(.session_id // ""),
        prompt:(.prompt // .user_prompt // "")
      }
    ' 2>/dev/null) || exit 3
    ;;
  *)
    echo "codex adapter: unsupported event '$EVENT'" >&2
    exit 3
    ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
printf '%s' "$NORMALIZED" | "$SCRIPT_DIR/../../hooks/validate-event.sh"
