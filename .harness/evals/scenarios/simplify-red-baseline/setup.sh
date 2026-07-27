#!/bin/sh
set -eu
SCENARIO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
python3 "$SCENARIO_DIR/fixture.py"
git init -q
git add .
git -c user.name=Harness -c user.email=harness@example.invalid commit -qm "fixture baseline"
printf '\n# cleanup bait\ndef wrapper(value):\n    return identity(value)\n' >> cleanup.py
