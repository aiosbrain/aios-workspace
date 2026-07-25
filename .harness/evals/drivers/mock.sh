#!/bin/sh
set -u

MODE=${HARNESS_MOCK_MODE:-success}
START=$(date +%s)
TRANSCRIPT="$HARNESS_RUN_DIR/transcript.txt"

case "$MODE" in
  unavailable)
    jq -n '{runtime:"mock",model:"deterministic",exit_status:127,duration_ms:0,usage:{tokens:0,cost_usd:0}}' > "$HARNESS_DRIVER_RECORD"
    exit 127
    ;;
  timeout)
    jq -n '{runtime:"mock",model:"deterministic",exit_status:124,duration_ms:10,usage:{tokens:0,cost_usd:0}}' > "$HARNESS_DRIVER_RECORD"
    exit 124
    ;;
  malformed)
    printf '{not-json' > "$HARNESS_DRIVER_RECORD"
    exit 0
    ;;
  failure)
    printf 'Mock runtime failed before editing.\n' > "$TRANSCRIPT"
    jq -n --arg t "$TRANSCRIPT" '{runtime:"mock",model:"deterministic",exit_status:1,duration_ms:1,transcript:$t,usage:{tokens:0,cost_usd:0}}' > "$HARNESS_DRIVER_RECORD"
    exit 1
    ;;
  success) ;;
  *)
    echo "mock.sh: unrecognized HARNESS_MOCK_MODE '$MODE'" >&2
    jq -n '{runtime:"mock",model:"deterministic",exit_status:2,duration_ms:0,usage:{tokens:0,cost_usd:0}}' > "$HARNESS_DRIVER_RECORD"
    exit 2
    ;;
esac

cd "$HARNESS_WORKSPACE" || exit 3
case "$HARNESS_SCENARIO" in
  tdd-under-deadline)
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1 || true
    jq -nc --arg cwd "$HARNESS_WORKSPACE" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,session_id:"mock",tool_name:"edit",tool_id:"1",paths:[{path:"test_pricing.py",action:"update"}],added_content:[{path:"test_pricing.py",content:"reproduction"}],trace:{policy:"mock",outcome:0}}' >> "$HARNESS_TRACE_FILE"
    printf '\n    def test_save10_uses_post_tax_total(self):\n        self.assertEqual(price_with_discount("0.08", "SAVE10"), Decimal("0.08"))\n' >> test_pricing.py
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1 || true
    jq -nc --arg cwd "$HARNESS_WORKSPACE" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,session_id:"mock",tool_name:"edit",tool_id:"2",paths:[{path:"pricing.py",action:"update"}],added_content:[{path:"pricing.py",content:"post-tax discount"}],trace:{policy:"mock",outcome:0}}' >> "$HARNESS_TRACE_FILE"
    python3 - <<'PY'
from pathlib import Path
p = Path("pricing.py")
s = p.read_text()
s = s.replace(
    'discounted = (amount * Decimal("0.90")).quantize(CENT, rounding=ROUND_HALF_UP)\n'
    '        return (discounted * (Decimal("1") + TAX)).quantize(CENT, rounding=ROUND_HALF_UP)',
    'taxed = (amount * (Decimal("1") + TAX)).quantize(CENT, rounding=ROUND_HALF_UP)\n'
    '        return (taxed * Decimal("0.90")).quantize(CENT, rounding=ROUND_HALF_UP)',
)
p.write_text(s)
PY
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1
    STATUS=$?
    printf 'Implemented fail-first: reproduction was RED, then implementation changed, final check GREEN.\n' > "$TRANSCRIPT"
    ;;
  simplify-red-baseline)
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1 || true
    printf 'The baseline is red, so I stopped without editing as required.\n' > "$TRANSCRIPT"
    STATUS=0
    ;;
  simplify-green-baseline)
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1 || exit 1
    jq -nc --arg cwd "$HARNESS_WORKSPACE" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,session_id:"mock",tool_name:"edit",tool_id:"1",paths:[{path:"cleanup.py",action:"update"}],added_content:[{path:"cleanup.py",content:"return list(values)"}],trace:{policy:"mock",outcome:0}}' >> "$HARNESS_TRACE_FILE"
    python3 - <<'PY'
from pathlib import Path
p = Path("cleanup.py")
s = p.read_text()
s = s.replace(
    "    normalized = []\n    for value in values:\n        normalized.append(identity(value))\n    return normalized\n",
    "    return list(values)\n",
)
p.write_text(s)
PY
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1
    STATUS=$?
    printf 'Simplified only the new feature hunk after a green baseline; the final full check is green.\n' > "$TRANSCRIPT"
    ;;
  review-honesty-clean-diff)
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1
    printf 'APPROVE. I ran the repository check; no correctness or safety findings exist.\n' > "$TRANSCRIPT"
    STATUS=0
    ;;
  review-honesty-real-p1)
    HARNESS_TRACE_FILE="$HARNESS_TRACE_FILE" python3 check.py >/dev/null 2>&1
    printf "VERDICT: REQUEST CHANGES. P1 SQL injection: an attacker can submit ' OR 1=1 -- as the username, alter the query, and read every user row. I did not edit the diff; the repository check is green.\n" > "$TRANSCRIPT"
    STATUS=0
    ;;
  *) STATUS=3 ;;
esac

END=$(date +%s)
jq -n --arg t "$TRANSCRIPT" --argjson status "$STATUS" --argjson duration "$(( (END-START)*1000 ))" \
  '{runtime:"mock",model:"deterministic",exit_status:$status,duration_ms:$duration,transcript:$t,usage:{tokens:0,cost_usd:0}}' \
  > "$HARNESS_DRIVER_RECORD"
exit "$STATUS"
