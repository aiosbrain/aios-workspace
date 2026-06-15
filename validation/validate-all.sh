#!/bin/bash
# validate-all.sh — Run all OGR validators against a team-ops repo
#
# Usage:
#   ./validation/validate-all.sh <path-to-team-ops-repo>
#   ./validation/validate-all.sh <path> --critical    # OGR03 only
#   ./validation/validate-all.sh <path> --quick       # OGR01 only

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ $# -eq 0 ]; then
  echo "Usage: $0 <path-to-team-ops-repo> [--critical|--quick]"
  exit 1
fi

REPO="$1"
MODE="${2:-all}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FAILED=0

echo -e "${BLUE}Agentic Team Ops — OGR Validation${NC}"
echo "Target: $REPO"
echo "Mode: $MODE"
echo "================================================"
echo ""

run_check() {
  local name="$1"
  local script="$2"

  echo -e "${BLUE}Running $name...${NC}"
  if "$script" "$REPO"; then
    echo ""
  else
    FAILED=$((FAILED + 1))
    echo ""
  fi
}

case "$MODE" in
  --critical)
    run_check "OGR03 — Secrets Scanner" "$SCRIPT_DIR/check-secrets.sh"
    ;;
  --quick)
    run_check "OGR01 — Folder Structure" "$SCRIPT_DIR/check-structure.sh"
    ;;
  all|*)
    run_check "OGR01 — Folder Structure" "$SCRIPT_DIR/check-structure.sh"
    run_check "OGR02 — Frontmatter" "$SCRIPT_DIR/check-frontmatter.sh"
    run_check "OGR03 — Secrets Scanner" "$SCRIPT_DIR/check-secrets.sh"
    run_check "OGR04 — AIOS Config" "$SCRIPT_DIR/check-aios-config.sh"
    run_check "OGR05 — Rubrics + Memory" "$SCRIPT_DIR/check-rubrics.sh"
    run_check "OGR06 — Skill Export (BYOA)" "$SCRIPT_DIR/check-skill-export.mjs"
    ;;
esac

echo "================================================"
if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All validators passed.${NC}"
  exit 0
else
  echo -e "${RED}$FAILED validator(s) failed.${NC}"
  exit 1
fi
