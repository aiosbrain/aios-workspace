#!/usr/bin/env bash
# team-ops-guard.sh — PreToolUse hook for Claude Code (Agentic Team Ops)
#
# Fires on Write/Edit tool calls. Validates the file being written.
# Exit 0 = allow, Exit 1 + stderr message = block.
#
# Checks:
#   1. Secrets scan (API keys, tokens, passwords)
#   2. Access tag enforcement (no admin content in team/client dirs)
#   3. Frontmatter required for deliverables/client-surface
#
# Environment (set by Claude Code):
#   CC_TOOL_NAME — the tool being used (Write, Edit)
#   CC_TOOL_INPUT — JSON with the tool parameters

set -euo pipefail

# Parse tool input
TOOL_INPUT="${CC_TOOL_INPUT:-}"
if [ -z "$TOOL_INPUT" ]; then
  exit 0  # No input to check — allow
fi

# Extract file path from tool input
FILE_PATH=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // empty' 2>/dev/null || true)
if [ -z "$FILE_PATH" ]; then
  exit 0  # Can't determine file path — allow
fi

# Only check files we care about (markdown, yaml, config)
case "$FILE_PATH" in
  *.md|*.yaml|*.yml|*.json|*.sh|*.py|*.ts|*.js)
    ;; # Continue checking
  *)
    exit 0  # Not a text file we check — allow
    ;;
esac

# Get the content being written
CONTENT=$(echo "$TOOL_INPUT" | jq -r '.content // .new_string // empty' 2>/dev/null || true)
if [ -z "$CONTENT" ]; then
  exit 0  # No content to check — allow (might be a read or other op)
fi

# ── Check 1: Secrets ────────────────────────────────────────────────
# Patterns are shared with validation/check-secrets.sh and scripts/aios.mjs
# via validation/secret-patterns.txt (single source — they must not drift).

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATTERNS_FILE="$HOOK_DIR/../validation/secret-patterns.txt"

SECRETS_PATTERNS=()
if [ -f "$PATTERNS_FILE" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    SECRETS_PATTERNS+=("$line")
  done < "$PATTERNS_FILE"
else
  # Fallback if the shared file is missing (e.g. hook copied standalone)
  SECRETS_PATTERNS=(
    "AKIA[0-9A-Z]{16}"
    "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
    "gh[ps]_[A-Za-z0-9_]{36,}"
    "xox[bporas]-[A-Za-z0-9-]+"
    "sk-[A-Za-z0-9]{40,}"
  )
fi

for pattern in "${SECRETS_PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qE "$pattern" 2>/dev/null; then
    echo "BLOCKED by team-ops-guard: Potential secret detected in $FILE_PATH" >&2
    echo "Pattern matched: $pattern" >&2
    echo "Remove the secret before writing this file." >&2
    exit 1
  fi
done

# ── Check 2: Access tag enforcement ────────────────────────────────

# Only enforce on outward/shared directories (new 4-shared; legacy variants)
if echo "$FILE_PATH" | grep -qE "(4-shared|04-shared|04-client-surface|06-client-surface|05-workspace)" 2>/dev/null; then
  SENSITIVE_PATTERNS=(
    'day rate'
    'Day Rate'
    'EUR/day'
    'USD/day'
    'margin'
    'markup'
    'cost model'
    'sub rate'
    'subcontractor rate'
    'consultant rate'
    'client rate'
    'P&L'
    'psychological profile'
    'stakeholder psych'
    'negotiation strateg'
  )

  for pattern in "${SENSITIVE_PATTERNS[@]}"; do
    if echo "$CONTENT" | grep -qi "$pattern" 2>/dev/null; then
      echo "BLOCKED by team-ops-guard: Admin-only content detected in team/client directory" >&2
      echo "File: $FILE_PATH" >&2
      echo "Pattern: '$pattern'" >&2
      echo "Admin-tier content cannot be written to workspace or client-surface directories." >&2
      exit 1
    fi
  done
fi

# ── Check 3: Frontmatter required ──────────────────────────────────

# Only for markdown files in work/deliverables or shared (new + legacy)
if echo "$FILE_PATH" | grep -qE "(2-work|02-deliverables|4-shared|04-shared|04-client-surface|06-client-surface)" 2>/dev/null; then
  if echo "$FILE_PATH" | grep -qE "\.md$" 2>/dev/null; then
    # For Write tool, check if content starts with ---
    if [ "$(echo "$TOOL_INPUT" | jq -r '.content // empty' 2>/dev/null)" != "" ]; then
      if ! echo "$CONTENT" | head -1 | grep -q "^---" 2>/dev/null; then
        echo "BLOCKED by team-ops-guard: Markdown files in deliverables/client-surface require YAML frontmatter" >&2
        echo "File: $FILE_PATH" >&2
        echo "Add frontmatter with at least: status, owner" >&2
        exit 1
      fi
    fi
  fi
fi

# All checks passed
exit 0
