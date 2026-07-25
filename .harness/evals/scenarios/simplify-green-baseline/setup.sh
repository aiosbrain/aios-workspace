#!/bin/sh
set -eu
SCENARIO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 "$SCENARIO_DIR/fixture.py" baseline
git init -q
git add cleanup.py legacy.py test_cleanup.py check.py TASK.md
git -c user.name=Harness -c user.email=harness@example.invalid commit -qm "fixture baseline"
python3 "$SCENARIO_DIR/fixture.py" feature
