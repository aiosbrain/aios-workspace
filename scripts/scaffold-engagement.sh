#!/bin/bash
# scaffold-engagement.sh — Spawn a new team-ops repo from the Agentic Team Ops scaffold
#
# Usage:
#   ./scripts/scaffold-engagement.sh \
#     --slug acme-team-ops \
#     --client "Acme Corp" \
#     --client-full "Acme Corporation Ltd" \
#     --desc "AI Workflow Automation" \
#     --captain john \
#     --members "alex,sam,jordan" \
#     --org your-github-org \
#     --currency GBP \
#     --output ~/Projects/acme-team-ops
#
#   --dry-run    Preview without creating anything

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
CLIENT=""
CLIENT_FULL=""
DESC=""
CAPTAIN=""
MEMBERS=""
ORG="your-github-org"
CURRENCY="USD"
OUTPUT=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2 ;;
    --client) CLIENT="$2"; shift 2 ;;
    --client-full) CLIENT_FULL="$2"; shift 2 ;;
    --desc) DESC="$2"; shift 2 ;;
    --captain) CAPTAIN="$2"; shift 2 ;;
    --members) MEMBERS="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --currency) CURRENCY="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      echo "Usage: $0 --slug <slug> --client <name> --captain <name> --members <csv> [options]"
      echo ""
      echo "Required:"
      echo "  --slug        Repo name (e.g., acme-team-ops)"
      echo "  --client      Short client name (e.g., Acme Corp)"
      echo "  --captain     Team captain (e.g., john)"
      echo "  --members     Comma-separated member list (e.g., alex,sam,jordan)"
      echo ""
      echo "Optional:"
      echo "  --client-full Full legal client name (defaults to --client)"
      echo "  --desc        Engagement description (e.g., AI Workflow Automation)"
      echo "  --org         GitHub org (default: your-github-org)"
      echo "  --currency    Billing currency (default: USD)"
      echo "  --output      Output directory (default: ~/Projects/<slug>)"
      echo "  --dry-run     Preview the scaffold without creating files"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Validate required args
for var in SLUG CLIENT CAPTAIN MEMBERS; do
  if [ -z "${!var}" ]; then
    echo -e "${RED}Error: --$(echo $var | tr '[:upper:]' '[:lower:]') is required${NC}"
    exit 1
  fi
done

# Defaults
CLIENT_FULL="${CLIENT_FULL:-$CLIENT}"
DESC="${DESC:-consulting engagement}"
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

echo -e "${BLUE}Agentic Team Ops — Engagement Scaffold${NC}"
echo "================================================"
echo "  Slug:     $SLUG"
echo "  Client:   $CLIENT ($CLIENT_FULL)"
echo "  Desc:     $DESC"
echo "  Captain:  $CAPTAIN"
echo "  Members:  $MEMBER_LIST ($MEMBER_COUNT)"
echo "  Org:      $ORG"
echo "  Currency: $CURRENCY"
echo "  Output:   $OUTPUT"
echo "  Mode:     $([ "$DRY_RUN" = true ] && echo "DRY RUN" || echo "CREATE")"
echo "================================================"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}DRY RUN — showing what would be created:${NC}"
  echo ""
  echo "Directories:"
  echo "  $OUTPUT/"
  echo "  $OUTPUT/.claude/rules/"
  echo "  $OUTPUT/.github/"
  echo "  $OUTPUT/.planning/"
  echo "  $OUTPUT/00-engagement/"
  echo "  $OUTPUT/01-intake/{email,transcripts,reference}/"
  echo "  $OUTPUT/02-deliverables/"
  echo "  $OUTPUT/03-status/"
  echo "  $OUTPUT/04-client-surface/"
  for m in "${MEMBER_ARRAY[@]}"; do
    m=$(echo "$m" | xargs)
    echo "  $OUTPUT/05-personal/$m/{01-intake/{inbox,transcripts,email},02-deliverables,03-status,04-client-surface,.claude,.planning}/"
  done
  echo ""
  echo "Files:"
  echo "  README.md"
  echo "  engagement.yaml"
  echo "  contacts.yaml"
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
mkdir -p "$OUTPUT"/00-engagement
mkdir -p "$OUTPUT"/01-intake/{email,transcripts,reference}
mkdir -p "$OUTPUT"/02-deliverables
mkdir -p "$OUTPUT"/03-status
mkdir -p "$OUTPUT"/04-client-surface

