#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
TMP=$(mktemp -d /tmp/harness-codex-driver.XXXXXX)
trap 'rm -rf "$TMP"' EXIT

report() {
  local name="$1" status="$2"
  if [ "$status" -eq 0 ]; then
    PASS=$((PASS+1)); echo "PASS: $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL: $name"
  fi
}

mkdir -p "$TMP/bin"

run_fake_codex() {
  local case_dir="$1"
  mkdir -p "$case_dir/run" "$case_dir/workspace"
  printf 'hello\n' > "$case_dir/prompt.md"
  PATH="$TMP/bin:$PATH" \
    HARNESS_ROOT="$ROOT" HARNESS_WORKSPACE="$case_dir/workspace" \
    HARNESS_PROMPT_FILE="$case_dir/prompt.md" HARNESS_TRACE_FILE="$case_dir/trace.jsonl" \
    HARNESS_RUN_DIR="$case_dir/run" HARNESS_DRIVER_RECORD="$case_dir/run/driver.json" \
    HARNESS_MODEL=default HARNESS_TIMEOUT=10 \
    bash "$ROOT/evals/drivers/codex.sh"
}

# Case A (true positive, must be preserved): no genuine turn/item completion event at
# all, process exits nonzero, and stderr carries an auth-failure phrase -> unavailable.
CASE_A="$TMP/case-a"
mkdir -p "$CASE_A"
cat > "$TMP/bin/codex" <<'EOF'
#!/bin/sh
echo '{"type":"turn.started"}'
echo "Error: authentication required" >&2
exit 1
EOF
chmod +x "$TMP/bin/codex"
run_fake_codex "$CASE_A" >/dev/null 2>&1
jq -e '.exit_status == 127 and (.reason // "" | length) > 0' "$CASE_A/run/driver.json" >/dev/null 2>&1
report "codex.sh: no item.completed + nonzero exit + stderr auth phrase -> unavailable" $?

# Case B (false-negative regression guard): a genuine item.completed event IS present
# (real work happened) even though the process later crashes and stderr happens to
# contain a keyword-like phrase (e.g. legitimate transcript content) -> must classify
# as a plain error, not unavailable. This is the exact misclassification the
# tightened check must avoid.
CASE_B="$TMP/case-b"
mkdir -p "$CASE_B"
cat > "$TMP/bin/codex" <<'EOF'
#!/bin/sh
echo '{"type":"item.completed","item":{"type":"command_execution"}}'
echo "reviewed: unauthorized access is not possible here" >&2
exit 1
EOF
chmod +x "$TMP/bin/codex"
run_fake_codex "$CASE_B" >/dev/null 2>&1
jq -e '.exit_status == 1' "$CASE_B/run/driver.json" >/dev/null 2>&1
report "codex.sh: item.completed present -> stays error, not misclassified unavailable" $?

echo "codex-driver.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
