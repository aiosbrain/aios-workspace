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
BLUE='\033[0;34m'
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

# List the .md files to check, excluding hidden dirs, node_modules, .git and the
# conventional non-frontmatter documents.
#
# Enumeration is via GIT, never a filesystem walk (AIO-517): a bare `find` descends into
# gitignored build trees (`src-tauri/target` is 1.6 GB / 35k files here), which is both
# slow and wrong — build output is not workspace content and can never carry frontmatter
# anyone must fix. Tracked + untracked-but-not-ignored is exactly the content set OGR02
# governs. Non-git targets keep the walk.
md_candidates() {
  if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    {
      git -C "$REPO" ls-files
      git -C "$REPO" ls-files -o --exclude-standard
    }
  else
    find "$REPO" -not -path "*/.git/*" -not -path "*/node_modules/*" -type f 2>/dev/null |
      sed "s|^${REPO%/}/||"
  fi
}

list_md_files() {
  local rel abs
  while IFS= read -r rel; do
    case "/$rel" in
      *.md) ;;
      *) continue ;;
    esac
    case "/$rel" in
      */.git/* | */.planning/* | */node_modules/* | */.claude/* | */.aios/*) continue ;;
      */CLAUDE.md | */MEMORY.md | */README.md | */decision-log.md) continue ;;
      */hours-log.md | */hours-log-*.md | */tasks.md | */learnings.md) continue ;;
      */client-surface-log.md | */index.md) continue ;;
    esac
    abs="$REPO/$rel"
    [ -L "$abs" ] && continue
    [ -f "$abs" ] || continue
    printf '%s\n' "$abs"
  done
}

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

  # Work deliverables should have owner (new 2-work/; legacy 02-deliverables/)
  if echo "$rel_path" | grep -qE "^(2-work|02-deliverables)/"; then
    if ! has_field "owner"; then
      missing_fields+=("owner")
    fi
  fi

  # Outward-shared files should have access (new 4-shared/; legacy 04-client-surface/)
  if echo "$rel_path" | grep -qE "^(4-shared|04-shared|04-client-surface)/"; then
    if ! has_field "access"; then
      missing_fields+=("access")
    fi
  fi

  if [ ${#missing_fields[@]} -gt 0 ]; then
    echo -e "  ${YELLOW}!${NC} $rel_path — missing: ${missing_fields[*]}"
    WARNINGS=$((WARNINGS + 1))
  fi

  # OKF advisory: type is recommended but not required.
  # Enable with: AIOS_OKF_LINT=1 ./validation/check-frontmatter.sh <repo>
  if [ "${AIOS_OKF_LINT:-0}" = "1" ] && ! has_field "type"; then
    echo -e "  ${BLUE}i${NC} $rel_path — OKF: consider adding \`type:\` (see scaffold/.claude/rules/frontmatter.md)"
    WARNINGS=$((WARNINGS + 1))
  fi

done < <(md_candidates | list_md_files | sort)

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
