#!/bin/sh
# Repo-specific adapter point (see ../CONTRACT.md in aios-engineering-harness for the
# core/adapter split). Unlike the engineering harness, an AIOS-workspace scenario's
# setup.sh already builds the real fixture by calling scaffold-project.sh directly, so
# there is nothing further to install here — this just asserts setup.sh did its job.
set -eu

ROOT=$1
WORKSPACE=$2

[ -d "$WORKSPACE/.git" ] || { echo "workspace fixture is not a git repo — did setup.sh scaffold it?" >&2; exit 1; }
[ -d "$WORKSPACE/.claude" ] || { echo "workspace fixture has no .claude/ — did setup.sh scaffold it?" >&2; exit 1; }

# scaffold/scripts/aios.mjs's delegating shim resolves the toolkit checkout via, in
# order: AIOS_TOOLKIT_DIR env -> AIOS_TOOLKIT_CLI (deprecated) -> ../aios-workspace ->
# ../aios/aios-workspace -> ../../aios-workspace, relative to the shim's own directory
# (which is $WORKSPACE itself once scaffolded). run.sh puts $WORKSPACE at
# "$SCRATCH_DIR/workspace", so the shim's "../aios-workspace" candidate resolves to
# "$SCRATCH_DIR/aios-workspace" — which doesn't exist, so any regeneration command a
# live agent runs (e.g. `aios gen:catalog`) fails with "toolkit CLI not found." Symlink
# that exact fallback path to the real toolkit checkout under test, outside $WORKSPACE
# itself so it can't interfere with the scenario's own git-diff/forbidden-path checks.
SCRATCH_DIR=$(CDPATH= cd -- "$WORKSPACE/.." && pwd)
[ -e "$SCRATCH_DIR/aios-workspace" ] || ln -s "$ROOT" "$SCRATCH_DIR/aios-workspace"

cat >> "$WORKSPACE/.git/info/exclude" <<'EOF'
/.eval-evidence.jsonl
/.eval/
/__pycache__/
*.pyc
EOF
