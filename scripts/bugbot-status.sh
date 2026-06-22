#!/usr/bin/env bash
# bugbot-status.sh — poll Cursor Bugbot on a GitHub PR (no email required).
#
# Usage:
#   scripts/bugbot-status.sh <pr-number> [owner/repo]
#
# Defaults owner/repo to the current git remote (origin), or AIOS-alpha/aios-workspace.
# Requires: gh CLI (with jq), authenticated for the target repo.
#
# Exit codes:
#   0 — Bugbot check completed with success (no unresolved findings per GitHub)
#   1 — usage / gh error
#   2 — Bugbot completed with neutral or failure, or usage-limit / skip comments
#   3 — Bugbot still pending / in progress

set -euo pipefail

PR="${1:-}"
if [[ -z "$PR" || "$PR" == "-h" || "$PR" == "--help" ]]; then
  cat <<'EOF'
Usage: bugbot-status.sh <pr-number> [owner/repo]

Poll Cursor Bugbot check status and recent cursor[bot] PR comments.

Examples:
  scripts/bugbot-status.sh 57
  scripts/bugbot-status.sh 57 AIOS-alpha/aios-workspace

Exit codes:
  0  Bugbot check success
  2  Bugbot neutral/failure, or cursor[bot] reported it could not run
  3  Bugbot still in progress
EOF
  exit 1
fi

REPO_SLUG="${2:-}"
if [[ -z "$REPO_SLUG" ]]; then
  if REPO_SLUG="$(git remote get-url origin 2>/dev/null)"; then
    REPO_SLUG="${REPO_SLUG#git@github.com:}"
    REPO_SLUG="${REPO_SLUG#https://github.com/}"
    REPO_SLUG="${REPO_SLUG%.git}"
  else
    REPO_SLUG="AIOS-alpha/aios-workspace"
  fi
fi

OWNER="${REPO_SLUG%%/*}"
REPO="${REPO_SLUG##*/}"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "error: jq not found (brew install jq)" >&2
  exit 1
fi

SHA="$(gh pr view "$PR" --repo "$OWNER/$REPO" --json headRefOid -q .headRefOid)"
TITLE="$(gh pr view "$PR" --repo "$OWNER/$REPO" --json title -q .title)"

echo "PR #$PR — $TITLE"
echo "Head: $SHA"
echo "Repo: $OWNER/$REPO"
echo

echo "=== Cursor Bugbot check runs ==="
CHECK_JSON="$(gh api "repos/$OWNER/$REPO/commits/$SHA/check-runs" \
  --jq '[.check_runs[] | select(.name | test("Bugbot")) | {name, status, conclusion, html_url}]')"
if [[ "$CHECK_JSON" == "[]" ]]; then
  echo "(no Bugbot check runs on this commit)"
  BUGBOT_PENDING=1
  BUGBOT_BAD=0
else
  echo "$CHECK_JSON" | jq -r '.[] | "\(.name): \(.status) / \(.conclusion // "pending") — \(.html_url)"'
  BUGBOT_PENDING=0
  BUGBOT_BAD=0
  while IFS= read -r line; do
    status="$(echo "$line" | jq -r .status)"
    conclusion="$(echo "$line" | jq -r '.conclusion // ""')"
    if [[ "$status" == "queued" || "$status" == "in_progress" ]]; then
      BUGBOT_PENDING=1
    fi
    if [[ "$conclusion" == "neutral" || "$conclusion" == "failure" ]]; then
      BUGBOT_BAD=1
    fi
  done < <(echo "$CHECK_JSON" | jq -c '.[]')
fi

echo
echo "=== cursor[bot] PR comments (latest 5) ==="
BOT_COMMENTS="$(gh api "repos/$OWNER/$REPO/issues/$PR/comments" \
  --jq '[.[] | select(.user.login == "cursor[bot]") | {created_at, body}] | .[-5:]')"
if [[ "$BOT_COMMENTS" == "[]" ]]; then
  echo "(none)"
else
  echo "$BOT_COMMENTS" | jq -r '.[] | "\(.created_at)\n\(.body | split("\n")[0])\n"'
fi

USAGE_BLOCKED=0
if echo "$BOT_COMMENTS" | grep -qi "usage limit reached\|couldn't run"; then
  USAGE_BLOCKED=1
fi

echo
echo "=== Unresolved Bugbot inline threads ==="
THREADS="$(gh api graphql -f query="
  query(\$o: String!, \$r: String!, \$n: Int!) {
    repository(owner: \$o, name: \$r) {
      pullRequest(number: \$n) {
        reviewThreads(first: 100) {
          nodes {
            isResolved
            comments(first: 3) {
              nodes { author { login } path line body }
            }
          }
        }
      }
    }
  }" -f o="$OWNER" -f r="$REPO" -F n="$PR" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false)
    | select(.comments.nodes[0].author.login | test("cursor|bugbot"; "i"))
    | {path: .comments.nodes[0].path, line: .comments.nodes[0].line,
       preview: (.comments.nodes[0].body | split("\n")[0])}]')"
COUNT="$(echo "$THREADS" | jq 'length')"
if [[ "$COUNT" -eq 0 ]]; then
  echo "(none)"
else
  echo "$THREADS" | jq -r '.[] | "- \(.path // "?"):\(.line // "?") — \(.preview)"'
fi

echo
echo "=== Summary ==="
if [[ "$USAGE_BLOCKED" -eq 1 ]]; then
  echo "Bugbot did NOT run — Cursor usage/spend limit (see cursor[bot] comments)."
  echo "Use local /review-bugbot or raise limits: https://www.cursor.com/dashboard/spending"
  exit 2
fi
if [[ "$BUGBOT_PENDING" -eq 1 ]]; then
  echo "Bugbot still pending — re-run this script in a minute."
  exit 3
fi
if [[ "$BUGBOT_BAD" -eq 1 || "$COUNT" -gt 0 ]]; then
  echo "Bugbot reported issues or unresolved inline threads."
  exit 2
fi
if [[ "$CHECK_JSON" != "[]" ]]; then
  echo "Bugbot check passed (success)."
  exit 0
fi
echo "No Bugbot check found — comment 'bugbot run' on the PR to trigger."
exit 3
