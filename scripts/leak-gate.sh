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

# Exclusions: VCS, this script (it necessarily contains the terms), binaries,
# LICENSE (the copyright holder legitimately appears there), and docs/strategy/
# (INTERNAL, reviewer-only studio strategy — verified free of client identifiers,
# carries the studio brand, and is REMOVED before any public release; see
# RELEASE-CHECKLIST.md and docs/strategy/README.md).
EXCLUDES=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=.venv
  --exclude-dir=__pycache__ --exclude-dir=store --exclude-dir=strategy
  --exclude-dir=skill-library --exclude-dir=skill-scan-fixtures
  --exclude-dir=target
  --exclude-dir=evidence --exclude=.env --exclude=.env.local --exclude=.env.keys
  --exclude=.git --exclude=leak-gate.sh --exclude=LICENSE
  --exclude=*.png --exclude=*.jpg --exclude=*.pdf --exclude=*.lock)
# skill-library/ holds vendored, integrity-locked official upstream skills (OGR09);
# their example docs may mention generic names — not AIOS client identifiers.
# skill-scan-fixtures/ holds DELIBERATELY-malicious scanner test fixtures (injection +
# fake secret/exfil strings) — they are test inputs, never shipped to a workspace.
# target/ — Rust/Tauri build output embeds absolute local paths in .d files; gitignored.
# evidence/ — gitignored UX harness output under test/ux/ (transcripts with local paths); not in CI.
# .env* — local-only config (gitignored); may contain member handles for local dev.

# STRONG terms — unambiguous; any occurrence is a leak. Case-insensitive substring.
# Note: "company graph" is NOT gated — the Confidentiality Confirmation (§1.2(a))
# defines the Company Graph *structure* as a generic, publicly-available pattern in
# which no party asserts IP. Only client-specific *content* is confidential, and the
# client identifiers below already catch that.
STRONG='ideawise|kaufmich|fakecheck|pravos|vibrana|kinsai-studio|kinsai|smarthoods|adaptai|cooncircles|youhavetoadapt|optimise media|optimise-media|optimisemediagroup|elxis|ideawisegroup|24z\.de|john-ellison|iamjohndass|/Users/iamjohndass|dreyer|hammen|reisner|astanina|vanderplanken|florijn|de graaf|degraaf|ledain|ghedira|isleem|martin doll|julius|christoph|yvonne|katya|blaise|yiannis|robbie|fatma|stephan|miguel|crespo'

# WORD-BOUNDED terms — short/ambiguous client identifiers; match only as whole
# words to avoid false positives (e.g. Tine in "routine", Abe in "label").
# NOTE: generic third-party SaaS names (Jira, Confluence, Toggl, Slack, etc.) and
# generic business-metric terms (OKR/OKRs, eNPS, KPI, NPS) are NOT confidential
# identifiers and appear in normal product/docs copy, so they are deliberately NOT
# gated. A *specific* company's OKRs/metrics are still caught — by that company's
# name (STRONG list) and the business-data PATTERNS (amounts/IDs) that accompany them.
WORDS='Ideawise|Pravos|Anna|Tine|Andre|André|Abe'

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
