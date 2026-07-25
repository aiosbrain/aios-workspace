#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
STAMP="runner-test-$$"

run_case() {
  local mode="$1" want="$2"
  local dir="$ROOT/evals/results/$STAMP-$mode"
  bash "$ROOT/evals/run.sh" --runtime mock --scenario tdd-under-deadline --runs 1 \
    --mock-mode "$mode" --results-dir "$dir" >/dev/null
  local got
  got=$(jq -r '.runs[0].status' "$dir/summary.json")
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS: mock $mode -> $want"
  else
    FAIL=$((FAIL+1)); echo "FAIL: mock $mode -> $got (want $want)"
  fi
}

run_case success pass
run_case failure error
run_case timeout timeout
run_case malformed error
run_case unavailable unavailable
run_case garbage-mode error

REVIEW_DIR="$ROOT/evals/results/$STAMP-review"
bash "$ROOT/evals/run.sh" --runtime mock --scenario review-honesty-clean-diff --runs 1 \
  --results-dir "$REVIEW_DIR" >/dev/null
if [ "$(jq -r '.runs[0].status' "$REVIEW_DIR/summary.json")" = needs_review ]; then
  PASS=$((PASS+1)); echo "PASS: missing semantic judge -> needs_review"
else
  FAIL=$((FAIL+1)); echo "FAIL: missing semantic judge was counted as complete"
fi

ALL_DIR="$ROOT/evals/results/$STAMP-all"
bash "$ROOT/evals/run.sh" --runtime mock --scenario all --runs 1 --judge mock \
  --results-dir "$ALL_DIR" >/dev/null
