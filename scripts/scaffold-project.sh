#!/bin/bash
# scaffold-project.sh — Spawn a new AIOS individual-contributor workspace.
#
# An AIOS workspace is where ONE individual works with agentic workflows and
# pushes selected output to a shared Team Brain. The spine is intent-named and
# context-driven: an onboarding question picks how you work.
#
# Usage:
#   ./scripts/scaffold-project.sh \
#     --slug alex-aios \
#     --owner alex \
#     --context consultant|employee \
#     [--stakeholder "Acme Corp"] [--team "sam,jordan"] \
#     [--team-id <brain team id>] [--brain-url <url>] \
#     [--org your-github-org] [--currency USD] [--output ~/Projects/alex-aios] [--dry-run]
#
# Onboarding context (the spine skin):
#   consultant  → you work in a team for a CLIENT.  0-context=engagement+scope,
#                 4-shared=client-facing, outward tier "client", billable hours.
#   employee    → you work inside a COMPANY.        0-context=role+OKRs,
#                 4-shared=company-shared, outward tier "company", lightweight hours.
#
# Spine (same folder names in both contexts):
#   0-context  1-inbox  2-work  3-log  4-shared  5-personal  .claude/
#
# Legacy aliases still accepted: --profile engagement→consultant / project→employee,
#   --client→--stakeholder, --captain/--lead→--owner.

set -euo pipefail

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAFFOLD="$REPO_ROOT/scaffold"

# Defaults
DRY_RUN=false
SLUG=""; OWNER=""; CONTEXT=""; STAKEHOLDER=""; STAKEHOLDER_FULL=""; DESC=""
TEAM=""; ORG="your-github-org"; CURRENCY="USD"; OUTPUT=""; TEAM_ID=""; BRAIN_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --owner|--lead|--captain) OWNER="$2"; shift 2 ;;
    --context) CONTEXT="$2"; shift 2 ;;
    --profile) # legacy → context
      case "$2" in engagement) CONTEXT="consultant" ;; project) CONTEXT="employee" ;; *) CONTEXT="$2" ;; esac
      shift 2 ;;
    --stakeholder|--client) STAKEHOLDER="$2"; shift 2 ;;
    --stakeholder-full|--client-full) STAKEHOLDER_FULL="$2"; shift 2 ;;
    --desc) DESC="$2"; shift 2 ;;
    --team|--members) TEAM="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --currency) CURRENCY="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --team-id) TEAM_ID="$2"; shift 2 ;;
    --brain-url) BRAIN_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

CONTEXT="${CONTEXT:-consultant}"
case "$CONTEXT" in
  consultant)
    CONTEXT_TITLE="Engagement"; OUTWARD_TIER="client"; OUTWARD_DESC="client-facing"
    STAKEHOLDER_LABEL="client" ;;
  employee)
    CONTEXT_TITLE="Role"; OUTWARD_TIER="company"; OUTWARD_DESC="company-shared"
    STAKEHOLDER_LABEL="company" ;;
  *) echo -e "${RED}Error: --context must be 'consultant' or 'employee'${NC}"; exit 1 ;;
esac

# Required
for var in SLUG OWNER; do
  if [ -z "${!var}" ]; then
    echo -e "${RED}Error: --$(echo $var | tr '[:upper:]' '[:lower:]') is required${NC}"; exit 1
  fi
done

# Intent-named spine (identical names in both contexts)
D_CONTEXT="0-context"; D_INBOX="1-inbox"; D_WORK="2-work"
D_LOG="3-log"; D_SHARED="4-shared"; D_PERSONAL="5-personal"

STAKEHOLDER="${STAKEHOLDER:-$([ "$CONTEXT" = consultant ] && echo 'Your Client' || echo 'Your Company')}"
STAKEHOLDER_FULL="${STAKEHOLDER_FULL:-$STAKEHOLDER}"
DESC="${DESC:-AIOS $CONTEXT workspace}"
OUTPUT="${OUTPUT:-$HOME/Projects/$SLUG}"
START_DATE=$(date +%Y-%m-%dT00:00:00Z)

