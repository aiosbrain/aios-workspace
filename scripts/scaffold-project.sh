#!/bin/bash
# scaffold-project.sh — Spawn a new team-ops repo from the Agentic Team Ops scaffold
#
# Usage:
#   ./scripts/scaffold-project.sh \
#     --slug acme-team-ops \
#     --stakeholder "Acme Corp" \
#     --stakeholder-full "Acme Corporation Ltd" \
#     --desc "AI Workflow Automation" \
#     --lead john \
#     --members "alex,sam,jordan" \
#     --org your-github-org \
#     --currency USD \
#     --output ~/Projects/acme-team-ops
#
#   --profile project|engagement   Vocabulary profile (default: project).
#                                  `project`    → 00-project/, 04-shared/, project.yaml
#                                  `engagement` → 00-engagement/, 04-client-surface/,
#                                                 engagement.yaml (legacy consulting layout)
#   --team-id <id>                 AIOS Team Brain team id (optional; written to aios.yaml)
#   --brain-url <url>              AIOS Team Brain base URL (optional; empty = offline mode)
#   --dry-run                      Preview without creating anything
#
# Legacy flag aliases (still accepted): --client, --client-full, --captain

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAFFOLD="$REPO_ROOT/scaffold"

# Defaults
DRY_RUN=false
SLUG=""
STAKEHOLDER=""
STAKEHOLDER_FULL=""
DESC=""
LEAD=""
MEMBERS=""
ORG="your-github-org"
CURRENCY="USD"
OUTPUT=""
PROFILE="project"
TEAM_ID=""
BRAIN_URL=""

# Parse args (new flags + legacy aliases)
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --stakeholder|--client) STAKEHOLDER="$2"; shift 2 ;;
    --stakeholder-full|--client-full) STAKEHOLDER_FULL="$2"; shift 2 ;;
    --desc) DESC="$2"; shift 2 ;;
    --lead|--captain) LEAD="$2"; shift 2 ;;
    --members) MEMBERS="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --currency) CURRENCY="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --team-id) TEAM_ID="$2"; shift 2 ;;
    --brain-url) BRAIN_URL="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: $0 --slug <slug> --stakeholder <name> --lead <name> --members <csv> [options]"
      echo ""
      echo "Required:"
      echo "  --slug             Repo name (e.g., acme-team-ops)"
      echo "  --stakeholder      Short stakeholder/org name (alias: --client)"
      echo "  --lead             Team lead (alias: --captain)"
      echo "  --members          Comma-separated member list (e.g., alex,sam,jordan)"
      echo ""
      echo "Optional:"
      echo "  --stakeholder-full Full legal name (alias: --client-full; defaults to --stakeholder)"
      echo "  --desc             Project description"
      echo "  --profile          project | engagement (default: project)"
      echo "  --team-id          AIOS Team Brain team id (written to aios.yaml)"
      echo "  --brain-url        AIOS Team Brain base URL (empty = offline/standalone)"
      echo "  --org              GitHub org (default: your-github-org)"
      echo "  --currency         Billing currency (default: USD)"
      echo "  --output           Output directory (default: ~/Projects/<slug>)"
      echo "  --dry-run          Preview the scaffold without creating files"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate required args
for var in SLUG STAKEHOLDER LEAD MEMBERS; do
  if [ -z "${!var}" ]; then
    flag=$(echo "$var" | tr '[:upper:]' '[:lower:]')
    echo -e "${RED}Error: --$flag is required${NC}"
    exit 1
  fi
done

