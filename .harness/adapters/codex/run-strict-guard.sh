#!/bin/sh
# Toolkit product repo: strict primary-checkout policies for Codex guard hooks.
# IC workspaces ship no cross-repo guard (AIO-864): they must keep committing on
# master locally, and the guard that used to enforce this from their side fail-opened
# in the multi-root Cursor windows it targeted. This repo guards itself instead.
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
exec /bin/sh "$SCRIPT_DIR/../run-hook.sh" codex "$EVENT" "$POLICY"
