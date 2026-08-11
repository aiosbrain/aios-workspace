#!/bin/sh
# Synthetic tool-call payload builders for guards.test.sh. SOURCED by it — split out only
# to keep that file under the repository size cap; there is still one eval entry point.
#
# wjson/pjson/bjson build RUNTIME-NATIVE payloads (Claude Write, Codex apply_patch, a bare
# shell command). wpc/wpe build NORMALIZED protocol events, which is what the portable
# policies under hooks/ actually consume.

wjson() { # file_path content -> Write payload (jq-safe encoding)
  jq -cn --arg fp "$1" --arg c "$2" '{tool_name:"Write",tool_input:{file_path:$fp,content:$c}}'
}

pjson() { # patch -> Codex apply_patch payload
  jq -cn --arg c "$1" '{tool_name:"apply_patch",tool_input:{command:$c}}'
}

bjson() { jq -cn --arg c "$1" '{tool_input:{command:$c}}'; }

wpc() { jq -cn --arg cwd "$1" --arg cmd "$2" '{protocol_version:"1.0",event:"pre_command",runtime:{name:"mock"},cwd:$cwd,command:$cmd}'; }
wpe() { jq -cn --arg cwd "$1" --arg p "$2" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,paths:[{path:$p,action:"update"}],added_content:[]}'; }
