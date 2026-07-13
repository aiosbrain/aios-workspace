#!/usr/bin/env bash
# aios-sync-nudge.sh — Stop/SessionEnd hook for Claude Code (Agentic Team Ops)
#
# READ-ONLY nudge: if sync-eligible files have changed since the last push,
# print a reminder. Never pushes — silent network writes of project content
# would contradict the deliberate-promotion ethos.
#
# Register in .claude/settings.json under hooks.Stop (or SessionEnd).

set -euo pipefail

# Deep-work means no ambient AIOS notifications. This hook is a notifier, unlike the asks
# capture hook, so it must respect Claude Code's machine-global preference and fail open.
if node -e '
  const fs = require("node:fs");
  try {
    const s = JSON.parse(fs.readFileSync(process.env.HOME + "/.claude/settings.json", "utf8"));
    process.exit(s.preferredNotifChannel === "notifications_disabled" ? 0 : 1);
  } catch { process.exit(1); }
'; then
  exit 0
fi

# Find the repo root (aios.yaml) from cwd
DIR="$(pwd)"
while [ "$DIR" != "/" ]; do
  [ -f "$DIR/aios.yaml" ] && break
  DIR="$(dirname "$DIR")"
done
[ -f "$DIR/aios.yaml" ] || exit 0  # not a team-ops repo — stay silent

# Locate the aios CLI: alongside this hook's toolkit, or on PATH
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AIOS="$HOOK_DIR/../scripts/aios.mjs"
if [ ! -f "$AIOS" ]; then
  command -v aios >/dev/null 2>&1 || exit 0
  AIOS="$(command -v aios)"
fi

# Count pending items (status is fully offline). Tolerate any failure silently.
PORCELAIN=$(node "$AIOS" status --porcelain --repo "$DIR" 2>/dev/null || true)
NEW=$(echo "$PORCELAIN" | sed -n 's/.*new=\([0-9]*\).*/\1/p')
MOD=$(echo "$PORCELAIN" | sed -n 's/.*modified=\([0-9]*\).*/\1/p')
PENDING=$(( ${NEW:-0} + ${MOD:-0} ))

if [ "$PENDING" -gt 0 ]; then
  echo "aios: $PENDING sync-eligible file(s) changed since last push — run 'aios push' (or the aios-sync skill) when ready."
fi
exit 0
