#!/bin/sh
set -eu
SCENARIO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 "$SCENARIO_DIR/fixture.py"
git init -q
git add pricing.py test_pricing.py check.py TASK.md
git -c user.name=Harness -c user.email=harness@example.invalid commit -qm "fixture baseline"