for m in "${MEMBER_ARRAY[@]}"; do
  m=$(echo "$m" | xargs)
  mkdir -p "$OUTPUT/05-personal/$m"/{01-intake/{inbox,transcripts,email},02-deliverables,03-status,04-client-surface,.claude,.planning}
  touch "$OUTPUT/05-personal/$m/01-intake/transcripts/.gitkeep"
  touch "$OUTPUT/05-personal/$m/01-intake/email/.gitkeep"
  touch "$OUTPUT/05-personal/$m/02-deliverables/.gitkeep"
  touch "$OUTPUT/05-personal/$m/04-client-surface/.gitkeep"

  # Personal CLAUDE.md
  cat > "$OUTPUT/05-personal/$m/.claude/CLAUDE.md" << PEOF
# $m's Personal Workspace

Read \`00-engagement/my-scope.md\` and \`03-status/tasks.md\` for orientation.
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
    -e "s|{{CLIENT_NAME}}|$CLIENT|g" \
    -e "s|{{CLIENT_FULL_NAME}}|$CLIENT_FULL|g" \
    -e "s|{{ENGAGEMENT_DESC}}|$DESC|g" \
    -e "s|{{CAPTAIN}}|$CAPTAIN|g" \
    -e "s|{{MEMBER_COUNT}}|$MEMBER_COUNT|g" \
    -e "s|{{MEMBER_LIST}}|$MEMBER_LIST|g" \
    -e "s|{{CURRENCY}}|$CURRENCY|g" \
    -e "s|{{START_DATE}}|$START_DATE|g" \
    "$src" > "$dest"
}

process_template "$SCAFFOLD/README.md.tmpl" "$OUTPUT/README.md"
process_template "$SCAFFOLD/.claude/CLAUDE.md.tmpl" "$OUTPUT/.claude/CLAUDE.md"

# engagement.yaml needs multiline member substitution
sed \
  -e "s|{{SLUG}}|$SLUG|g" \
  -e "s|{{CLIENT_NAME}}|$CLIENT|g" \
  -e "s|{{CLIENT_FULL_NAME}}|$CLIENT_FULL|g" \
  -e "s|{{CAPTAIN}}|$CAPTAIN|g" \
  -e "s|{{CURRENCY}}|$CURRENCY|g" \
  -e "s|{{START_DATE}}|$START_DATE|g" \
  "$SCAFFOLD/engagement.yaml.tmpl" | \
  awk -v members="$(printf '%s' "$MEMBERS_YAML")" '{gsub(/\{\{MEMBERS_YAML\}\}/, members); print}' \
  > "$OUTPUT/engagement.yaml"

# contacts.yaml — simple for now
sed \
  -e "s|{{CLIENT_NAME}}|$CLIENT|g" \
  -e "s|{{CONTACTS_YAML}}|  # Add team contacts here|g" \
  "$SCAFFOLD/contacts.yaml.tmpl" > "$OUTPUT/contacts.yaml"

# Copy shared rules
cp "$SCAFFOLD/.claude/rules/"*.md "$OUTPUT/.claude/rules/"

# Copy shared skills (dynamic-workflow harnesses + their SKILL.md)
if [ -d "$SCAFFOLD/.claude/skills" ]; then
  mkdir -p "$OUTPUT/.claude/skills"
  cp -R "$SCAFFOLD/.claude/skills/." "$OUTPUT/.claude/skills/"
fi

# Create status files
cat > "$OUTPUT/03-status/decision-log.md" << EOF
# Decision Log — $CLIENT

| # | Date | Decision | Rationale | Decided By | Impact | Type | Audience |
|---|------|----------|-----------|------------|--------|------|----------|
EOF

cat > "$OUTPUT/03-status/hours-log.md" << EOF
# Hours Log — $CLIENT

| Member | Date | Activity | Hours | Tag |
|--------|------|----------|-------|-----|
EOF

cat > "$OUTPUT/03-status/tasks.md" << EOF
# Tasks — $CLIENT

| ID | Task | Assignee | Status | Sprint | Due |
|----|------|----------|--------|--------|-----|
EOF

# CODEOWNERS — simplified (no GitHub usernames available)
cat > "$OUTPUT/.github/CODEOWNERS" << EOF
# $CLIENT Team Ops — Code Owners
# Update GitHub usernames below after repo creation.

* @$CAPTAIN
/.claude/ @$CAPTAIN
/04-client-surface/ @$CAPTAIN
/03-status/decision-log.md @$CAPTAIN
EOF

for m in "${MEMBER_ARRAY[@]}"; do
  m=$(echo "$m" | xargs)
  echo "/05-personal/$m/ @$m" >> "$OUTPUT/.github/CODEOWNERS"
done

# .gitignore
cat > "$OUTPUT/.gitignore" << EOF
.env
.env.local
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
echo "  5. Register the new repo in your own engagement registry (see examples/)"
echo ""
echo "Run validation:"
echo "  $REPO_ROOT/validation/validate-all.sh $OUTPUT"
