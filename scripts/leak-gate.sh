#!/usr/bin/env bash
# leak-gate.sh — confidentiality leak gate for the Agentic Team Ops repo.
#
# Scans the tree for any identifier that must never appear in this open-source
# repository: client/firm names, person names, venture/product codenames, and
# business-data patterns. The term set is derived from the engagement's
# Confidentiality Confirmation (the definition of protected Confidential
# Information). This repo contains ONLY generic structure, harness code, and
# synthetic example data — so a clean run returns ZERO matches.
#
# Usage: scripts/leak-gate.sh [ROOT]   (defaults to repo root)
# Exit 0 = clean; exit 1 = at least one forbidden term found.

set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

# Exclusions: VCS, this script (it necessarily contains the terms), binaries, and
# LICENSE (the copyright holder — the repo owner — legitimately appears there).
EXCLUDES=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv
  --exclude-dir=__pycache__ --exclude-dir=store --exclude=leak-gate.sh
  --exclude=LICENSE
  --exclude=*.png --exclude=*.jpg --exclude=*.pdf --exclude=*.lock)

# STRONG terms — unambiguous; any occurrence is a leak. Case-insensitive substring.
STRONG='ideawise|kaufmich|fakecheck|pravos|vibrana|kinsai-studio|kinsai|smarthoods|adaptai|cooncircles|youhavetoadapt|optimise media|optimise-media|optimisemediagroup|elxis|company graph|company-graph|ideawisegroup|24z\.de|john-ellison|iamjohndass|/Users/iamjohndass|dreyer|hammen|reisner|astanina|vanderplanken|florijn|de graaf|degraaf|ledain|ghedira|isleem|martin doll|julius|christoph|yvonne|katya|blaise|yiannis|robbie|fatma|stephan|miguel|crespo'

# WORD-BOUNDED terms — short/ambiguous client identifiers; match only as whole
# words to avoid false positives (e.g. Tine in "routine", Abe in "label").
# NOTE: generic third-party SaaS names (Jira, Confluence, Toggl, Slack, etc.) are
# NOT confidential identifiers and may appear in generic integration/secret-scan
# code, so they are deliberately NOT gated here.
WORDS='Ideawise|Pravos|Anna|Tine|Andre|André|Abe|eNPS|OKR|OKRs'

# PATTERN terms — structured business data.
PATTERNS='ANT-[0-9]+|CO-[12][[:space:]]|INV-[0-9]+|€[0-9]|EUR[[:space:]]*[0-9]'

fail=0
hit() { echo "LEAK: $1"; echo "$2" | sed 's/^/    /'; fail=1; }

out=$(grep -rEIn "${EXCLUDES[@]}" -i -- "$STRONG" "$ROOT" 2>/dev/null || true)
[ -n "$out" ] && hit "client/person/firm identifier (substring)" "$out"

out=$(grep -rEwIn "${EXCLUDES[@]}" -- "$WORDS" "$ROOT" 2>/dev/null || true)
[ -n "$out" ] && hit "client/person identifier (word)" "$out"

out=$(grep -rEIn "${EXCLUDES[@]}" -- "$PATTERNS" "$ROOT" 2>/dev/null || true)
[ -n "$out" ] && hit "business-data pattern (ticket/CO/invoice/amount)" "$out"

if [ "$fail" -eq 0 ]; then
  echo "leak-gate: CLEAN — no forbidden identifiers found under $ROOT"
  exit 0
else
  echo "leak-gate: FAILED — forbidden identifiers above must be removed."
  exit 1
fi
