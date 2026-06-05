#!/bin/bash
# check-frontmatter.sh — OGR02: Validate YAML frontmatter in markdown files
#
# Usage:
#   ./validation/check-frontmatter.sh <path-to-team-ops-repo>
#
# Checks that .md files have valid YAML frontmatter with required fields.

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
CHECKED=0
SKIPPED=0

if [ ! -d "$REPO" ]; then
  echo -e "${RED}Error: Directory not found: $REPO${NC}"
  exit 1
fi

echo "OGR02: Checking frontmatter in $REPO"
echo "================================================"

# Find all .md files, excluding hidden dirs, node_modules, .git
while IFS= read -r file; do
  # Skip files that are just .gitkeep or very small
  if [ "$(wc -l < "$file" 2>/dev/null)" -lt 3 ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  CHECKED=$((CHECKED + 1))
  rel_path="${file#$REPO/}"

  # Check if file starts with ---
  first_line=$(head -1 "$file" 2>/dev/null || echo "")
  if [ "$first_line" != "---" ]; then
    echo -e "  ${YELLOW}!${NC} $rel_path — no frontmatter"
    WARNINGS=$((WARNINGS + 1))
    continue
  fi

  # Extract frontmatter (between first and second ---)
  frontmatter=$(awk '/^---$/{n++; next} n==1{print} n>=2{exit}' "$file" 2>/dev/null)

  if [ -z "$frontmatter" ]; then
    echo -e "  ${RED}✗${NC} $rel_path — empty or unclosed frontmatter"
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Check for required fields based on directory
  has_field() {
    echo "$frontmatter" | grep -q "^$1:" 2>/dev/null
  }

  missing_fields=()

  # All files should have these if they have frontmatter
  if ! has_field "status"; then
    missing_fields+=("status")
  fi

  # Files in 02-deliverables should have owner
  if echo "$rel_path" | grep -q "^02-deliverables/"; then
    if ! has_field "owner"; then
      missing_fields+=("owner")
    fi
  fi

  # Files in 04-client-surface should have access
  if echo "$rel_path" | grep -q "^04-client-surface/"; then
    if ! has_field "access"; then
      missing_fields+=("access")
    fi
  fi

  if [ ${#missing_fields[@]} -gt 0 ]; then
    echo -e "  ${YELLOW}!${NC} $rel_path — missing: ${missing_fields[*]}"
    WARNINGS=$((WARNINGS + 1))
  fi

done < <(find "$REPO" -name "*.md" \
  -not -path "*/.git/*" \
  -not -path "*/.planning/*" \
  -not -path "*/node_modules/*" \
  -not -path "*/.claude/*" \
  -not -name "CLAUDE.md" \
  -not -name "MEMORY.md" \
  -not -name "README.md" \
  -not -name "decision-log.md" \
  -not -name "hours-log.md" \
  -not -name "hours-log-*.md" \
  -not -name "tasks.md" \
  -not -name "learnings.md" \
  -not -name "client-surface-log.md" \
  | sort)

# Summary
echo ""
echo "================================================"
echo "Checked: $CHECKED files | Skipped: $SKIPPED files"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo -e "${GREEN}OGR02 PASSED — all frontmatter valid${NC}"
  exit 0
elif [ $ERRORS -eq 0 ]; then
  echo -e "${YELLOW}OGR02 PASSED with $WARNINGS warning(s)${NC}"
  exit 0
else
  echo -e "${RED}OGR02 FAILED — $ERRORS error(s), $WARNINGS warning(s)${NC}"
  exit 1
fi
