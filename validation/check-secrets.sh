#!/bin/bash
# check-secrets.sh — OGR03: Scan for secrets in committed files
#
# Usage:
#   ./validation/check-secrets.sh <path-to-repo>
#
# CRITICAL severity — any match is a hard failure.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

if [ $# -eq 0 ]; then
  echo "Usage: $0 <path-to-repo>"
  exit 1
fi

REPO="$1"
ERRORS=0

if [ ! -d "$REPO" ]; then
  echo -e "${RED}Error: Directory not found: $REPO${NC}"
  exit 1
fi

echo "OGR03: Scanning for secrets in $REPO"
echo "================================================"
echo -e "${RED}SEVERITY: CRITICAL — any match blocks${NC}"
echo ""

# Patterns to detect secrets
# Each entry: "label|regex"
PATTERNS=(
  "AWS Access Key|AKIA[0-9A-Z]{16}"
  "AWS Secret Key|aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}"
  "Generic API Key|['\"]?api[_-]?key['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]"
  "Generic Secret|['\"]?secret['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]"
  "Generic Token|['\"]?token['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]"
  "Private Key Header|-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
  "GitHub Token|gh[ps]_[A-Za-z0-9_]{36,}"
  "Slack Token|xox[bporas]-[A-Za-z0-9-]+"
  "Toggl API Token|[0-9a-f]{32}"
  "Basic Auth URL|https?://[^:]+:[^@]+@"
  "Password Assignment|password\s*[:=]\s*['\"][^'\"]{8,}['\"]"
  "Bearer Token|Bearer\s+[A-Za-z0-9_\-\.]{20,}"
)

# Files to scan (exclude .git, binary files, .env.example, the vendored
# skill-library — integrity-locked official upstream skills (OGR09), whose docs
# carry example/placeholder tokens like "xoxp-new-..." that are not real secrets —
# skill-scan-fixtures, the deliberately-malicious scanner test inputs, and the
# gitignored agentic UX-testing harness OUTPUT (test/ux/evidence/ — screenshots
# and transcripts from throwaway cockpit fixtures). Committed harness code and
# fixtures ARE scanned: they use clearly-non-secret dummy values.)
SCAN_FILES=$(find "$REPO" \
  -not -path "*/.git/*" \
  -not -path "*/node_modules/*" \
  -not -path "*/skill-library/*" \
  -not -path "*/skill-scan-fixtures/*" \
  -not -path "*/test/ux/evidence/*" \
  -not -path "*/.env.example" \
  -not -name "*.pdf" \
  -not -name "*.png" \
  -not -name "*.jpg" \
  -not -name "*.jpeg" \
  -not -name "*.gif" \
  -not -name "*.xlsx" \
  -not -name "*.docx" \
  -not -name "check-secrets.sh" \
  -not -name "secret-patterns.txt" \
  -type f 2>/dev/null || true)

# Merge in shared patterns (validation/secret-patterns.txt) — the single
# source also consumed by hooks/team-ops-guard.sh and scripts/aios.mjs.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/secret-patterns.txt" ]; then
  while IFS= read -r shared_pattern; do
    [ -z "$shared_pattern" ] && continue
    case "$shared_pattern" in \#*) continue ;; esac
    PATTERNS+=("Shared pattern|$shared_pattern")
  done < "$SCRIPT_DIR/secret-patterns.txt"
fi

for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"

  # Special case: Toggl tokens are 32-char hex but appear in many contexts
  # Only flag if near "toggl" or "api" keywords
  if [ "$label" = "Toggl API Token" ]; then
    matches=$(echo "$SCAN_FILES" | xargs grep -lniE "(toggl|api).{0,20}$pattern" 2>/dev/null || true)
  else
    matches=$(echo "$SCAN_FILES" | xargs grep -lniE "$pattern" 2>/dev/null || true)
  fi

  if [ -n "$matches" ]; then
    echo -e "  ${RED}✗ $label${NC}"
    while IFS= read -r match_file; do
      rel_path="${match_file#$REPO/}"
      # Show the matching line (truncated) but redact the actual secret
      line=$(grep -niE "$pattern" "$match_file" 2>/dev/null | head -3 | sed 's/\(.\{80\}\).*/\1.../')
      echo "    $rel_path:"
      echo "$line" | while IFS= read -r l; do
        echo "      $l"
      done
    done <<< "$matches"
    ERRORS=$((ERRORS + 1))
  fi
done

# Also check for .env files that shouldn't be committed
ENV_FILES=$(find "$REPO" -name ".env" -not -name ".env.example" -not -name ".env.template" -not -path "*/.git/*" 2>/dev/null || true)
if [ -n "$ENV_FILES" ]; then
  echo -e "  ${RED}✗ .env file committed${NC}"
  while IFS= read -r env_file; do
    rel_path="${env_file#$REPO/}"
    echo "    $rel_path"
  done <<< "$ENV_FILES"
  ERRORS=$((ERRORS + 1))
fi

# Summary
echo ""
echo "================================================"
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}OGR03 PASSED — no secrets detected${NC}"
  exit 0
else
  echo -e "${RED}OGR03 FAILED — $ERRORS pattern(s) matched${NC}"
  echo "Review matches above. Remove secrets and rotate any exposed credentials."
  exit 1
fi
