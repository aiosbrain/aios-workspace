#!/bin/sh
# Cursor hook dispatcher — the tracked half of the payload-cwd dispatch.
#
# Usage: dispatch.sh <repo-root> <kind> [args…]   (hook payload on stdin)
#   hook   <event> <policy>  -> adapters/run-hook.sh cursor <event> <policy>
#   strict <event> <policy>  -> adapters/cursor/run-strict-guard.sh <event> <policy>
#   stop                     -> adapters/cursor/stop-gate.sh
#   bugbot                   -> <root>/hooks/run-local-bugbot-gate.sh cursor <root>
#
# WHY THIS FILE EXISTS
# --------------------
# `.cursor/hooks.json` used to decide WHETHER a hook applied by testing paths under
# ${CURSOR_PROJECT_DIR} — one root, chosen when the WINDOW opened, regardless of which
# repo the agent is actually touching. In a multi-root window anchored on a repo that
# does not vendor this harness, the marker test found nothing and the guards never ran
# at all. Cursor DOES send the real directory in the stdin payload (`.cwd` on
# beforeShellExecution and preToolUse), which is what the normalizer already prefers;
# the dispatch decision simply ignored it.
#
# So hooks.json now carries only a LOCATOR: it reads stdin once, resolves the repo root
# from the payload (`git -C <payload cwd> rev-parse --show-toplevel`, the same shape
# .codex/hooks.json uses), checks the marker THERE, and re-emits the captured payload
# into this script. Everything past the decision lives here, where it is a tracked,
# testable file rather than nine copies of an unreviewable one-liner. The old
# `$comment` claimed the check had to be inline "because a helper script would sit at
# the same unresolvable path" — that is exactly what this design dissolves: the helper
# is found through the payload-derived root, so it needs no pre-resolved path.
set -u

ROOT=${1:-}
KIND=${2:-}
if [ -z "$ROOT" ] || [ -z "$KIND" ]; then
  echo "cursor dispatch: usage: dispatch.sh <repo-root> <kind> [args…]" >&2
  exit 3
fi
shift 2

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

# The dispatch decision was made from the PAYLOAD, so every downstream fallback has to
# agree with it rather than with whatever root the Cursor window happened to open on.
# normalize.sh uses ${CURSOR_PROJECT_DIR:-$PWD} for the events that carry no cwd.
CURSOR_PROJECT_DIR=$ROOT
export CURSOR_PROJECT_DIR

# ── environmental preflight ──────────────────────────────────────────────────
# Cursor is the runtime where a missing jq is fatal rather than annoying: failClosed
# turns "could not evaluate" into a deny for every tool call in the session. The
# rationale and the message live in adapters/jq-preflight.sh; this is the single point
# that covers all of Cursor's hooks, including `stop` and `bugbot`, which do not go
# through run-hook.sh.
# shellcheck source=../jq-preflight.sh
# shellcheck disable=SC1091  # path resolved at runtime
. "$SCRIPT_DIR/../jq-preflight.sh"
harness_jq_available || exit "$(harness_jq_missing_exit)"

case "$KIND" in
  hook)
    exec /bin/sh "$SCRIPT_DIR/../run-hook.sh" cursor "$@"
    ;;
  strict)
    exec /bin/sh "$SCRIPT_DIR/run-strict-guard.sh" "$@"
    ;;
  stop)
    exec /bin/sh "$SCRIPT_DIR/stop-gate.sh" "$@"
    ;;
  bugbot)
    # Same anti-tamper posture as the locator: the marker says this repo is
    # configured, so a missing gate script is a broken install, not an absent one.
    if [ ! -f "$ROOT/hooks/run-local-bugbot-gate.sh" ]; then
      echo "AIOS hook: $ROOT has the harness marker but hooks/run-local-bugbot-gate.sh is missing" >&2
      exit 3
    fi
    exec /bin/sh "$ROOT/hooks/run-local-bugbot-gate.sh" cursor "$ROOT"
    ;;
  *)
    echo "cursor dispatch: unsupported kind '$KIND'" >&2
    exit 3
    ;;
esac
