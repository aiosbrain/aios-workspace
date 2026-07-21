#!/bin/sh
# Repo-specific adapter point (see ../CONTRACT.md in aios-engineering-harness for the
# core/adapter split). Unlike the engineering harness, an AIOS-workspace scenario's
# setup.sh already builds the real fixture by calling scaffold-project.sh directly, so
# there is nothing further to install here — this just asserts setup.sh did its job.
set -eu

WORKSPACE=$2

[ -d "$WORKSPACE/.git" ] || { echo "workspace fixture is not a git repo — did setup.sh scaffold it?" >&2; exit 1; }
[ -d "$WORKSPACE/.claude" ] || { echo "workspace fixture has no .claude/ — did setup.sh scaffold it?" >&2; exit 1; }

cat >> "$WORKSPACE/.git/info/exclude" <<'EOF'
/.eval-evidence.jsonl
/.eval/
/__pycache__/
*.pyc
EOF
