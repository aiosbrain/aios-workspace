#!/bin/bash
# scaffold-repo-meta.sh — stamp a fresh workspace's repository-meta files.
#
# Extracted from scaffold-project.sh (which is at its size-cap ratchet, and per
# scripts/CLAUDE.md extraction is preferred over growing it further). These are the files
# that describe the REPO rather than the person's content: ownership, ignore rules, the
# planning stub, and the brain-reporting CI.
#
# Sourced, not executed — it uses the caller's OUTPUT / SCAFFOLD / SLUG / OWNER.
#
# NOTE: test/toolkit-manifest-parity.test.mjs scans this file as well as scaffold-project.sh,
# so every workspace path written here still has to be classified in toolkit-manifest.mjs.

# CODEOWNERS
cat > "$OUTPUT/.github/CODEOWNERS" << EOF
# $SLUG — owned by @$OWNER
* @$OWNER
EOF

# Brain reporting CI. Without this a workspace never reaches the Codebases dashboard with
# real metrics: the brain's GitHub-API fallback path fills identity and contribution rows but
# deliberately writes no code_metrics (it has no checkout), so readiness, health and coverage
# stay null forever — and a null coverage renders as a false 0%. The workflow skips and exits
# 0 until the three brain secrets are set, so a fresh workspace is green either way.
if [ "$CI_WORKFLOW" = true ]; then
  mkdir -p "$OUTPUT/.github/workflows" "$OUTPUT/.github/scripts"
  cp "$SCAFFOLD/.github/workflows/scan-on-merge.yml" "$OUTPUT/.github/workflows/scan-on-merge.yml"
  cp "$SCAFFOLD/.github/scripts/fetch-brain-scanner.sh" "$OUTPUT/.github/scripts/fetch-brain-scanner.sh"
  cp "$SCAFFOLD/.github/scripts/scan_with_health.py" "$OUTPUT/.github/scripts/scan_with_health.py"
  chmod +x "$OUTPUT/.github/scripts/fetch-brain-scanner.sh"
fi

cat > "$OUTPUT/.gitignore" << EOF
# Environment / secrets. The glob is wide on purpose: an exact .env.keys pattern does
# NOT match a rotation or backup copy (.env.keys.bak-2026-01-01, .env.keys.old), which
# would leave a live dotenvx private key untracked-but-stageable by "git add -A".
# Only the committed .env.example is exempt.
.env
.env.*
!.env.example
.aios/
*.pyc
__pycache__/
.DS_Store
node_modules/
EOF

cat > "$OUTPUT/.planning/README.md" << EOF
# Planning — $OWNER

Deliberation space. Not promoted.
EOF
