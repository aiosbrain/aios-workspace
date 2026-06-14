#!/usr/bin/env bash
# demo-spoke.sh — scaffold a ready-to-test workspace, pre-filled with sample
# content across all access tiers, and (optionally) wired to a Team Brain with a
# key written into its .env. No heredocs for you to paste; re-runnable.
#
# Usage:
#   scripts/demo-spoke.sh \
#     [--context consultant|employee] \
#     [--slug acme-workspace] [--output /tmp/acme-workspace] \
#     [--stakeholder "Acme Corp"] [--owner alex] [--team alex,sam] \
#     [--team-id demo] [--brain-url http://127.0.0.1:3000] \
#     [--api-key aios_...] [--member alex]
#
# With --api-key + --brain-url + --team-id set, the spoke is push-ready:
#   cd <output> && aios status && aios push && aios query "…"

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

CONTEXT="consultant"
SLUG="acme-workspace"; OUTPUT=""; STAKEHOLDER="Acme Corp"
OWNER="alex"; TEAM="alex,sam"; TEAM_ID=""; BRAIN_URL=""; API_KEY=""; MEMBER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CONTEXT="$2"; shift 2 ;;
    --slug) SLUG="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --stakeholder) STAKEHOLDER="$2"; shift 2 ;;
    --owner|--lead) OWNER="$2"; shift 2 ;;
    --team|--members) TEAM="$2"; shift 2 ;;
    --team-id) TEAM_ID="$2"; shift 2 ;;
    --brain-url) BRAIN_URL="$2"; shift 2 ;;
    --api-key) API_KEY="$2"; shift 2 ;;
    --member) MEMBER="$2"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done
OUTPUT="${OUTPUT:-/tmp/$SLUG}"
MEMBER="${MEMBER:-$OWNER}"

# The outward tier label depends on context: consultant→client, employee→company.
if [[ "$CONTEXT" == "employee" ]]; then OUTWARD="company"; else OUTWARD="client"; fi

# Fresh each run.
rm -rf "$OUTPUT"

bash "$SCRIPT_DIR/scaffold-project.sh" \
  --context "$CONTEXT" \
  --slug "$SLUG" --stakeholder "$STAKEHOLDER" --owner "$OWNER" --team "$TEAM" \
  --team-id "$TEAM_ID" --brain-url "$BRAIN_URL" --output "$OUTPUT" >/dev/null

echo "filling sample content…"

# ── team-tier work (with cross-document links for the OKF graph) ──
cat > "$OUTPUT/2-work/charter.md" <<'EOF'
---
status: review
owner: alex
access: team
sprint: sprint-1
---
# Project Charter

Acme runs governance review gates in **advisory mode** for sprint 1 — see the
[governance framework](governance-framework.md) and the recorded calls in the
[decision log](../3-log/decision-log.md).
EOF

cat > "$OUTPUT/2-work/governance-framework.md" <<'EOF'
---
status: draft
owner: sam
access: team
sprint: sprint-1
---
# Governance Framework

Gates are informational this sprint. Rationale and scope live in the
[charter](charter.md).
EOF

# ── outward-tier work (visible to the client/company) ──
cat > "$OUTPUT/2-work/exec-summary.md" <<EOF
---
status: final
owner: alex
access: $OUTWARD
sprint: sprint-1
---
# Executive Summary

Sprint 1 establishes advisory governance and the AI-readiness baseline.
EOF

# ── private-tier file — MUST be blocked by aios push (never leaves the machine) ──
cat > "$OUTPUT/2-work/pricing.md" <<'EOF'
---
status: draft
owner: alex
access: private
---
# Day Rates (confidential)

Internal commercial detail — must never sync.
EOF

# ── a transcript ──
mkdir -p "$OUTPUT/1-inbox/transcripts"
cat > "$OUTPUT/1-inbox/transcripts/2026-06-01-kickoff.md" <<'EOF'
---
type: transcript
access: team
created: 2026-06-01
---
# Kickoff call

Agreed to run gates in advisory mode and revisit at sprint close.
EOF

# ── status rows ──
cat >> "$OUTPUT/3-log/tasks.md" <<'EOF'
| T-01 | Draft project charter | alex | in_progress | sprint-1 | 2026-06-30 |
| T-02 | Finalize governance framework | sam | ready | sprint-1 | |
| T-03 | AI-readiness baseline | alex | done | sprint-1 | 2026-06-12 |
EOF

cat >> "$OUTPUT/3-log/decision-log.md" <<EOF
| 1 | 2026-06-01 | Run governance gates in advisory mode for sprint 1 | Avoid blocking delivery while teams build fluency | alex | Gates informational this sprint | 2 | team |
| 2 | 2026-06-02 | Share exec summary with stakeholder leadership | Keep sponsors aligned | alex | External-facing | 1 | $OUTWARD |
EOF

# ── wire identity + key into .env (gitignored) so `aios` auto-loads them ──
if [[ -n "$API_KEY" || -n "$MEMBER" ]]; then
  {
    echo "# written by demo-spoke.sh — local testing only"
    [[ -n "$API_KEY" ]] && echo "AIOS_API_KEY=$API_KEY"
    [[ -n "$MEMBER"  ]] && echo "AIOS_MEMBER=$MEMBER"
  } >> "$OUTPUT/.env"
fi

echo ""
echo "spoke ready: $OUTPUT  (context: $CONTEXT)"
echo "  team-tier:     charter.md, governance-framework.md, kickoff transcript, tasks, decisions"
echo "  $OUTWARD-tier:  exec-summary.md"
echo "  private-tier:  pricing.md  (will be BLOCKED by aios push)"
if [[ -n "$BRAIN_URL" && -n "$API_KEY" ]]; then
  echo ""
  echo "next:"
  echo "  cd $OUTPUT"
  echo "  aios status        # charter/tasks new; pricing blocked"
  echo "  aios push"
  echo "  aios query \"what is the governance gate policy?\""
fi
