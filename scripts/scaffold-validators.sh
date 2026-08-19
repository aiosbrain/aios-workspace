#!/bin/bash
# scaffold-validators.sh — vendor the validators a workspace's own governance docs CITE (AIO-965).
#
# Extracted from scaffold-project.sh, which is at its grandfathered size cap. This is called by the
# scaffold and does one job: copy the shipped validator surface into a new workspace.
#
# WHY IT EXISTS. The scaffold used to copy validation/secret-patterns.txt and nothing else, while
# stamping .claude/ rules and READMEs that told the agent to run check-rubrics.sh,
# check-frontmatter.sh and friends. The rules were real, the guards were absent, and nothing
# surfaced the gap — an agent read "this is enforced", believed it, and proceeded. A claimed check
# that does not run reads exactly like a passing one.
#
# KEPT IN LOCKSTEP with MANAGED_PATHS in scripts/toolkit-manifest.mjs, which is how an EXISTING
# workspace picks the same set up via `aios update`. Shipping here but not there means new
# workspaces get a validator that later silently goes stale; shipping there but not here means the
# reverse. OGR16 (validation/check-citations.mjs) fails the build if the two lists diverge, or if a
# scaffolded doc cites a validator neither ships.
#
# NOT shipped, deliberately — recorded in check-citations.mjs's TOOLKIT_ONLY with the reason each:
# check-scaffold-guard / check-scaffold-git-workflow / check-opencode-scaffold /
# check-runtime-adapters (they take no argv and grade the toolkit repo whatever path is passed),
# check-modularity (needs external codebase-memory-mcp + a toolkit baseline), and
# check-delivery-skill-suite (imports ajv, and a workspace has no node_modules).
set -euo pipefail

REPO_ROOT="$1"
OUTPUT="$2"

mkdir -p "$OUTPUT/hooks" "$OUTPUT/validation" "$OUTPUT/scripts"

# The PreToolUse guard + its patterns, so Claude Code's native guard (secrets / tier leaks /
# frontmatter) fires in this workspace and not only in the toolkit repo. The hook reads stdin JSON
# and blocks with exit 2.
cp "$REPO_ROOT/hooks/team-ops-guard.sh" "$OUTPUT/hooks/team-ops-guard.sh"
chmod +x "$OUTPUT/hooks/team-ops-guard.sh"
cp "$REPO_ROOT/validation/secret-patterns.txt" "$OUTPUT/validation/secret-patterns.txt"

for validator in validate-all.sh check-frontmatter.sh check-rubrics.sh check-secrets.sh \
  check-structure.sh check-aios-config.sh check-skill-export.mjs check-file-governance.mjs \
  check-agent-readiness.mjs check-citations.mjs; do
  cp "$REPO_ROOT/validation/$validator" "$OUTPUT/validation/$validator"
  chmod +x "$OUTPUT/validation/$validator"
done

# Data + library files the validators read (not executable).
cp "$REPO_ROOT/validation/agent-readiness-lib.mjs" "$OUTPUT/validation/agent-readiness-lib.mjs"
cp "$REPO_ROOT/validation/agent-readiness.rubric.json" "$OUTPUT/validation/agent-readiness.rubric.json"

# Helper modules the validators import as ../scripts/<name>.mjs. In the toolkit those two paths are
# shims re-exporting packages/foundation (AIO-601); a workspace has no packages/ tree, so the REAL
# module is vendored under the path the importers already use — no dual-path resolution needed in
# the validators. Both are node-builtin only, so they run with no npm install.
cp "$REPO_ROOT/packages/foundation/src/git-files.mjs" "$OUTPUT/scripts/git-files.mjs"
cp "$REPO_ROOT/packages/foundation/src/runtimes.mjs" "$OUTPUT/scripts/runtimes.mjs"
