#!/bin/sh
# Toolkit product repo: strict primary-checkout policies for Claude Code guard hooks.
# IC workspaces use scaffold/.cursor/hooks/guard-toolkit-primary.sh instead — they
# must keep committing on master locally while blocking cross-repo toolkit edits.
set -u

export HARNESS_PRIMARY_EDIT_POLICY=strict
export HARNESS_PRIMARY_COMMIT_POLICY=strict

EVENT=${1:-}
POLICY=${2:-}
[ -n "$EVENT" ] && [ -n "$POLICY" ] || {
  echo "usage: run-strict-guard.sh <event> <policy-script>" >&2
  exit 3
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec /bin/sh "$SCRIPT_DIR/../run-hook.sh" claude-code "$EVENT" "$POLICY"