# Profile vocabulary
case "$PROFILE" in
  project)
    DIR00="00-project"; DIR04="04-shared"
    CONFIG_FILE="project.yaml"; CONFIG_TMPL="project.yaml.tmpl"
    UNIT_LABEL="project"; UNIT_TITLE="Project"
    LEAD_LABEL="Lead"; STAKEHOLDER_LABEL="stakeholder"
    DIR04_DESC="lead-approved, externally shareable"
    ;;
  engagement)
    DIR00="00-engagement"; DIR04="04-client-surface"
    CONFIG_FILE="engagement.yaml"; CONFIG_TMPL="engagement.yaml.tmpl"
    UNIT_LABEL="engagement"; UNIT_TITLE="Engagement"
    LEAD_LABEL="Captain"; STAKEHOLDER_LABEL="client"
    DIR04_DESC="captain-approved, client-facing"
    ;;
  *)
    echo -e "${RED}Error: --profile must be 'project' or 'engagement'${NC}"
    exit 1
    ;;
esac

# Defaults
STAKEHOLDER_FULL="${STAKEHOLDER_FULL:-$STAKEHOLDER}"
DESC="${DESC:-team $UNIT_LABEL}"
OUTPUT="${OUTPUT:-$HOME/Projects/$SLUG}"
START_DATE=$(date +%Y-%m-%dT00:00:00Z)

# Parse members
IFS=',' read -ra MEMBER_ARRAY <<< "$MEMBERS"
MEMBER_COUNT=${#MEMBER_ARRAY[@]}
MEMBER_LIST=$(IFS=', '; echo "${MEMBER_ARRAY[*]}")

# Build YAML members list
MEMBERS_YAML=""
for m in "${MEMBER_ARRAY[@]}"; do
  MEMBERS_YAML="$MEMBERS_YAML  - $(echo "$m" | xargs)\n"
done

echo -e "${BLUE}Agentic Team Ops — ${UNIT_TITLE} Scaffold${NC}"
echo "================================================"
echo "  Slug:        $SLUG"
echo "  Profile:     $PROFILE"
echo "  Stakeholder: $STAKEHOLDER ($STAKEHOLDER_FULL)"
echo "  Desc:        $DESC"
echo "  $LEAD_LABEL:        $LEAD"
echo "  Members:     $MEMBER_LIST ($MEMBER_COUNT)"
echo "  Org:         $ORG"
echo "  Currency:    $CURRENCY"
echo "  Brain:       ${BRAIN_URL:-<offline/standalone>}"
echo "  Output:      $OUTPUT"
echo "  Mode:        $([ "$DRY_RUN" = true ] && echo "DRY RUN" || echo "CREATE")"
echo "================================================"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}DRY RUN — showing what would be created:${NC}"
  echo ""
  echo "Directories:"
  echo "  $OUTPUT/"
  echo "  $OUTPUT/.claude/{rules,skills,rubrics,memory}/"
  echo "  $OUTPUT/.github/"
  echo "  $OUTPUT/.planning/"
  echo "  $OUTPUT/$DIR00/"
  echo "  $OUTPUT/01-intake/{email,transcripts,reference,from-brain}/"
  echo "  $OUTPUT/02-deliverables/"
  echo "  $OUTPUT/03-status/"
  echo "  $OUTPUT/$DIR04/"
  for m in "${MEMBER_ARRAY[@]}"; do
    m=$(echo "$m" | xargs)
    echo "  $OUTPUT/05-personal/$m/{01-intake/{inbox,transcripts,email},02-deliverables,03-status,$DIR04,.claude,.planning}/"
  done
  echo ""
  echo "Files:"
  echo "  README.md"
  echo "  $CONFIG_FILE"
  echo "  contacts.yaml"
  echo "  aios.yaml"
  echo "  .env.example"
  echo "  .claude/CLAUDE.md"
  echo "  .claude/rules/{decision-log,frontmatter,publishing,hours}.md"
  echo "  .github/CODEOWNERS"
  echo "  03-status/{decision-log,hours-log,tasks}.md"
  echo ""
  echo -e "${GREEN}Dry run complete. Remove --dry-run to create.${NC}"
  exit 0
fi

# Check output doesn't already exist
if [ -d "$OUTPUT" ]; then
  echo -e "${RED}Error: Output directory already exists: $OUTPUT${NC}"
  echo "Remove it first or choose a different --output path."
  exit 1
