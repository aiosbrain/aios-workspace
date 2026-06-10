#!/bin/bash
# check-aios-config.sh — OGR04: Validate aios.yaml (Team Brain sync config)
#
# Usage:
#   ./validation/check-aios-config.sh <path-to-team-ops-repo>
#
# Optional-pass: a repo with no aios.yaml is standalone — that's valid.
# Hard failures: `admin` in sync_tiers; api_key_env holding a VALUE instead of
# a variable NAME; nested YAML beyond the restricted subset.

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
CFG="$REPO/aios.yaml"

echo "OGR04: Checking aios.yaml in $REPO"
echo "================================================"

if [ ! -f "$CFG" ]; then
  echo -e "  ${GREEN}✓${NC} no aios.yaml — standalone repo (valid)"
  echo "================================================"
  echo -e "${GREEN}OGR04 PASSED — standalone mode${NC}"
  exit 0
fi

# ── Restricted-subset check: only flat `key: value`, `key:` list headers,
#    `  - item` list entries, comments, and blank lines are allowed.
LINE_NO=0
while IFS= read -r line; do
  LINE_NO=$((LINE_NO + 1))
  [ -z "$(echo "$line" | tr -d '[:space:]')" ] && continue
  case "$line" in \#*|" "*"#"*) ;; esac
  if echo "$line" | grep -qE '^\s*#'; then continue; fi
  if echo "$line" | grep -qE '^[A-Za-z0-9_]+:'; then continue; fi
  if echo "$line" | grep -qE '^\s+-\s+\S'; then continue; fi
  echo -e "  ${RED}✗${NC} line $LINE_NO is outside the restricted YAML subset: $(echo "$line" | head -c 60)"
  echo "     (aios.yaml allows only flat key: value, key: list headers, and '  - item' entries)"
  ERRORS=$((ERRORS + 1))
done < "$CFG"

# ── Required keys
for key in version api_key_env sync_tiers sync_include; do
  if grep -qE "^$key:" "$CFG"; then
    echo -e "  ${GREEN}✓${NC} $key present"
  else
    echo -e "  ${RED}✗${NC} $key — MISSING"
    ERRORS=$((ERRORS + 1))
  fi
done

# ── admin must never be a sync tier (the load-bearing governance rule)
SYNC_TIERS=$(awk '/^sync_tiers:/{f=1;next} /^[A-Za-z0-9_]+:/{f=0} f && /^\s+-/{gsub(/^\s+-\s+/,"");print}' "$CFG")
if echo "$SYNC_TIERS" | grep -qx "admin"; then
  echo -e "  ${RED}✗${NC} sync_tiers contains 'admin' — admin content NEVER syncs. Remove it."
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✓${NC} sync_tiers excludes admin"
fi
for t in $SYNC_TIERS; do
  case "$t" in
    team|external|client) ;;
    *)
      echo -e "  ${RED}✗${NC} unknown sync tier: '$t' (allowed: team, external; legacy: client)"
      ERRORS=$((ERRORS + 1))
      ;;
  esac
done

# ── api_key_env must be a variable NAME, not a value
KEYENV=$(grep -E '^api_key_env:' "$CFG" | sed 's/^api_key_env:[[:space:]]*//' | tr -d '"' | tr -d "'" || true)
if [ -n "$KEYENV" ]; then
  if echo "$KEYENV" | grep -qE '^[A-Z][A-Z0-9_]*$'; then
    echo -e "  ${GREEN}✓${NC} api_key_env is a variable name ($KEYENV)"
  else
    echo -e "  ${RED}✗${NC} api_key_env does not look like an env var NAME: '$KEYENV'"
    echo "     Never put the key itself in aios.yaml."
    ERRORS=$((ERRORS + 1))
  fi
fi

# ── member, if set, should exist in project.yaml/engagement.yaml members
MEMBER=$(grep -E '^member:' "$CFG" | sed 's/^member:[[:space:]]*//' | tr -d '"' | tr -d "'" | xargs || true)
if [ -n "$MEMBER" ]; then
  PROJ=""
  for f in project.yaml engagement.yaml; do
    [ -f "$REPO/$f" ] && PROJ="$REPO/$f" && break
  done
  if [ -n "$PROJ" ] && ! grep -qE "^\s+-\s+$MEMBER\s*$" "$PROJ"; then
    echo -e "  ${YELLOW}!${NC} member '$MEMBER' not found in $(basename "$PROJ") members"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# Summary
echo ""
echo "================================================"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo -e "${GREEN}OGR04 PASSED — aios.yaml clean${NC}"
  exit 0
elif [ $ERRORS -eq 0 ]; then
  echo -e "${YELLOW}OGR04 PASSED with $WARNINGS warning(s)${NC}"
  exit 0
else
  echo -e "${RED}OGR04 FAILED — $ERRORS error(s), $WARNINGS warning(s)${NC}"
  exit 1
fi
