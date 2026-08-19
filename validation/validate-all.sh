#!/bin/bash
# validate-all.sh — Run all OGR validators against a team-ops repo
#
# Usage:
#   ./validation/validate-all.sh <path-to-team-ops-repo>
#   ./validation/validate-all.sh <path> --critical    # OGR03 only
#   ./validation/validate-all.sh <path> --quick       # OGR01 only
#   ./validation/validate-all.sh <path> --workspace   # only the validators a workspace ships
#
# AIO-965 — WORKSPACE vs TOOLKIT mode. A scaffolded workspace vendors the subset of these
# validators that can actually grade IT (see MANAGED_PATHS in scripts/toolkit-manifest.mjs).
# The rest are toolkit-only and are NOT shipped, for two different reasons:
#
#   * OGR06.5/07/08/11/12 (check-scaffold-guard, check-scaffold-git-workflow,
#     check-opencode-scaffold, check-runtime-adapters) take NO argument at all — they grade the
#     toolkit repo they live in, whatever path you pass. Running them from a workspace reports
#     a PASS that describes aios-workspace, which is worse than not running them.
#   * OGR13 (check-modularity) needs the external codebase-memory-mcp and ratchets against a
#     toolkit-derived baseline; OGR15 (check-delivery-skill-suite) imports `ajv` and a toolkit
#     script, and a workspace has no node_modules — it would crash at import.
#
# Mode is AUTO-DETECTED rather than flagged, so `./validation/validate-all.sh .` does the right
# thing in both trees: if the toolkit-only validators are not on disk beside this script, we are
# in a workspace. An explicit --workspace still forces it (used by the scaffold test).

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

if [ $# -eq 0 ]; then
  echo "Usage: $0 <path-to-team-ops-repo> [--critical|--quick]"
  exit 1
fi

REPO="$1"
MODE="${2:-auto}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FAILED=0

# A workspace vendors only the shippable subset — check-scaffold-guard.mjs is toolkit-only and
# so is a reliable marker of which tree this copy of the script lives in.
if [ "$MODE" = "auto" ]; then
  if [ -f "$SCRIPT_DIR/check-scaffold-guard.mjs" ]; then MODE="all"; else MODE="--workspace"; fi
fi

echo -e "${BLUE}Agentic Team Ops — OGR Validation${NC}"
echo "Target: $REPO"
echo "Mode: $MODE"
echo "================================================"
echo ""

run_check() {
  local name="$1"
  local script="$2"

  echo -e "${BLUE}Running $name...${NC}"
  if "$script" "$REPO"; then
    echo ""
  else
    FAILED=$((FAILED + 1))
    echo ""
  fi
}

case "$MODE" in
  --critical)
    run_check "OGR03 — Secrets Scanner" "$SCRIPT_DIR/check-secrets.sh"
    ;;
  --quick)
    run_check "OGR01 — Folder Structure" "$SCRIPT_DIR/check-structure.sh"
    ;;
  --workspace)
    # The set a scaffolded workspace ships. Every entry here is also a MANAGED_PATHS entry.
    run_check "OGR01 — Folder Structure" "$SCRIPT_DIR/check-structure.sh"
    run_check "OGR02 — Frontmatter" "$SCRIPT_DIR/check-frontmatter.sh"
    run_check "OGR03 — Secrets Scanner" "$SCRIPT_DIR/check-secrets.sh"
    run_check "OGR04 — AIOS Config" "$SCRIPT_DIR/check-aios-config.sh"
    run_check "OGR05 — Rubrics + Memory" "$SCRIPT_DIR/check-rubrics.sh"
    run_check "OGR06 — Skill Export (BYOA)" "$SCRIPT_DIR/check-skill-export.mjs"
    run_check "OGR10 — Agent Readiness (advisory)" "$SCRIPT_DIR/check-agent-readiness.mjs"
    run_check "OGR14 — File Governance (anti-sprawl ratchet)" "$SCRIPT_DIR/check-file-governance.mjs"
    run_check "OGR16 — Validator Citations" "$SCRIPT_DIR/check-citations.mjs"
    ;;
  all|*)
    run_check "OGR01 — Folder Structure" "$SCRIPT_DIR/check-structure.sh"
    run_check "OGR02 — Frontmatter" "$SCRIPT_DIR/check-frontmatter.sh"
    run_check "OGR03 — Secrets Scanner" "$SCRIPT_DIR/check-secrets.sh"
    run_check "OGR04 — AIOS Config" "$SCRIPT_DIR/check-aios-config.sh"
    run_check "OGR05 — Rubrics + Memory" "$SCRIPT_DIR/check-rubrics.sh"
    run_check "OGR06 — Skill Export (BYOA)" "$SCRIPT_DIR/check-skill-export.mjs"
    run_check "OGR07 — Runtime Adapters (BYOA)" "$SCRIPT_DIR/check-runtime-adapters.mjs"
    run_check "OGR08 — Scaffold Guard" "$SCRIPT_DIR/check-scaffold-guard.mjs"
    run_check "OGR11 — Scaffold Git Workflow" "$SCRIPT_DIR/check-scaffold-git-workflow.mjs"
    run_check "OGR12 — OpenCode Scaffold" "$SCRIPT_DIR/check-opencode-scaffold.mjs"
    # OGR09 (Skill Library) is no longer run here. The vendored library data lives at
    # gui/server/skill-library/, which docs/gui-toolkit-contract.md declares a GUI-owned
    # path, and AIO-702 moved the writer + validator into aiosbrain/aios-workspace-gui,
    # where its own `gates` CI job runs `node validation/check-skill-library.mjs` against
    # the tree it actually owns. Keeping a second copy here would re-read a path this repo
    # is about to delete (AIO-612) and would ENOENT the moment it does.
    run_check "OGR10 — Agent Readiness (advisory)" "$SCRIPT_DIR/check-agent-readiness.mjs"
    run_check "OGR13 — Modularity (advisory)" "$SCRIPT_DIR/check-modularity.mjs"
    run_check "OGR14 — File Governance (anti-sprawl ratchet)" "$SCRIPT_DIR/check-file-governance.mjs"
    run_check "OGR15 — Focused Delivery Skill Suite" "$SCRIPT_DIR/check-delivery-skill-suite.mjs"
    run_check "OGR16 — Validator Citations" "$SCRIPT_DIR/check-citations.mjs"
    run_check "OGR17 — Shared Skill Sync" "$SCRIPT_DIR/check-skill-sync.mjs"
    ;;
esac

echo "================================================"
if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}All validators passed.${NC}"
  exit 0
else
  echo -e "${RED}$FAILED validator(s) failed.${NC}"
  exit 1
fi
