#!/bin/sh
# Usage: run-hook.sh <claude-code|codex|cursor> <event> <policy-script>
#
# Two policy channels share this entry point:
#   - Guard policies communicate by exit code; everything they print is a
#     diagnostic and goes to stderr. Exit 2 blocks, exit 3 maps to a native block.
#   - Context policies (inject-context.sh) print a protocol 1.1 action envelope on
#     stdout. The envelope is validated (hooks/validate-action.sh) BEFORE being
#     translated to the runtime-native JSON shape; a malformed envelope means a
#     nonzero exit with empty stdout, never a half-translated payload. Context
#     failures never block the session — they only lose the injection.
set -u

RUNTIME=${1:-}
EVENT=${2:-}
POLICY=${3:-}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

case "$RUNTIME" in
  claude-code) NORMALIZER="$SCRIPT_DIR/claude-code/normalize.sh" ;;
  codex) NORMALIZER="$SCRIPT_DIR/codex/normalize.sh" ;;
  cursor) NORMALIZER="$SCRIPT_DIR/cursor/normalize.sh" ;;
  *) echo "adapter: unsupported runtime '$RUNTIME'" >&2; exit 3 ;;
esac

CONTEXT_POLICY=0
STOP_POLICY=0
case "$POLICY" in
  guard-secrets.sh|guard-protected-paths.sh|guard-destructive.sh|guard-worktree.sh|post-edit-format.sh) ;;
  stop-verify-gate.sh) STOP_POLICY=1 ;;
  inject-context.sh|route-skills.sh) CONTEXT_POLICY=1 ;;
  *) echo "adapter: unsupported policy '$POLICY'" >&2; exit 3 ;;
esac

INPUT=$(cat 2>/dev/null || true)
NORMALIZED=$(printf '%s' "$INPUT" | "$NORMALIZER" "$EVENT")
STATUS=$?

if [ "$STATUS" -ne 0 ]; then
  if [ "$POLICY" = "post-edit-format.sh" ]; then exit 0; fi
  if [ "$CONTEXT_POLICY" -eq 1 ]; then
    echo "harness adapter: payload normalization failed for $RUNTIME $EVENT (context injection skipped)" >&2
    exit 1
  fi
  echo "BLOCKED by harness adapter: payload normalization failed for $RUNTIME $EVENT" >&2
  exit 2
fi

# Policy stdout (the action channel) and stderr (diagnostics) are captured
# separately — they are different protocols and must never be mixed.
ERRFILE=$(mktemp) || { echo "adapter: mktemp failed" >&2; exit 3; }
trap 'rm -f "$ERRFILE"' EXIT
OUTPUT=$(printf '%s' "$NORMALIZED" | "$SCRIPT_DIR/../hooks/$POLICY" 2>"$ERRFILE")
STATUS=$?
ERRORS=$(cat "$ERRFILE" 2>/dev/null || true)

if [ -n "${HARNESS_TRACE_FILE:-}" ]; then
  printf '%s' "$NORMALIZED" | "$SCRIPT_DIR/../hooks/trace-event.sh" "$POLICY" "$STATUS"
  TRACE_STATUS=$?
  if [ "$TRACE_STATUS" -ne 0 ] && [ "$POLICY" != "post-edit-format.sh" ]; then
    if [ "$CONTEXT_POLICY" -eq 1 ]; then
      echo "harness adapter: trace configuration failed (context injection skipped)" >&2
      exit 1
    fi
    echo "BLOCKED by harness adapter: trace configuration failed" >&2
    exit 2
  fi
fi

[ -z "$ERRORS" ] || printf '%s\n' "$ERRORS" >&2