# Team-for-context list (teammates have their OWN workspaces; this is context only).
# The owner is always a member so identity resolution passes.
MEMBERS="$OWNER${TEAM:+,$TEAM}"
IFS=',' read -ra MEMBER_ARRAY <<< "$MEMBERS"
MEMBER_LIST=$(IFS=', '; echo "${MEMBER_ARRAY[*]}")
MEMBER_COUNT=${#MEMBER_ARRAY[@]}
MEMBERS_YAML=""
for m in "${MEMBER_ARRAY[@]}"; do MEMBERS_YAML="$MEMBERS_YAML  - $(echo "$m" | xargs)\n"; done

echo -e "${BLUE}AIOS Workspace Scaffold — context: ${CONTEXT}${NC}"
echo "================================================"
echo "  Slug:       $SLUG"
echo "  Owner:      $OWNER"
echo "  Context:    $CONTEXT ($CONTEXT_TITLE; outward tier: $OUTWARD_TIER)"
echo "  Stakeholder ($STAKEHOLDER_LABEL): $STAKEHOLDER"
echo "  Team (ctx): ${TEAM:-<none>}"
echo "  Brain:      ${BRAIN_URL:-<offline/standalone>}"
echo "  Output:     $OUTPUT"
echo "  Mode:       $([ "$DRY_RUN" = true ] && echo 'DRY RUN' || echo CREATE)"
echo "================================================"

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}DRY RUN — spine that would be created:${NC}"
  printf '  %s/\n' "$D_CONTEXT" "$D_INBOX" "$D_WORK" "$D_LOG" "$D_SHARED" "$D_PERSONAL" ".claude"
  echo -e "${GREEN}Remove --dry-run to create.${NC}"; exit 0
fi

[ -d "$OUTPUT" ] && { echo -e "${RED}Error: $OUTPUT already exists${NC}"; exit 1; }

echo "Creating workspace..."
mkdir -p "$OUTPUT"/.claude/rules "$OUTPUT"/.github "$OUTPUT/.planning"
mkdir -p "$OUTPUT/$D_CONTEXT"
mkdir -p "$OUTPUT/$D_INBOX"/{transcripts,reference,from-brain}
mkdir -p "$OUTPUT/$D_WORK"
mkdir -p "$OUTPUT/$D_LOG"
mkdir -p "$OUTPUT/$D_SHARED"
mkdir -p "$OUTPUT/$D_PERSONAL"
touch "$OUTPUT/$D_INBOX/transcripts/.gitkeep" "$OUTPUT/$D_INBOX/from-brain/.gitkeep"

# ── context skin: 0-context starter files ─────────────────────────────────────
idx() { cat > "$1"; }  # helper: idx <path> <<EOF ... EOF

if [ "$CONTEXT" = consultant ]; then
  idx "$OUTPUT/$D_CONTEXT/index.md" << EOF
---
type: index
access: team
---
# 0-context — engagement

What frames this engagement: scope, the client, and roles.

* [Scope Baseline](scope-baseline.md) — contracted deliverable tracks
* [Scope Ledger](scope-ledger.md) — scope changes and out-of-scope log
EOF
  idx "$OUTPUT/$D_CONTEXT/scope-baseline.md" << EOF
---
type: Scope
status: draft
access: team
---
# Scope Baseline — $STAKEHOLDER

| Track | In scope | Notes |
|-------|----------|-------|
EOF
  idx "$OUTPUT/$D_CONTEXT/scope-ledger.md" << EOF
---
type: Scope
status: living
access: team
---
# Scope Ledger — $STAKEHOLDER

| # | Date | Change | In/Out | Decided By |
|---|------|--------|--------|------------|
EOF
else
  idx "$OUTPUT/$D_CONTEXT/index.md" << EOF
---
type: index
access: team
---
# 0-context — role

What frames your work: your role, your team, and your goals.

* [Role](role.md) — what you own and how you work
* [OKRs](okrs.md) — current objectives and key results
EOF
  idx "$OUTPUT/$D_CONTEXT/role.md" << EOF
---
type: Scope
status: living
access: team
---
# Role — $OWNER @ $STAKEHOLDER

**Function:**
**Manager:**
**Team:** ${TEAM:-}
EOF
  idx "$OUTPUT/$D_CONTEXT/okrs.md" << EOF
---
type: Scope
status: living
access: team
---
# OKRs — $OWNER

| Objective | Key result | Status |
|-----------|------------|--------|
EOF
fi