fi

# Create directory structure
echo "Creating directories..."
mkdir -p "$OUTPUT"/{.claude/rules,.github,.planning}
mkdir -p "$OUTPUT/$DIR00"
mkdir -p "$OUTPUT"/01-intake/{email,transcripts,reference,from-brain}
mkdir -p "$OUTPUT"/02-deliverables
mkdir -p "$OUTPUT"/03-status
mkdir -p "$OUTPUT/$DIR04"

# OKF index.md stubs — agent navigation layer for each spine directory
cat > "$OUTPUT/$DIR00/index.md" << IDXEOF
---
type: index
access: team
---
# $DIR00

Navigation index for the charter, scope, and roles.

* [Scope Baseline](scope-baseline.md) — contracted deliverable tracks
* [Scope Ledger](scope-ledger.md) — scope changes and out-of-scope log

## Add links
<!-- Add role docs, SOW, and charter files as they are created. -->
IDXEOF

cat > "$OUTPUT/01-intake/index.md" << IDXEOF
---
type: index
access: team
---
# 01-intake

Navigation index for raw inputs — transcripts, reference materials, and brain pulls.

* [Transcripts](transcripts/) — meeting recordings and extracted text
* [Reference](reference/) — background reading and external sources
* [From Brain](from-brain/) — items pulled from the Team Brain (append-only)

## Add links
<!-- Add per-sprint intake folders as they appear. -->
IDXEOF

cat > "$OUTPUT/02-deliverables/index.md" << IDXEOF
---
type: index
access: team
---
# 02-deliverables

Navigation index for sprint-scoped team outputs.

## Add links
<!-- Add one link per sprint folder as sprints are opened:
* [Sprint 1](sprint-1/) — <sprint goal>
-->
IDXEOF

cat > "$OUTPUT/03-status/index.md" << IDXEOF
---
type: index
access: team
---
# 03-status

Navigation index for living status documents.

* [Decision Log](decision-log.md) — durable record of coordinated choices
* [Tasks](tasks.md) — task register (syncs to Team Brain)
* [Hours Log](hours-log.md) — billing-adjacent time record

## Add links
<!-- Add sprint ledgers, client-surface logs, and other status docs here. -->
IDXEOF

cat > "$OUTPUT/$DIR04/index.md" << IDXEOF
---
type: index
access: team
---
# $DIR04

Navigation index for $DIR04_DESC content.

## Add links
<!-- Add $STAKEHOLDER_LABEL-facing or shared artifacts here as they are approved and promoted. -->
IDXEOF

for m in "${MEMBER_ARRAY[@]}"; do
  m=$(echo "$m" | xargs)
  mkdir -p "$OUTPUT/05-personal/$m"/{01-intake/{inbox,transcripts,email},02-deliverables,03-status,.claude,.planning}
  mkdir -p "$OUTPUT/05-personal/$m/$DIR04"
  touch "$OUTPUT/05-personal/$m/01-intake/transcripts/.gitkeep"
  touch "$OUTPUT/05-personal/$m/01-intake/email/.gitkeep"
  touch "$OUTPUT/05-personal/$m/02-deliverables/.gitkeep"
  touch "$OUTPUT/05-personal/$m/$DIR04/.gitkeep"

  # Personal CLAUDE.md
  cat > "$OUTPUT/05-personal/$m/.claude/CLAUDE.md" << PEOF
# $m's Personal Workspace

