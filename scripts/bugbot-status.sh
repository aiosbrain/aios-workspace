#!/usr/bin/env bash
# Deprecated compatibility wrapper. Local clear evidence is never inferred from hook cache or
# a remote Cursor check; run the canonical local review command for the exact changeset.

set -euo pipefail

cat >&2 <<'EOF'
bugbot-status.sh is deprecated.

Local Bugbot (mandatory, exact branch diff):
  aios review-bugbot <branch> --worktree <path>

CodeRabbit (optional for Standard PRs; mandatory for Safety PRs):
  node scripts/wait-for-bots.mjs --pr <number> --repo aiosbrain/<repo>

This wrapper does not report a cached "local clear" result because clear evidence is valid only
for the exact reviewed head and verified base SHA.
EOF

exit 1
