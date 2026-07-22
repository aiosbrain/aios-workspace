#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASS=0
FAIL=0
TMP=$(mktemp -d /tmp/workspace-install-harness.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

report() {
  local name="$1" status="$2"
  if [ "$status" -eq 0 ]; then
    PASS=$((PASS+1)); echo "PASS: $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $name"
  fi
}

# Mirror run.sh's real layout: WORKSPACE="$SCRATCH_DIR/workspace" — the symlink must
# land in $SCRATCH_DIR (the workspace's parent), at exactly the relative path
# scaffold/scripts/aios.mjs's own fallback chain checks (../aios-workspace).
SCRATCH_DIR="$TMP/scratch"
WORKSPACE="$SCRATCH_DIR/workspace"
mkdir -p "$WORKSPACE/.claude"
git -C "$WORKSPACE" init -q

bash "$ROOT/evals/lib/install-harness.sh" "$ROOT" "$WORKSPACE" mock
report "install-harness.sh exits 0 for a valid fixture" $?

if [ -L "$SCRATCH_DIR/aios-workspace" ] && [ "$(cd "$SCRATCH_DIR/aios-workspace" && pwd -P)" = "$(cd "$ROOT" && pwd -P)" ]; then
  PASS=$((PASS+1)); echo "PASS: symlink at the shim's fallback path points at the real toolkit checkout"
else
  FAIL=$((FAIL+1)); echo "FAIL: symlink missing or points at the wrong target"
fi

# The realistic remediation path a live agent (or the product's own install-skill hint
# text, "refresh the catalog: npm run gen:catalog") would take: cd into the discovered
# toolkit dir, then run its gen:catalog script against the original workspace.
mkdir -p "$WORKSPACE/.claude/skills"
( cd "$WORKSPACE" && cd ../aios-workspace 2>/dev/null && npm run gen:catalog -- --repo "$WORKSPACE" ) >/dev/null 2>&1
if [ -f "$WORKSPACE/.claude/skills/INDEX.md" ]; then
  PASS=$((PASS+1)); echo "PASS: the toolkit's real gen-catalog.mjs is reachable and regenerates the catalog via the symlink"
else
  FAIL=$((FAIL+1)); echo "FAIL: catalog regeneration through the symlinked toolkit path did not produce INDEX.md"
fi

# Running install-harness.sh twice (e.g. --runs > 1 reusing... well, each run gets its
# own scratch dir in practice, but a shared SCRATCH_DIR across two calls should still
# be idempotent, not error on an already-existing symlink).
bash "$ROOT/evals/lib/install-harness.sh" "$ROOT" "$WORKSPACE" mock >/dev/null 2>&1
report "install-harness.sh is idempotent when the symlink already exists" $?

echo "install-harness.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