# ── 1-inbox, 2-work indexes ──────────────────────────────────────────────────
idx "$OUTPUT/$D_INBOX/index.md" << EOF
---
type: index
access: team
---
# 1-inbox

Raw inputs — transcripts, reference material, and items pulled from the Team Brain.

* [Transcripts](transcripts/) — meeting recordings and extracted text
* [Reference](reference/) — background reading and external sources
* [From Brain](from-brain/) — pulled from the Team Brain (append-only)
EOF

idx "$OUTPUT/$D_WORK/index.md" << EOF
---
type: index
access: team
---
# 2-work

Your deliverables and drafts in progress.

## Add links
<!-- Add one link per deliverable or work item as you create them. -->
EOF

idx "$OUTPUT/$D_SHARED/index.md" << EOF
---
type: index
access: $OUTWARD_TIER
---
# 4-shared — $OUTWARD_DESC

What you've deliberately promoted outward ($OUTWARD_DESC). Tier: \`$OUTWARD_TIER\`.

## Add links
<!-- Add $OUTWARD_DESC artifacts here as you approve and promote them. -->
EOF

# ── 3-log: decisions + tasks (synced); hours (local, lightweight) ────────────
idx "$OUTPUT/$D_LOG/index.md" << EOF
---
type: index
access: team
---
# 3-log

The record — decisions, tasks, and time.

* [Decision Log](decision-log.md) — durable record of choices (syncs)
* [Tasks](tasks.md) — task register (syncs)
* [Hours Log](hours-log.md) — time record (stays local)
EOF

idx "$OUTPUT/$D_LOG/decision-log.md" << EOF
---
access: team
type: "Decision Log"
---
# Decision Log — $STAKEHOLDER

| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
|---|------|----------|-----------|------------|--------|------|----------|
EOF

idx "$OUTPUT/$D_LOG/tasks.md" << EOF
---
access: team
type: "Task List"
---
# Tasks — $STAKEHOLDER

| ID | Task | Assignee | Status | Sprint | Due |
|----|------|----------|--------|--------|-----|
EOF

# Hours: billable framing for consultant, lightweight for employee — both stay local (no access tier → never syncs).
idx "$OUTPUT/$D_LOG/hours-log.md" << EOF
# Hours Log — $OWNER

$([ "$CONTEXT" = consultant ] && echo 'Billable time for this engagement.' || echo 'Lightweight time tracking.')

| Date | Activity | Hours | Tag | Ref |
|------|----------|-------|-----|-----|
EOF

# client-surface-log only for consultants
if [ "$CONTEXT" = consultant ]; then
  idx "$OUTPUT/$D_LOG/client-surface-log.md" << EOF
---
access: team
---
# Client-Surface Log — $STAKEHOLDER

| Date | Artifact | Sent To | Approved By |
|------|----------|---------|-------------|
EOF
fi

# ── 5-personal: single private area (this is ONE person's workspace) ─────────
idx "$OUTPUT/$D_PERSONAL/README.md" << EOF
# $OWNER — personal

Your private scratch: drafts, prep, thinking-in-progress. **Never syncs** to the
Team Brain (no access tier here). Promote to 2-work/ or 4-shared/ when ready.
EOF

# ── templates (CLAUDE.md, README, aios.yaml, workspace.yaml, contacts) ────────
echo "Processing templates..."
process_template() {
  sed \
    -e "s|{{SLUG}}|$SLUG|g" -e "s|{{OWNER}}|$OWNER|g" -e "s|{{CONTEXT}}|$CONTEXT|g" \
    -e "s|{{CONTEXT_TITLE}}|$CONTEXT_TITLE|g" -e "s|{{STAKEHOLDER_NAME}}|$STAKEHOLDER|g" \
    -e "s|{{STAKEHOLDER_FULL}}|$STAKEHOLDER_FULL|g" -e "s|{{STAKEHOLDER_LABEL}}|$STAKEHOLDER_LABEL|g" \
    -e "s|{{DESC}}|$DESC|g" -e "s|{{MEMBER_LIST}}|$MEMBER_LIST|g" -e "s|{{MEMBER_COUNT}}|$MEMBER_COUNT|g" \
    -e "s|{{CURRENCY}}|$CURRENCY|g" -e "s|{{START_DATE}}|$START_DATE|g" \
    -e "s|{{OUTWARD_TIER}}|$OUTWARD_TIER|g" -e "s|{{OUTWARD_DESC}}|$OUTWARD_DESC|g" \
    -e "s|{{TEAM_ID}}|$TEAM_ID|g" -e "s|{{BRAIN_URL}}|$BRAIN_URL|g" \
    "$1" > "$2"
}

