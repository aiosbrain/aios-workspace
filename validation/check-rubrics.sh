#!/bin/bash
# check-rubrics.sh — OGR05: Validate rubric files + memory instinct links
#
# Usage:
#   ./validation/check-rubrics.sh <path-to-team-ops-repo>
#
# Checks:
#   1. Every .claude/rubrics/*.md (except README) has `kind: rubric`
#      frontmatter, an integer `budget`, and >= 1 criterion row with unique IDs.
#   2. Every rule in .claude/memory/instincts.md links >= 1 incident file
#      that exists (rules without evidence don't accumulate).
#
# Optional-pass: repos without rubrics/ or memory/ are valid (older forks).

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

echo "OGR05: Checking rubrics + memory in $REPO"
echo "================================================"

RUBRIC_DIR="$REPO/.claude/rubrics"
if [ -d "$RUBRIC_DIR" ]; then
  for rubric in "$RUBRIC_DIR"/*.md; do
    [ -f "$rubric" ] || continue
    name=$(basename "$rubric")
    [ "$name" = "README.md" ] && continue
    CHECKED=$((CHECKED + 1))

    fm=$(awk '/^---$/{n++; next} n==1{print} n>=2{exit}' "$rubric")

    if ! echo "$fm" | grep -qE '^kind:\s*rubric'; then
      echo -e "  ${RED}✗${NC} $name — missing 'kind: rubric' frontmatter"
      ERRORS=$((ERRORS + 1))
    fi
    if ! echo "$fm" | grep -qE '^budget:\s*[0-9]+\s*$'; then
      echo -e "  ${RED}✗${NC} $name — 'budget:' missing or not an integer"
      ERRORS=$((ERRORS + 1))
    fi
    if ! echo "$fm" | grep -qE '^applies_to:\s*\S'; then
      echo -e "  ${YELLOW}!${NC} $name — no 'applies_to:'"
      WARNINGS=$((WARNINGS + 1))
    fi

    # Criterion rows: table rows that aren't the header or separator
    ids=$(grep -E '^\|' "$rubric" | grep -vE '^\|\s*-' | grep -viE '^\|\s*ID\s*\|' \
      | awk -F'|' '{gsub(/ /,"",$2); print $2}' | grep -v '^$' || true)
    count=$(echo "$ids" | grep -c . || true)
    if [ "${count:-0}" -lt 1 ]; then
      echo -e "  ${RED}✗${NC} $name — no criterion rows found"
      ERRORS=$((ERRORS + 1))
    else
      dupes=$(echo "$ids" | sort | uniq -d)
      if [ -n "$dupes" ]; then
        echo -e "  ${RED}✗${NC} $name — duplicate criterion IDs: $(echo $dupes | tr '\n' ' ')"
        ERRORS=$((ERRORS + 1))
      else
        echo -e "  ${GREEN}✓${NC} $name ($count criteria, unique IDs)"
      fi
    fi
  done
else
  echo -e "  ${GREEN}✓${NC} no .claude/rubrics/ — valid (older fork)"
fi

# ── Memory: every instinct links >= 1 existing incident
INSTINCTS="$REPO/.claude/memory/instincts.md"
if [ -f "$INSTINCTS" ]; then
  echo ""
  echo "Memory instincts:"
  RULES=$(grep -E '^\s*-\s+\*\*R[0-9]+' "$INSTINCTS" || true)
  if [ -z "$RULES" ]; then
    echo -e "  ${GREEN}✓${NC} no distilled rules yet (valid)"
  else
    while IFS= read -r rule; do
      rid=$(echo "$rule" | grep -oE 'R[0-9]+' | head -1)
      links=$(echo "$rule" | grep -oE 'incidents/[A-Za-z0-9._-]+\.md' || true)
      if [ -z "$links" ]; then
        echo -e "  ${RED}✗${NC} $rid — no derived-from incident links"
        ERRORS=$((ERRORS + 1))
        continue
      fi
      ok=true
      for l in $links; do
        if [ ! -f "$REPO/.claude/memory/$l" ]; then
          echo -e "  ${RED}✗${NC} $rid — linked incident missing: $l"
          ERRORS=$((ERRORS + 1))
          ok=false
        fi
      done
      $ok && echo -e "  ${GREEN}✓${NC} $rid ($(echo "$links" | wc -l | xargs) incident link(s))"
    done <<< "$RULES"
  fi
fi

# Summary
echo ""
echo "================================================"
echo "Checked: $CHECKED rubric(s)"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo -e "${GREEN}OGR05 PASSED — rubrics + memory clean${NC}"
  exit 0
elif [ $ERRORS -eq 0 ]; then
  echo -e "${YELLOW}OGR05 PASSED with $WARNINGS warning(s)${NC}"
  exit 0
else
  echo -e "${RED}OGR05 FAILED — $ERRORS error(s), $WARNINGS warning(s)${NC}"
  exit 1
fi
