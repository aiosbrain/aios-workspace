#!/usr/bin/env bash
# team-ops-guard.sh — PreToolUse hook for Claude Code (Agentic Team Ops)
#
# Fires on Write/Edit/MultiEdit tool calls. Validates the file being written.
# Exit 0 = allow (no decision), Exit 2 + stderr = BLOCK (Claude Code's deny signal;
# any other non-zero is a non-blocking error, so blocks MUST use exit 2).
#
# Checks:
#   1. Secrets scan (API keys, tokens, passwords)
#   2. Access tag enforcement (no admin content in team/client dirs)
#   3. Frontmatter required for deliverables/client-surface
#
# Input: current Claude Code sends a JSON event on STDIN:
#   { "tool_name": "...", "tool_input": { "file_path": "...", "content": "..." } }
# We also accept CC_TOOL_NAME / CC_TOOL_INPUT env vars (used by the GUI's
# host-side guardWrite, which has no stdin). STDIN wins when present.

set -euo pipefail

# Parse tool input from stdin JSON (Claude Code) or env (GUI guardWrite).
STDIN_JSON=$(cat 2>/dev/null || true)
if [ -n "$STDIN_JSON" ]; then
  TOOL_INPUT=$(printf '%s' "$STDIN_JSON" | jq -c '.tool_input // empty' 2>/dev/null || true)
else
  TOOL_INPUT="${CC_TOOL_INPUT:-}"
fi
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

# Aggregate Write, Edit, and every MultiEdit replacement so no batch member bypasses the gate.
CONTENT=$(echo "$TOOL_INPUT" | jq -r '[.content?, .new_string?, (.edits[]?.new_string?)] | map(select(type == "string")) | join("\n")' 2>/dev/null || true)
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
    "sk-[A-Za-z0-9_-]{40,}"
    "sk-ant-[A-Za-z0-9_-]{20,}"
    "aios_[A-Za-z0-9]+_[A-Za-z0-9]{24,}"
    "https?://[^/:@ ]+:[^/@ ]+@"
    "[Bb]earer [A-Za-z0-9_\\-\\.=]{30,}"
    "github_pat_[A-Za-z0-9_]{22,}"
    "AIza[0-9A-Za-z_\\-]{35}"
    "[sr]k_live_[A-Za-z0-9]{20,}"
    "npm_[A-Za-z0-9]{36}"
    "eyJ[A-Za-z0-9_\\-]{10,}\\.eyJ[A-Za-z0-9_\\-]{10,}\\.[A-Za-z0-9_\\-]{10,}"
  )
fi

for pattern in "${SECRETS_PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qE -e "$pattern" 2>/dev/null; then
    echo "BLOCKED by team-ops-guard: Potential secret detected in $FILE_PATH" >&2
    echo "Pattern matched: $pattern" >&2
    echo "Remove the secret before writing this file." >&2
    exit 2
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
      exit 2
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
        exit 2
      fi
    fi
  fi
fi

# All checks passed
exit 0
