#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADAPTER="$ROOT/adapters/run-hook.sh"
PASS=0
FAIL=0
AWS_KEY="AKIA""ABCDEFGHIJKLMNOP"

check_status() {
  local name="$1" want="$2"
  shift 2
  "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS ($got): $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"
  fi
}

pipe_status() {
  local name="$1" want="$2" payload="$3"
  shift 3
  printf '%s' "$payload" | "$@" >/dev/null 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS ($got): $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"
  fi
}

fixture() {
  jq -c --arg cwd "$2" --arg value "$3" '
    walk(if type == "string" then gsub("__CWD__"; $cwd) | gsub("__(CONTENT|COMMAND|PATCH)__"; $value) else . end)
  ' "$1"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git -C "$TMP" init -q
mkdir -p "$TMP/.harness" "$TMP/src" "$TMP/nested" "$TMP/results"
printf 'false\n' > "$TMP/.harness/check"

echo "protocol + Claude native payloads"
CLAUDE_EDIT=$(fixture "$ROOT/evals/fixtures/native/claude/pre-edit.json" "$TMP" "key=$AWS_KEY")
pipe_status "Claude secret addition blocked" 2 "$CLAUDE_EDIT" "$ADAPTER" claude-code pre_edit guard-secrets.sh
CLAUDE_CLEAN=$(fixture "$ROOT/evals/fixtures/native/claude/pre-edit.json" "$TMP" 'key=$API_KEY')
pipe_status "Claude secret removal replacement allowed" 0 "$CLAUDE_CLEAN" "$ADAPTER" claude-code pre_edit guard-secrets.sh
CLAUDE_PROTECTED=$(printf '%s' "$CLAUDE_CLEAN" | jq -c '.tool_input.file_path=".env"')
pipe_status "Claude protected path blocked" 2 "$CLAUDE_PROTECTED" "$ADAPTER" claude-code pre_edit guard-protected-paths.sh
CLAUDE_SAFE_CMD=$(fixture "$ROOT/evals/fixtures/native/claude/pre-command.json" "$TMP/nested" "git status")
pipe_status "Claude safe command allowed" 0 "$CLAUDE_SAFE_CMD" "$ADAPTER" claude-code pre_command guard-destructive.sh
CLAUDE_BAD_CMD=$(fixture "$ROOT/evals/fixtures/native/claude/pre-command.json" "$TMP" "rm -rf /")
pipe_status "Claude destructive command blocked" 2 "$CLAUDE_BAD_CMD" "$ADAPTER" claude-code pre_command guard-destructive.sh
CLAUDE_STOP=$(fixture "$ROOT/evals/fixtures/native/claude/stop.json" "$TMP/nested" "unused")
pipe_status "Claude nested stop finds failing root check" 2 "$CLAUDE_STOP" "$ADAPTER" claude-code stop stop-verify-gate.sh
pipe_status "Claude stop recursion protection" 0 "$(printf '%s' "$CLAUDE_STOP" | jq -c '.stop_hook_active=true')" "$ADAPTER" claude-code stop stop-verify-gate.sh

echo "Codex native payloads"
PATCH=$'*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: package-lock.json\n@@\n-old\n+clean\n*** Add File: src/secret.ts\n+key='"$AWS_KEY"$'\n*** End Patch'
CODEX_PATCH=$(fixture "$ROOT/evals/fixtures/native/codex/apply-patch.json" "$TMP" "$PATCH")
NORMALIZED=$(printf '%s' "$CODEX_PATCH" | "$ROOT/adapters/codex/normalize.sh" pre_edit)
if [ "$(printf '%s' "$NORMALIZED" | jq '.paths | length')" = 2 ] &&
   [ "$(printf '%s' "$NORMALIZED" | jq -r '.paths[0].from')" = "src/old.ts" ]; then
  PASS=$((PASS+1)); echo "PASS (0): Codex multi-file rename normalized"
else
  FAIL=$((FAIL+1)); echo "FAIL: Codex multi-file rename normalization"
fi
pipe_status "Codex protected rename blocked" 2 "$CODEX_PATCH" "$ADAPTER" codex pre_edit guard-protected-paths.sh
pipe_status "Codex secret added line blocked" 2 "$CODEX_PATCH" "$ADAPTER" codex pre_edit guard-secrets.sh
REMOVE_PATCH=$'*** Begin Patch\n*** Update File: src/secret.ts\n@@\n-key='"$AWS_KEY"$'\n+key=$API_KEY\n*** End Patch'
CODEX_REMOVE=$(fixture "$ROOT/evals/fixtures/native/codex/apply-patch.json" "$TMP" "$REMOVE_PATCH")
pipe_status "Codex secret removal allowed" 0 "$CODEX_REMOVE" "$ADAPTER" codex pre_edit guard-secrets.sh
ORPHAN_PATCH=$'*** Begin Patch\n*** Move to: src/orphan.ts\n+content\n*** End Patch'
ORPHAN_PAYLOAD=$(fixture "$ROOT/evals/fixtures/native/codex/apply-patch.json" "$TMP" "$ORPHAN_PATCH")
pipe_status "Codex orphan rename rejected" 3 "$ORPHAN_PAYLOAD" "$ROOT/adapters/codex/normalize.sh" pre_edit
CODEX_SAFE_CMD=$(fixture "$ROOT/evals/fixtures/native/codex/bash.json" "$TMP/nested" "git status")
pipe_status "Codex safe command allowed" 0 "$CODEX_SAFE_CMD" "$ADAPTER" codex pre_command guard-destructive.sh
CODEX_BAD_CMD=$(fixture "$ROOT/evals/fixtures/native/codex/bash.json" "$TMP" "rm -rf /")
pipe_status "Codex destructive command blocked" 2 "$CODEX_BAD_CMD" "$ADAPTER" codex pre_command guard-destructive.sh
CODEX_STOP=$(fixture "$ROOT/evals/fixtures/native/codex/stop.json" "$TMP/nested" "unused")
pipe_status "Codex nested stop finds failing root check" 2 "$CODEX_STOP" "$ADAPTER" codex stop stop-verify-gate.sh
pipe_status "Codex stop recursion protection" 0 "$(printf '%s' "$CODEX_STOP" | jq -c '.stop_hook_active=true')" "$ADAPTER" codex stop stop-verify-gate.sh

echo "Cursor native payloads"
CURSOR_EDIT=$(jq -cn --arg cwd "$TMP" --arg k "key=$AWS_KEY" '{tool_name:"Write",tool_input:{file_path:"config.md",content:$k},cwd:$cwd}')
pipe_status "Cursor secret addition blocked" 2 "$CURSOR_EDIT" "$ADAPTER" cursor pre_edit guard-secrets.sh
CURSOR_CLEAN=$(jq -cn --arg cwd "$TMP" '{tool_name:"Write",tool_input:{file_path:"config.md",content:"key=$API_KEY"},cwd:$cwd}')
pipe_status "Cursor clean edit allowed" 0 "$CURSOR_CLEAN" "$ADAPTER" cursor pre_edit guard-secrets.sh
CURSOR_PROTECTED=$(jq -cn --arg cwd "$TMP" '{tool_name:"Write",tool_input:{file_path:".env",content:"X=1"},cwd:$cwd}')
pipe_status "Cursor protected path blocked" 2 "$CURSOR_PROTECTED" "$ADAPTER" cursor pre_edit guard-protected-paths.sh
CURSOR_EDIT_VIA_EDITS=$(jq -cn --arg cwd "$TMP" --arg k "key=$AWS_KEY" '{tool_name:"Edit",tool_input:{file_path:"c.md",edits:[{old_string:"x",new_string:$k}]},cwd:$cwd}')
pipe_status "Cursor secret via edits[] blocked" 2 "$CURSOR_EDIT_VIA_EDITS" "$ADAPTER" cursor pre_edit guard-secrets.sh
CURSOR_EDIT_NEW_STRING=$(jq -cn --arg cwd "$TMP" --arg k "key=$AWS_KEY" '{tool_name:"Edit",tool_input:{filePath:"alias.md",new_string:$k},cwd:$cwd}')
pipe_status "Cursor new_string/filePath aliases blocked" 2 "$CURSOR_EDIT_NEW_STRING" "$ADAPTER" cursor pre_edit guard-secrets.sh
CURSOR_EDIT_NEW_STRING_CAMEL=$(jq -cn --arg cwd "$TMP" --arg k "key=$AWS_KEY" '{tool_name:"Edit",tool_input:{filePath:"alias.md",newString:$k},cwd:$cwd}')
pipe_status "Cursor newString alias blocked" 2 "$CURSOR_EDIT_NEW_STRING_CAMEL" "$ADAPTER" cursor pre_edit guard-secrets.sh
CURSOR_EDIT_TOP_LEVEL=$(jq -cn --arg cwd "$TMP" --arg k "key=$AWS_KEY" '{tool_name:"Edit",filePath:"alias.md",edits:[{newString:$k}],cwd:$cwd}')
pipe_status "Cursor top-level content aliases blocked" 2 "$CURSOR_EDIT_TOP_LEVEL" "$ADAPTER" cursor pre_edit guard-secrets.sh
CURSOR_SAFE_CMD=$(jq -cn --arg cwd "$TMP/nested" '{command:"git status",cwd:$cwd}')
pipe_status "Cursor safe command allowed" 0 "$CURSOR_SAFE_CMD" "$ADAPTER" cursor pre_command guard-destructive.sh
CURSOR_BAD_CMD=$(jq -cn --arg cwd "$TMP" '{command:"rm -rf /",cwd:$cwd}')
pipe_status "Cursor destructive command blocked" 2 "$CURSOR_BAD_CMD" "$ADAPTER" cursor pre_command guard-destructive.sh
pipe_status "Cursor afterFileEdit format no-op" 0 "$(jq -cn '{file_path:"/nonexistent/x.ts",edits:[{old_string:"a",new_string:"b"}]}')" "$ADAPTER" cursor post_edit post-edit-format.sh
CURSOR_STOP='{"status":"completed","loop_count":0}'
# Since protocol 1.1 the cursor stop channel translates a red check to
# {"followup_message": ...} with exit 0 (Cursor continues via JSON, not exit codes).
STOP_RAW=$(printf '%s' "$CURSOR_STOP" | CURSOR_PROJECT_DIR="$TMP/nested" /bin/sh "$ADAPTER" cursor stop stop-verify-gate.sh 2>/dev/null)
if [ $? -eq 0 ] && printf '%s' "$STOP_RAW" | jq -e '.followup_message | contains("verify-change")' >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "PASS (0): Cursor stop translates a failing root check to followup_message"
else
  FAIL=$((FAIL+1)); echo "FAIL: Cursor stop followup translation (got '$(printf '%s' "$STOP_RAW" | head -c 60)')"
fi
STOP_OUT=$(printf '%s' "$CURSOR_STOP" | CURSOR_PROJECT_DIR="$TMP/nested" /bin/sh "$ROOT/adapters/cursor/stop-gate.sh" 2>/dev/null)
if printf '%s' "$STOP_OUT" | jq -e '.followup_message' >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "PASS (0): Cursor stop-gate emits followup_message on block"
else
  FAIL=$((FAIL+1)); echo "FAIL: Cursor stop-gate followup_message"
fi
printf 'printf "tab\\tcarriage\\ransi\\033[31mred\\033[0m\\n" >&2; exit 1\n' > "$TMP/.harness/check"
STOP_OUT=$(printf '%s' "$CURSOR_STOP" | CURSOR_PROJECT_DIR="$TMP/nested" /bin/sh "$ROOT/adapters/cursor/stop-gate.sh" 2>/dev/null)
if printf '%s' "$STOP_OUT" | jq -e '.followup_message | contains("tab")' >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "PASS (0): Cursor stop-gate JSON-encodes control characters"
else
  FAIL=$((FAIL+1)); echo "FAIL: Cursor stop-gate emitted invalid control-character JSON"
fi
for STOP_STATUS in aborted error; do
  STOP_OUT=$(printf '{"status":"%s","loop_count":0}' "$STOP_STATUS" |
    CURSOR_PROJECT_DIR="$TMP/nested" /bin/sh "$ROOT/adapters/cursor/stop-gate.sh" 2>/dev/null)
  if [ "$STOP_OUT" = "{}" ]; then
    PASS=$((PASS+1)); echo "PASS (0): Cursor $STOP_STATUS stop skips verification continuation"
  else
    FAIL=$((FAIL+1)); echo "FAIL: Cursor $STOP_STATUS stop emitted a continuation"
  fi
done

echo "failure mapping + tracing + formatting"
pipe_status "safety adapter blocks malformed payload" 2 '{bad' "$ADAPTER" codex pre_edit guard-secrets.sh
pipe_status "formatter ignores malformed payload" 0 '{bad' "$ADAPTER" codex post_edit post-edit-format.sh
mkdir -p "$TMP/no-jq"
ln -s /usr/bin/dirname "$TMP/no-jq/dirname"
ln -s /bin/cat "$TMP/no-jq/cat"
printf '%s' "$CLAUDE_CLEAN" | PATH="$TMP/no-jq" "$ADAPTER" claude-code pre_edit guard-secrets.sh >/dev/null 2>&1
if [ $? = 2 ]; then
  PASS=$((PASS+1)); echo "PASS (2): missing jq blocks safety adapter"
else
  FAIL=$((FAIL+1)); echo "FAIL: missing jq did not block safety adapter"
fi
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nprintf "%%s\\n" "$2" >> "$FORMAT_LOG"\n' > "$TMP/bin/prettier"
chmod +x "$TMP/bin/prettier"
printf 'const a=1\n' > "$TMP/src/a.ts"
printf 'const b=2\n' > "$TMP/src/b.ts"
FORMAT_PATCH=$'*** Begin Patch\n*** Update File: src/a.ts\n+const a = 1\n*** Update File: src/b.ts\n+const b = 2\n*** End Patch'
FORMAT_PAYLOAD=$(fixture "$ROOT/evals/fixtures/native/codex/apply-patch.json" "$TMP" "$FORMAT_PATCH")
FORMAT_LOG="$TMP/format.log" PATH="$TMP/bin:$PATH" pipe_status "formatter handles multi-file edit without blocking" 0 "$FORMAT_PAYLOAD" "$ADAPTER" codex post_edit post-edit-format.sh
if [ "$(wc -l < "$TMP/format.log" | tr -d ' ')" = 2 ]; then
  PASS=$((PASS+1)); echo "PASS (0): formatter visited every edited path"
else
  FAIL=$((FAIL+1)); echo "FAIL: formatter did not visit every edited path"
fi

TRACE="$TMP/results/trace.jsonl"
HARNESS_TRACE_FILE="$TRACE" pipe_status "trace capture is opt-in" 0 "$CLAUDE_SAFE_CMD" "$ADAPTER" claude-code pre_command guard-destructive.sh
if jq -e '.protocol_version == "1.0" and .trace.outcome == 0' "$TRACE" >/dev/null; then
  PASS=$((PASS+1)); echo "PASS (0): trace is normalized JSONL"
else
  FAIL=$((FAIL+1)); echo "FAIL: trace record invalid"
fi
HARNESS_TRACE_FILE="$TMP/outside.jsonl" pipe_status "trace path failure blocks safety policy" 2 "$CLAUDE_SAFE_CMD" "$ADAPTER" claude-code pre_command guard-destructive.sh
HARNESS_TRACE_FILE="$TMP/results/../escaped.jsonl" pipe_status "trace traversal blocks safety policy" 2 "$CLAUDE_SAFE_CMD" "$ADAPTER" claude-code pre_command guard-destructive.sh
ln -s "$TMP/escaped-link.jsonl" "$TMP/results/link.jsonl"
HARNESS_TRACE_FILE="$TMP/results/link.jsonl" pipe_status "trace symlink blocks safety policy" 2 "$CLAUDE_SAFE_CMD" "$ADAPTER" claude-code pre_command guard-destructive.sh

echo "OpenCode TypeScript adapter"
check_status "OpenCode normalizer tests" 0 bun test "$ROOT/evals/opencode-plugin.test.ts"

echo "conformance.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