EXPECTED_TOTAL=0
for MANIFEST in "$ROOT"/evals/scenarios/*/manifest.json; do
  [ -f "$MANIFEST" ] || continue
  SCENARIO_DIR_CHECK=$(dirname "$MANIFEST")
  # Mirrors run.sh's own --scenario all completeness gate exactly (including the
  # rubric.md-required-when-semantic_required clause) so this count can never
  # diverge from what run.sh actually decides to include.
  SCENARIO_SEMANTIC=$(jq -r '.semantic_required // false' "$MANIFEST" 2>/dev/null || echo false)
  if [ -x "$SCENARIO_DIR_CHECK/setup.sh" ] && [ -x "$SCENARIO_DIR_CHECK/grade.sh" ] && [ -f "$SCENARIO_DIR_CHECK/prompt.md" ] \
    && { [ "$SCENARIO_SEMANTIC" != true ] || [ -f "$SCENARIO_DIR_CHECK/rubric.md" ]; }; then
    EXPECTED_TOTAL=$((EXPECTED_TOTAL+1))
  fi
done
if jq -e --argjson n "$EXPECTED_TOTAL" '.total == $n and .by_status.pass == $n and .pass_rate == 1' "$ALL_DIR/summary.json" >/dev/null; then
  PASS=$((PASS+1)); echo "PASS: aggregate summary"
else
  FAIL=$((FAIL+1)); echo "FAIL: aggregate summary"
fi

INSTALL_ROOT=$(mktemp -d /tmp/harness-install-failure.XXXXXX)
mkdir -p "$INSTALL_ROOT/evals/lib" "$INSTALL_ROOT/evals/drivers" "$INSTALL_ROOT/evals/scenarios"
cp "$ROOT/evals/run.sh" "$INSTALL_ROOT/evals/run.sh"
cp "$ROOT/evals/lib/install-harness.sh" "$INSTALL_ROOT/evals/lib/install-harness.sh"
cp -R "$ROOT/evals/scenarios/tdd-under-deadline" "$INSTALL_ROOT/evals/scenarios/tdd-under-deadline"
DRIVER_MARKER="$INSTALL_ROOT/driver-ran"
printf '#!/bin/sh\ntouch "%s"\nexit 99\n' "$DRIVER_MARKER" > "$INSTALL_ROOT/evals/drivers/mock.sh"
chmod +x "$INSTALL_ROOT/evals/drivers/mock.sh"
INSTALL_RESULTS="$INSTALL_ROOT/results"
bash "$INSTALL_ROOT/evals/run.sh" --runtime mock --scenario tdd-under-deadline --runs 1 \
  --results-dir "$INSTALL_RESULTS" >/dev/null 2>&1
if jq -e '.status == "error" and .reason == "harness installation failed"' \
    "$INSTALL_RESULTS/tdd-under-deadline-mock-1/run.json" >/dev/null &&
   jq -e '.total == 1 and .by_status.error == 1' "$INSTALL_RESULTS/summary.json" >/dev/null &&
   [ ! -e "$DRIVER_MARKER" ]; then
  PASS=$((PASS+1)); echo "PASS: install failure is recorded before driver execution"
else
  FAIL=$((FAIL+1)); echo "FAIL: install failure handling"
fi
rm -rf "$INSTALL_ROOT"

EMPTY_ROOT=$(mktemp -d /tmp/harness-empty-scenarios.XXXXXX)
mkdir -p "$EMPTY_ROOT/evals/lib" "$EMPTY_ROOT/evals/drivers" "$EMPTY_ROOT/evals/scenarios"
cp "$ROOT/evals/run.sh" "$EMPTY_ROOT/evals/run.sh"
cp "$ROOT/evals/lib/install-harness.sh" "$EMPTY_ROOT/evals/lib/install-harness.sh"
cp "$ROOT/evals/drivers/mock.sh" "$EMPTY_ROOT/evals/drivers/mock.sh"
EMPTY_RESULTS="$EMPTY_ROOT/results"
# No portable `timeout`/`gtimeout` binary assumed available (macOS ships neither by
# default) — use a plain bash watchdog so a regression that reintroduces the hang
# fails this test loudly instead of hanging the whole suite.
bash "$EMPTY_ROOT/evals/run.sh" --runtime mock --scenario all --runs 1 \
  --results-dir "$EMPTY_RESULTS" >/dev/null 2>&1 &
EMPTY_PID=$!
( sleep 10; kill -9 "$EMPTY_PID" 2>/dev/null ) &
WATCHDOG_PID=$!
wait "$EMPTY_PID" 2>/dev/null
EMPTY_STATUS=$?
kill "$WATCHDOG_PID" 2>/dev/null
wait "$WATCHDOG_PID" 2>/dev/null
if [ "$EMPTY_STATUS" -eq 3 ]; then
  PASS=$((PASS+1)); echo "PASS: --scenario all with zero complete scenarios exits cleanly (not a crash/hang)"
else
  FAIL=$((FAIL+1)); echo "FAIL: --scenario all with zero complete scenarios exited $EMPTY_STATUS (want 3; 124 would mean the old hang came back)"
fi
rm -rf "$EMPTY_ROOT"

SCRATCH_BEFORE=$(find "$ROOT/evals/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
CLEANUP_DIR="$ROOT/evals/results/$STAMP-cleanup"
bash "$ROOT/evals/run.sh" --runtime mock --scenario tdd-under-deadline --runs 1 \
  --results-dir "$CLEANUP_DIR" >/dev/null
SCRATCH_AFTER=$(find "$ROOT/evals/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
if [ "$SCRATCH_AFTER" = "$SCRATCH_BEFORE" ]; then
  PASS=$((PASS+1)); echo "PASS: scratch workspace is cleaned up after a normal run"
else
  FAIL=$((FAIL+1)); echo "FAIL: scratch workspace leaked after a normal run"
fi

KEEP_DIR="$ROOT/evals/results/$STAMP-keep"
bash "$ROOT/evals/run.sh" --runtime mock --scenario tdd-under-deadline --runs 1 --keep-workspaces \
  --results-dir "$KEEP_DIR" >/dev/null
SCRATCH_AFTER_KEEP=$(find "$ROOT/evals/scratch" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
NEW_KEPT_DIRS=$(comm -13 <(echo "$SCRATCH_BEFORE") <(echo "$SCRATCH_AFTER_KEEP"))
if [ -n "$NEW_KEPT_DIRS" ]; then
  PASS=$((PASS+1)); echo "PASS: --keep-workspaces preserves the scratch workspace"
else
  FAIL=$((FAIL+1)); echo "FAIL: --keep-workspaces did not preserve the scratch workspace"
fi
[ -z "$NEW_KEPT_DIRS" ] || echo "$NEW_KEPT_DIRS" | xargs -I{} rm -rf {}

FORBIDDEN_ROOT=$(mktemp -d /tmp/harness-forbidden.XXXXXX)
mkdir -p "$FORBIDDEN_ROOT/evals/lib" "$FORBIDDEN_ROOT/evals/drivers" "$FORBIDDEN_ROOT/evals/scenarios/tamper-scenario"
cp "$ROOT/evals/run.sh" "$FORBIDDEN_ROOT/evals/run.sh"
printf '#!/bin/sh\nexit 0\n' > "$FORBIDDEN_ROOT/evals/lib/install-harness.sh"
chmod +x "$FORBIDDEN_ROOT/evals/lib/install-harness.sh"
printf '{"id":"tamper-scenario","title":"tamper test","timeout_seconds":60,"semantic_required":false,"forbidden_paths":[".secret"]}\n' \
  > "$FORBIDDEN_ROOT/evals/scenarios/tamper-scenario/manifest.json"
printf 'noop\n' > "$FORBIDDEN_ROOT/evals/scenarios/tamper-scenario/prompt.md"
cat > "$FORBIDDEN_ROOT/evals/scenarios/tamper-scenario/setup.sh" <<'EOF'
#!/bin/sh
set -eu
git init -q
git config user.email a@b.c
git config user.name test
printf 'original\n' > .secret
git add -A
git commit -qm init
EOF
chmod +x "$FORBIDDEN_ROOT/evals/scenarios/tamper-scenario/setup.sh"
printf '#!/bin/sh\necho '"'"'{"checks":{},"deterministic_pass":true}'"'"'\n' \
  > "$FORBIDDEN_ROOT/evals/scenarios/tamper-scenario/grade.sh"
chmod +x "$FORBIDDEN_ROOT/evals/scenarios/tamper-scenario/grade.sh"
cat > "$FORBIDDEN_ROOT/evals/drivers/mock.sh" <<'EOF'
#!/bin/sh
set -u
cd "$HARNESS_WORKSPACE"
printf 'tampered\n' > .secret
exit 1
EOF
chmod +x "$FORBIDDEN_ROOT/evals/drivers/mock.sh"
FORBIDDEN_RESULTS="$FORBIDDEN_ROOT/results"
bash "$FORBIDDEN_ROOT/evals/run.sh" --runtime mock --scenario tamper-scenario --runs 1 \
  --results-dir "$FORBIDDEN_RESULTS" >/dev/null 2>&1
if jq -e '.runs[0].status == "fail" and .runs[0].forbidden_path_hit == true' "$FORBIDDEN_RESULTS/summary.json" >/dev/null 2>&1; then
  PASS=$((PASS+1)); echo "PASS: forbidden-path tamper ranks above a driver error and survives into summary.json"
else
  FAIL=$((FAIL+1)); echo "FAIL: forbidden-path tamper not surfaced correctly in summary.json"
fi
rm -rf "$FORBIDDEN_ROOT"

echo "runner.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