process_template "$SCAFFOLD/README.md.tmpl" "$OUTPUT/README.md"
process_template "$SCAFFOLD/.claude/CLAUDE.md.tmpl" "$OUTPUT/.claude/CLAUDE.md"
process_template "$SCAFFOLD/aios.yaml.tmpl" "$OUTPUT/aios.yaml"

sed \
  -e "s|{{SLUG}}|$SLUG|g" -e "s|{{OWNER}}|$OWNER|g" -e "s|{{CONTEXT}}|$CONTEXT|g" \
  -e "s|{{STAKEHOLDER_NAME}}|$STAKEHOLDER|g" -e "s|{{STAKEHOLDER_FULL}}|$STAKEHOLDER_FULL|g" \
  -e "s|{{STAKEHOLDER_LABEL}}|$STAKEHOLDER_LABEL|g" -e "s|{{DESC}}|$DESC|g" \
  -e "s|{{CURRENCY}}|$CURRENCY|g" -e "s|{{START_DATE}}|$START_DATE|g" \
  "$SCAFFOLD/workspace.yaml.tmpl" \
  | awk -v members="$(printf '%s' "$MEMBERS_YAML")" '{gsub(/\{\{MEMBERS_YAML\}\}/, members); print}' \
  > "$OUTPUT/workspace.yaml"

sed -e "s|{{STAKEHOLDER_NAME}}|$STAKEHOLDER|g" -e "s|{{CONTACTS_YAML}}|  # Add contacts here|g" \
  "$SCAFFOLD/contacts.yaml.tmpl" > "$OUTPUT/contacts.yaml"

[ -f "$SCAFFOLD/.env.example" ] && cp "$SCAFFOLD/.env.example" "$OUTPUT/.env.example"

# Copy the agent layer (rules, skills, rubrics, memory)
cp "$SCAFFOLD/.claude/rules/"*.md "$OUTPUT/.claude/rules/"
for d in skills rubrics memory; do
  if [ -d "$SCAFFOLD/.claude/$d" ]; then mkdir -p "$OUTPUT/.claude/$d"; cp -R "$SCAFFOLD/.claude/$d/." "$OUTPUT/.claude/$d/"; fi
done
mkdir -p "$OUTPUT/.claude/memory/incidents"

# Integrations manifest + MCP stub/example
[ -f "$SCAFFOLD/.claude/integrations.json" ] && cp "$SCAFFOLD/.claude/integrations.json" "$OUTPUT/.claude/integrations.json"
[ -f "$SCAFFOLD/.mcp.json" ] && cp "$SCAFFOLD/.mcp.json" "$OUTPUT/.mcp.json"
[ -f "$SCAFFOLD/.mcp.example.json" ] && cp "$SCAFFOLD/.mcp.example.json" "$OUTPUT/.mcp.example.json"

# Generate the skills + integrations catalogs for the new workspace
if command -v node >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/gen-catalog.mjs" ]; then
  node "$SCRIPT_DIR/gen-catalog.mjs" --repo "$OUTPUT" >/dev/null 2>&1 || true
fi

# CODEOWNERS
cat > "$OUTPUT/.github/CODEOWNERS" << EOF
# $SLUG — owned by @$OWNER
* @$OWNER
EOF

cat > "$OUTPUT/.gitignore" << EOF
.env
.env.local
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

echo "Initializing git..."
cd "$OUTPUT"
git init -q; git add -A
git commit -q -m "feat: scaffold $SLUG — AIOS $CONTEXT workspace"

echo ""
echo -e "${GREEN}Workspace ready: $OUTPUT${NC}"
echo "Next:"
echo "  1. Connect the brain: set AIOS_API_KEY in .env, fill aios.yaml (brain_url, team_id)"
echo "  2. aios status   # what would sync"
echo "  3. Validate: $REPO_ROOT/validation/validate-all.sh $OUTPUT"
