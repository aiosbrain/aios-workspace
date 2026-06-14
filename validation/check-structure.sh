#!/bin/bash
# check-structure.sh — OGR01: Validate team-ops folder structure
#
# Usage:
#   ./validation/check-structure.sh <path-to-team-ops-repo>
#
# Validates the numbered spine and required files exist.

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m'

if [ $# -eq 0 ]; then
  echo "Usage: $0 <path-to-team-ops-repo>"
  exit 1
fi

REPO="$1"
ERRORS=0
WARNINGS=0

if [ ! -d "$REPO" ]; then
  echo -e "${RED}Error: Directory not found: $REPO${NC}"
  exit 1
fi

echo "OGR01: Checking folder structure in $REPO"
echo "================================================"

# Required spine directories. Entries with | accept either name:
# new intent-named spine first, then legacy numbered spine (back-compat).
REQUIRED_DIRS=(
  "0-context|00-project|00-engagement"
  "1-inbox|01-intake"
  "2-work|02-deliverables"
  "3-log|03-status"
  "4-shared|04-client-surface"
  "5-personal|05-personal"
)

for dir_spec in "${REQUIRED_DIRS[@]}"; do
  found=""
  IFS='|' read -ra ALTS <<< "$dir_spec"
  for alt in "${ALTS[@]}"; do
    if [ -d "$REPO/$alt" ]; then
      found="$alt"
      break
    fi
  done
  if [ -n "$found" ]; then
    echo -e "  ${GREEN}✓${NC} $found/"
  else
    echo -e "  ${RED}✗${NC} ${dir_spec//|/ or }/ — MISSING"
    ERRORS=$((ERRORS + 1))
  fi
done

# Required top-level files (| = accept either)
REQUIRED_FILES=(
  "README.md"
  "workspace.yaml|project.yaml|engagement.yaml"
  "contacts.yaml"
)

echo ""
echo "Required files:"
for file_spec in "${REQUIRED_FILES[@]}"; do
  found=""
  IFS='|' read -ra ALTS <<< "$file_spec"
  for alt in "${ALTS[@]}"; do
    if [ -f "$REPO/$alt" ]; then
      found="$alt"
      break
    fi
  done
  if [ -n "$found" ]; then
    echo -e "  ${GREEN}✓${NC} $found"
  else
    echo -e "  ${RED}✗${NC} ${file_spec//|/ or } — MISSING"
    ERRORS=$((ERRORS + 1))
  fi
done

# Personal area. New IC model: a single flat 5-personal/ (one person's private
# scratch). Legacy team model: 05-personal/<name>/ with a mirrored sub-spine.
echo ""
echo "Personal area:"
if [ -d "$REPO/5-personal" ]; then
  echo -e "  ${GREEN}✓${NC} 5-personal/ (private, never syncs)"
elif [ -d "$REPO/05-personal" ]; then
  for person_dir in "$REPO"/05-personal/*/; do
    [ -d "$person_dir" ] && echo -e "  ${GREEN}✓${NC} 05-personal/$(basename "$person_dir")/ (legacy)"
  done
else
  echo -e "  ${RED}✗${NC} 5-personal/ not found"
  ERRORS=$((ERRORS + 1))
fi

# Log files (decisions/tasks/hours). New: 3-log/*; legacy: 03-status/*.
echo ""
echo "Log files:"
LOG_DIR=""
[ -d "$REPO/3-log" ] && LOG_DIR="3-log"
[ -z "$LOG_DIR" ] && [ -d "$REPO/03-status" ] && LOG_DIR="03-status"
for base in decision-log.md tasks.md hours-log.md; do
  if [ -n "$LOG_DIR" ] && [ -f "$REPO/$LOG_DIR/$base" ]; then
    echo -e "  ${GREEN}✓${NC} $LOG_DIR/$base"
  else
    echo -e "  ${YELLOW}!${NC} ${LOG_DIR:-3-log}/$base — missing (recommended)"
    WARNINGS=$((WARNINGS + 1))
  fi
done

# OKF index files (Tier 3 — warn, not error; repos predating Tier 3 are valid)
# 05-personal/ is a private workspace without an OKF nav layer — skip it.
echo ""
echo "OKF index files:"
for dir_spec in "${REQUIRED_DIRS[@]}"; do
  if [[ "$dir_spec" == 5-personal* ]]; then continue; fi  # private area — no nav layer
  IFS='|' read -ra ALTS <<< "$dir_spec"
  for alt in "${ALTS[@]}"; do
    if [ -d "$REPO/$alt" ]; then
      if [ -f "$REPO/$alt/index.md" ]; then
        echo -e "  ${GREEN}✓${NC} $alt/index.md"
      else
        echo -e "  ${YELLOW}!${NC} $alt/index.md — missing (OKF nav layer; run scaffold to generate)"
        WARNINGS=$((WARNINGS + 1))
      fi
      break
    fi
  done
done

# Summary
echo ""
echo "================================================"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo -e "${GREEN}OGR01 PASSED — all checks clean${NC}"
  exit 0
elif [ $ERRORS -eq 0 ]; then
  echo -e "${YELLOW}OGR01 PASSED with $WARNINGS warning(s)${NC}"
  exit 0
else
  echo -e "${RED}OGR01 FAILED — $ERRORS error(s), $WARNINGS warning(s)${NC}"
  exit 1
fi
