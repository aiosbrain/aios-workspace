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

# Required top-level directories (numbered spine).
# Entries with | accept either name (project profile | legacy engagement profile).
REQUIRED_DIRS=(
  "00-project|00-engagement"
  "01-intake"
  "02-deliverables"
  "03-status"
  "04-shared|04-client-surface"
  "05-personal"
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
  "project.yaml|engagement.yaml"
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

# Check personal folders have expected structure
echo ""
echo "Personal folders:"
if [ -d "$REPO/05-personal" ]; then
  for person_dir in "$REPO"/05-personal/*/; do
    if [ -d "$person_dir" ]; then
      person=$(basename "$person_dir")
      echo "  $person/:"

      PERSONAL_DIRS=(
        "01-intake"
        "02-deliverables"
        "03-status"
      )

      for subdir in "${PERSONAL_DIRS[@]}"; do
        if [ -d "$person_dir/$subdir" ]; then
          echo -e "    ${GREEN}✓${NC} $subdir/"
        else
          echo -e "    ${YELLOW}!${NC} $subdir/ — missing (recommended)"
          WARNINGS=$((WARNINGS + 1))
        fi
      done
    fi
  done
else
  echo -e "  ${RED}✗${NC} 05-personal/ not found"
  ERRORS=$((ERRORS + 1))
fi

# Check status files
echo ""
echo "Status files:"
STATUS_FILES=(
  "03-status/decision-log.md"
  "03-status/hours-log.md"
  "03-status/tasks.md"
)

for file in "${STATUS_FILES[@]}"; do
  if [ -f "$REPO/$file" ]; then
    echo -e "  ${GREEN}✓${NC} $file"
  else
    echo -e "  ${YELLOW}!${NC} $file — missing (recommended)"
    WARNINGS=$((WARNINGS + 1))
  fi
done

# OKF index files (Tier 3 — warn, not error; repos predating Tier 3 are valid)
# 05-personal/ is a private workspace without an OKF nav layer — skip it.
echo ""
echo "OKF index files:"
for dir_spec in "${REQUIRED_DIRS[@]}"; do
  if [[ "$dir_spec" == "05-personal" ]]; then continue; fi
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