if [ "$STOP_POLICY" -eq 1 ]; then
  # Stop channel: the gate encodes "continue" as exit 2 + a `continue` action on
  # stdout (reason already mirrored on stderr above). Translate per runtime; the
  # legacy path (no/invalid stdout action) keeps the raw exit-code semantics.
  if [ "$STATUS" -eq 2 ] && ACTION=$(printf '%s' "$OUTPUT" | "$SCRIPT_DIR/../hooks/validate-action.sh" 2>/dev/null) \
     && [ "$(printf '%s' "$ACTION" | jq -r '.action')" = "continue" ]; then
    case "$RUNTIME" in
      cursor)
        # Cursor continues via {"followup_message": ...} + exit 0, bounded by the
        # hooks.json loop_limit.
        printf '%s' "$ACTION" | jq -c '{followup_message: .reason}'
        exit 0
        ;;
      *)
        # Claude/Codex native Stop continuation: exit 2, reason on stderr (already
        # emitted). Never leak the raw envelope to stdout.
        exit 2
        ;;
    esac
  fi
  if [ "$STATUS" -eq 3 ]; then
    echo "BLOCKED by harness adapter: stop policy could not be evaluated" >&2
    exit 2
  fi
  exit "$STATUS"
fi

if [ "$CONTEXT_POLICY" -eq 0 ]; then
  # Guard channel: preserve historical semantics — any policy stdout is a
  # diagnostic and joins stderr; exit codes carry the decision.
  [ -z "$OUTPUT" ] || printf '%s\n' "$OUTPUT" >&2
  if [ "$STATUS" -eq 3 ]; then
    [ "$POLICY" = "post-edit-format.sh" ] && exit 0
    echo "BLOCKED by harness adapter: policy could not be evaluated" >&2
    exit 2
  fi
  exit "$STATUS"
fi

# Context channel from here on.
if [ "$STATUS" -ne 0 ]; then
  echo "harness adapter: $POLICY failed for $RUNTIME $EVENT (context injection skipped)" >&2
  exit 1
fi

# A context policy may legitimately decide to emit nothing (e.g. the router found
# no matching trigger). Empty stdout + exit 0 is "no action": succeed silently.
if [ -z "$OUTPUT" ]; then
  exit 0
fi

ACTION=$(printf '%s' "$OUTPUT" | "$SCRIPT_DIR/../hooks/validate-action.sh") || {
  echo "harness adapter: $POLICY emitted an invalid action envelope for $RUNTIME $EVENT" >&2
  exit 1
}

KIND=$(printf '%s' "$ACTION" | jq -r '.action')
if [ "$KIND" != "context" ]; then
  echo "harness adapter: unexpected action '$KIND' from $POLICY on $EVENT" >&2
  exit 1
fi

# Translate the validated portable action to the runtime-native shape. Portable
# policies never emit native JSON — this is the only place translation happens.
case "$RUNTIME/$EVENT" in
  claude-code/session_start)
    # Claude Code SessionStart injects PLAIN STDOUT as context. Live-verified on
    # 2.1.220 (2026-07-25): a top-level {"additionalContext": ...} JSON body is
    # silently ignored for this event, while plain stdout is delivered.
    printf '%s' "$ACTION" | jq -r '.text'
    ;;
  claude-code/subagent_start)
    printf '%s' "$ACTION" | jq -c '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext: .text}}'
    ;;
  codex/session_start)
    printf '%s' "$ACTION" | jq -c '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: .text}}'
    ;;
  codex/subagent_start)
    printf '%s' "$ACTION" | jq -c '{hookSpecificOutput: {hookEventName: "SubagentStart", additionalContext: .text}}'
    ;;
  cursor/session_start)
    printf '%s' "$ACTION" | jq -c '{additional_context: .text}'
    ;;
  claude-code/user_prompt_submit)
    # UserPromptSubmit REQUIRES the nested form — top-level additionalContext is
    # documented as silently ignored for this event.
    printf '%s' "$ACTION" | jq -c '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: .text}}'
    ;;
  codex/user_prompt_submit)
    printf '%s' "$ACTION" | jq -c '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: .text}}'
    ;;
  *)
    echo "harness adapter: no context translation for $RUNTIME $EVENT" >&2
    exit 1
    ;;
esac