Read \`$DIR00/my-scope.md\` and \`03-status/tasks.md\` for orientation.
PEOF

  # Personal status files
  cat > "$OUTPUT/05-personal/$m/03-status/hours-log.md" << HEOF
# Hours Log — $m

| Date | Activity | Hours | Tag | Task Ref |
|------|----------|-------|-----|----------|
HEOF

  cat > "$OUTPUT/05-personal/$m/03-status/tasks.md" << TEOF
# Tasks — $m

| ID | Task | Status | Sprint | Due |
|----|------|--------|--------|-----|
TEOF

  cat > "$OUTPUT/05-personal/$m/03-status/decision-log.md" << DEOF
# Decision Log — $m

| # | Date | Decision | Rationale | Type |
|---|------|----------|-----------|------|
DEOF

  # Planning README
  cat > "$OUTPUT/05-personal/$m/.planning/README.md" << PLEOF
# Planning — $m

Scratchpad for plans, prep, and thinking-in-progress. Not promoted.
PLEOF
done

# Process templates
echo "Processing templates..."

process_template() {
  local src="$1"
  local dest="$2"

  sed \
    -e "s|{{SLUG}}|$SLUG|g" \
    -e "s|{{CLIENT_NAME}}|$STAKEHOLDER|g" \
    -e "s|{{CLIENT_FULL_NAME}}|$STAKEHOLDER_FULL|g" \
    -e "s|{{ENGAGEMENT_DESC}}|$DESC|g" \
    -e "s|{{CAPTAIN}}|$LEAD|g" \
    -e "s|{{MEMBER_COUNT}}|$MEMBER_COUNT|g" \
    -e "s|{{MEMBER_LIST}}|$MEMBER_LIST|g" \
    -e "s|{{CURRENCY}}|$CURRENCY|g" \
    -e "s|{{START_DATE}}|$START_DATE|g" \
    -e "s|{{UNIT_LABEL}}|$UNIT_LABEL|g" \
    -e "s|{{UNIT_TITLE}}|$UNIT_TITLE|g" \
    -e "s|{{LEAD_LABEL}}|$LEAD_LABEL|g" \
    -e "s|{{STAKEHOLDER_LABEL}}|$STAKEHOLDER_LABEL|g" \
    -e "s|{{DIR00}}|$DIR00|g" \
    -e "s|{{DIR04}}|$DIR04|g" \
    -e "s|{{DIR04_DESC}}|$DIR04_DESC|g" \
    -e "s|{{TEAM_ID}}|$TEAM_ID|g" \
    -e "s|{{BRAIN_URL}}|$BRAIN_URL|g" \
    "$src" > "$dest"
}

process_template "$SCAFFOLD/README.md.tmpl" "$OUTPUT/README.md"
process_template "$SCAFFOLD/.claude/CLAUDE.md.tmpl" "$OUTPUT/.claude/CLAUDE.md"
process_template "$SCAFFOLD/aios.yaml.tmpl" "$OUTPUT/aios.yaml"

# Config yaml needs multiline member substitution
sed \
  -e "s|{{SLUG}}|$SLUG|g" \
  -e "s|{{CLIENT_NAME}}|$STAKEHOLDER|g" \
  -e "s|{{CLIENT_FULL_NAME}}|$STAKEHOLDER_FULL|g" \
  -e "s|{{ENGAGEMENT_DESC}}|$DESC|g" \
  -e "s|{{CAPTAIN}}|$LEAD|g" \
  -e "s|{{CURRENCY}}|$CURRENCY|g" \
  -e "s|{{START_DATE}}|$START_DATE|g" \
  -e "s|{{UNIT_LABEL}}|$UNIT_LABEL|g" \
  "$SCAFFOLD/$CONFIG_TMPL" | \
  awk -v members="$(printf '%s' "$MEMBERS_YAML")" '{gsub(/\{\{MEMBERS_YAML\}\}/, members); print}' \
  > "$OUTPUT/$CONFIG_FILE"

# contacts.yaml — simple for now
sed \
  -e "s|{{CLIENT_NAME}}|$STAKEHOLDER|g" \
  -e "s|{{CONTACTS_YAML}}|  # Add team contacts here|g" \
  "$SCAFFOLD/contacts.yaml.tmpl" > "$OUTPUT/contacts.yaml"

# .env.example
if [ -f "$SCAFFOLD/.env.example" ]; then
  cp "$SCAFFOLD/.env.example" "$OUTPUT/.env.example"
fi

# Copy shared rules
cp "$SCAFFOLD/.claude/rules/"*.md "$OUTPUT/.claude/rules/"

# Copy shared skills (dynamic-workflow harnesses + their SKILL.md)
if [ -d "$SCAFFOLD/.claude/skills" ]; then
  mkdir -p "$OUTPUT/.claude/skills"
  cp -R "$SCAFFOLD/.claude/skills/." "$OUTPUT/.claude/skills/"
fi

# Copy rubrics (self-correction loop criteria)
if [ -d "$SCAFFOLD/.claude/rubrics" ]; then
  mkdir -p "$OUTPUT/.claude/rubrics"
  cp -R "$SCAFFOLD/.claude/rubrics/." "$OUTPUT/.claude/rubrics/"
fi

# Copy memory scaffold (instincts + incidents convention)
if [ -d "$SCAFFOLD/.claude/memory" ]; then
  mkdir -p "$OUTPUT/.claude/memory/incidents"
  cp -R "$SCAFFOLD/.claude/memory/." "$OUTPUT/.claude/memory/"
fi

# Create status files (decision log + tasks carry access: team so they sync
# to a Team Brain by default; hours stay local — billing-adjacent)
cat > "$OUTPUT/03-status/decision-log.md" << EOF
---
access: team
type: "Decision Log"
---
# Decision Log — $STAKEHOLDER

| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
|---|------|----------|-----------|------------|--------|------|----------|
EOF

cat > "$OUTPUT/03-status/hours-log.md" << EOF
# Hours Log — $STAKEHOLDER

| Member | Date | Activity | Hours | Tag |
|--------|------|----------|-------|-----|
EOF

cat > "$OUTPUT/03-status/tasks.md" << EOF
---
access: team
type: "Task List"
---
# Tasks — $STAKEHOLDER

| ID | Task | Assignee | Status | Sprint | Due |
|----|------|----------|--------|--------|-----|
EOF

# CODEOWNERS — simplified (no GitHub usernames available)
cat > "$OUTPUT/.github/CODEOWNERS" << EOF
# $STAKEHOLDER Team Ops — Code Owners
# Update GitHub usernames below after repo creation.

* @$LEAD
/.claude/ @$LEAD
/$DIR04/ @$LEAD
/03-status/decision-log.md @$LEAD
EOF

for m in "${MEMBER_ARRAY[@]}"; do
  m=$(echo "$m" | xargs)
  echo "/05-personal/$m/ @$m" >> "$OUTPUT/.github/CODEOWNERS"
done

# .gitignore
cat > "$OUTPUT/.gitignore" << EOF
.env
.env.local
.aios/
*.pyc
__pycache__/
.DS_Store
node_modules/
EOF

# .planning README
cat > "$OUTPUT/.planning/README.md" << EOF
# Team Planning

Deliberation space. Files here are for team discussion, not promotion.
EOF

# Initialize git
echo "Initializing git..."
cd "$OUTPUT"
git init -q
git add -A
git commit -q -m "feat: scaffold $SLUG from Agentic Team Ops template"

echo ""
echo -e "${GREEN}Scaffold complete!${NC}"
echo ""
echo "Next steps:"
echo "  1. Review the generated files in: $OUTPUT"
echo "  2. Create GitHub repo: gh repo create $ORG/$SLUG --private --source=$OUTPUT --push"
echo "  3. Add collaborators: gh api repos/$ORG/$SLUG/collaborators/<username> -X PUT"
echo "  4. Set up branch protection on main"
echo "  5. Connect to the Team Brain: set AIOS_API_KEY in .env, fill aios.yaml, run 'aios status'"
echo ""
echo "Run validation:"
echo "  $REPO_ROOT/validation/validate-all.sh $OUTPUT"
