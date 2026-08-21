#!/bin/bash
# check-secrets.sh — OGR03: Scan for secrets in committed files
#
# Usage:
#   ./validation/check-secrets.sh <path-to-repo>
#
# CRITICAL severity — any match is a hard failure.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

if [ $# -eq 0 ]; then
  echo "Usage: $0 <path-to-repo>"
  exit 1
fi

REPO="$1"
ERRORS=0

if [ ! -d "$REPO" ]; then
  echo -e "${RED}Error: Directory not found: $REPO${NC}"
  exit 1
fi

echo "OGR03: Scanning for secrets in $REPO"
echo "================================================"
echo -e "${RED}SEVERITY: CRITICAL — any match blocks${NC}"
echo ""

# Patterns to detect secrets
# Each entry: "label|regex"
PATTERNS=(
  "AWS Access Key|AKIA[0-9A-Z]{16}"
  "AWS Secret Key|aws_secret_access_key\s*=\s*[A-Za-z0-9/+=]{40}"
  "Generic API Key|['\"]?api[_-]?key['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]"
  "Generic Secret|['\"]?secret['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]"
  "Generic Token|['\"]?token['\"]?\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]"
  "Private Key Header|-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
  # AIO-952: GitHub and Slack tokens are matched via validation/secret-patterns.txt, which is
  # merged below. Inline copies drifted — the old inline Slack rule lacked the AIO-965 left
  # token boundary, silently re-opening the hyphenated-prose false-positive class inside this
  # scanner. Do not re-add value rules here that the shared file already owns.
  "Toggl API Token|[0-9a-f]{32}"
  # Userinfo tokens are anchored: `user`/`pass` contain no `/`, `@`, whitespace, or quote, so the
  # pattern cannot bridge an ordinary `scheme://host/…:…@…` span (e.g. minified CSS, where an earlier
  # `prop:val` colon and a later `@rule` used to be stitched into a false match). POSIX `[:space:]`
  # is used, NOT `\s` — inside a grep bracket expression `\s` is a literal `s`, which would silently
  # drop any credential whose username contains an `s`.
  "Basic Auth URL|https?://[^:/@[:space:]\"']+:[^/@[:space:]\"']+@"
  "Password Assignment|password\s*[:=]\s*['\"][^'\"]{8,}['\"]"
  "Bearer Token|Bearer\s+[A-Za-z0-9_\-\.]{20,}"
)

# OGR03 scans executable test fixtures and generated design sources instead of
# excluding those trees. A small set of explicit, non-secret literals therefore
# needs line-level classification. Keep these exceptions exact: nearby opaque
# values must continue to fail the same underlying patterns.
strip_known_non_secrets() {
  local label="$1"
  local line="$2"
  local match_file="$3"
  local placeholder
  local sanitized="$line"
  local placeholders=(
    datamechanics_secret
    test-auth-secret-which-is-long-enough
    existing-auth-secret-do-not-rotate
    xoxb-EXAMPLE-NOT-REAL
    xoxb-LOCAL
    xoxb-x
    xoxb-SUPER-secret-token-zzz999
    xoxb-REAL-slack-token-abc123
    xoxb-TIER-secret-token-abc123
    xoxb-bot-token
    xoxp-invalid
    xoxb-test
    xoxb-1234567890-abcdefABCDEF
    xoxb-123
    sk-ant-REAL-anthropic-key-xyz
    example-invite-password
    second-invite-password
    whatever-password
    not-the-real-password
  )

  for placeholder in "${placeholders[@]}"; do
    # Token-character boundaries prevent a short fixture such as xoxb-123 from
    # allowlisting a real credential that merely begins with those bytes.
    sanitized=$(printf '%s\n' "$sanitized" | sed -E "s/(^|[^A-Za-z0-9_-])${placeholder}([^A-Za-z0-9_-]|$)/\\1\\2/g")
  done

  # AIO-965: the roster above is a hardcoded list of THIS repo's own fixtures, which cannot work
  # for the arbitrary workspaces that now vendor this scanner — every workspace would have to get
  # its own test doubles added upstream. Generalize it: drop any credential-shaped token carrying
  # an explicit not-a-secret marker. A real credential does not contain the string "SENTINEL"; a
  # deliberately-fake one in a test log or a doc almost always does. This is what lets a workspace
  # document how its auth failure modes behave without the guard going red forever.
  # Scoped to whole tokens so a marker can never allowlist an adjacent real value.
  sanitized=$(printf '%s\n' "$sanitized" | sed -E \
    's/(^|[^A-Za-z0-9_-])[A-Za-z0-9_-]*(SENTINEL|EXAMPLE|PLACEHOLDER|REDACTED|CHANGEME|DUMMY|BOGUS|NOT-?A-?REAL|NOT-?REAL|FAKE)[A-Za-z0-9_-]*([^A-Za-z0-9_-]|$)/\1\3/gI')

  # This is Railway's prompt shown to the operator, not a configured value.
  if [ "$label" = "Password Assignment" ] &&
    [[ "$sanitized" == *"ADMIN_PASSWORD: 'A strong first-login password'"* ]]; then
    sanitized="${sanitized//ADMIN_PASSWORD: \'A strong first-login password\'/ADMIN_PASSWORD_PROMPT}"
  fi
  if [ "$label" = "Password Assignment" ] &&
    [[ "$sanitized" == *'credentialSummary({ password: "generated", supplied: false })'* ]]; then
    sanitized="${sanitized//'credentialSummary({ password: "generated", supplied: false })'/'credentialSummary({ generated: true, supplied: false })'}"
  fi

  # Pencil stores a document identifier under this misleading field name. Only
  # an RFC-4122 UUID in the exact JSON field is exempt; opaque fileToken values
  # and UUIDs assigned to ordinary token fields remain findings.
  if [ "$label" = "Generic Token" ] && [[ "$match_file" == */aios-design.pen ]] &&
    printf '%s\n' "$sanitized" | grep -qE '"fileToken"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"'; then
    sanitized=$(printf '%s\n' "$sanitized" | sed -E 's/"fileToken"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}"/"fileDocumentId": "[OGR03-DOCUMENT-ID]"/g')
  fi

  printf '%s\n' "$sanitized"
}

# Files to scan (exclude .git, binary files, local .env, .env.example, the vendored
# skill-library — integrity-locked official upstream skills (OGR09), whose docs
# carry example/placeholder tokens like "xoxp-new-..." that are not real secrets —
# skill-scan-fixtures, the deliberately-malicious scanner test inputs, and the
# gitignored agentic UX-testing harness OUTPUT (test/ux/evidence/ — screenshots
# and transcripts from throwaway cockpit fixtures). Committed harness code and
# fixtures ARE scanned: they use clearly-non-secret dummy values.)
#
# ENUMERATION IS VIA GIT, NEVER A FILESYSTEM WALK (AIO-517). A bare `find` descends
# into gitignored build trees — `src-tauri/target` alone is 1.6 GB / 35k files — and
# because every pattern re-greps the whole list, the scan never finishes. That failure
# presents as a hung/exhausted gate, NOT as a finding, which is the worst possible
# failure mode for a security scanner. Git's own file list (tracked + untracked-but-
# not-ignored) is exactly the content that can ever reach a commit, which is all OGR03
# cares about, and it makes every ignored tree structurally invisible — no ad-hoc
# exclude list to keep in sync. Non-git targets (e.g. the throwaway change-set dir that
# `aios build` assembles and scans) fall back to a walk; those dirs hold only the copied
# change set, so there is no ignored tree to descend into.
#
# NUL-delimited file list. A newline-joined list piped through `xargs` word-splits on
# spaces, so any file with a space in its name (transcripts, "meeting notes.md", Granola
# pulls) was silently skipped — the files most likely to hold pasted credentials. -print0 +
# xargs -0 makes the scan whitespace-safe (H2).
SCAN_LIST=$(mktemp "${TMPDIR:-/tmp}/aios-scan.XXXXXX")
trap 'rm -f "$SCAN_LIST"' EXIT

# AIO-965: `.aios-secretignore` — a workspace-controlled scope file, read from the repo root.
#
# WHY THIS EXISTS. This scanner now ships into personal workspaces, which hold content the toolkit
# never anticipated: pulled issue trackers, meeting transcripts, battletest logs that deliberately
# quote malformed tokens. Those produce matches that are not secrets and cannot be fixed by editing
# the content. Before this, the only lever was a hardcoded fixture list upstream — so the realistic
# outcome was a permanently-red OGR03, and a guard that is always red is a guard nobody reads.
#
# The mechanism is deliberately DUMB and VISIBLE: literal shell globs, one per line, in a file the
# owner commits. No auto-suppression, no severity tiers, no "seen before" state. Silencing a path
# is an explicit, reviewable act — which is the property that keeps the remaining red meaningful.
# A trailing "/" matches everything beneath that directory.
SECRET_IGNORES=()
if [ -f "$REPO/.aios-secretignore" ]; then
  while IFS= read -r ignore_line || [ -n "$ignore_line" ]; do
    ignore_line="${ignore_line%%$'\r'}"
    case "$ignore_line" in ""|\#*) continue ;; esac
    SECRET_IGNORES+=("$ignore_line")
  done < "$REPO/.aios-secretignore"
fi

# One filter for both enumeration modes so their semantics cannot drift.
# $1 = path relative to $REPO. Emits the absolute path, NUL-terminated, when scannable.
emit_if_scannable() {
  case "/$1" in
    */.git/* | */node_modules/* | */skill-library/* | */skill-scan-fixtures/*) return 0 ;;
    */test/ux/evidence/*) return 0 ;;
    */.env | */.env.example) return 0 ;;
    *.pdf | *.png | *.jpg | *.jpeg | *.gif | *.xlsx | *.docx) return 0 ;;
    */check-secrets.sh | */secret-patterns.txt) return 0 ;;
    # The scope file names the shapes it is silencing, so it contains credential-shaped text
    # by construction — self-scanning it is the same self-reference already excluded above.
    */.aios-secretignore) return 0 ;;
  esac
  # Owner-declared exclusions. Matched against the repo-relative path, both bare and "/"-anchored,
  # so "1-inbox/from-brain/" and "/1-inbox/from-brain/" both read naturally.
  local ignore_pattern
  for ignore_pattern in ${SECRET_IGNORES+"${SECRET_IGNORES[@]}"}; do
    case "$ignore_pattern" in
      */) [[ "$1/" == ${ignore_pattern}* || "$1/" == ${ignore_pattern#/}* ]] && return 0 ;;
      *) [[ "$1" == $ignore_pattern || "/$1" == $ignore_pattern ]] && return 0 ;;
    esac
  done
  local abs="$REPO/$1"
  # Mirror `find -type f`: skip symlinks, directories, gitlinks and vanished paths.
  [ -L "$abs" ] && return 0
  [ -f "$abs" ] || return 0
  printf '%s\0' "$abs"
}

if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  {
    git -C "$REPO" ls-files -z
    git -C "$REPO" ls-files -z -o --exclude-standard
  } | while IFS= read -r -d '' rel; do
    emit_if_scannable "$rel"
  done > "$SCAN_LIST"
else
  find "$REPO" -not -path "*/.git/*" -not -path "*/node_modules/*" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' abs; do
      emit_if_scannable "${abs#"$REPO"/}"
    done > "$SCAN_LIST" || true
fi

# Merge in shared patterns (validation/secret-patterns.txt) — the single
# source also consumed by hooks/team-ops-guard.sh and scripts/aios.mjs.
# FAIL CLOSED if it is missing (AIO-952): the GitHub/Slack value rules live only
# there now, so a vendored copy of this script without its sibling would silently
# scan with a strictly weaker rule set and still print PASSED — the exact failure
# mode this scanner exists to prevent. Scaffolding and the toolkit manifest always
# ship the two files together; a missing sibling is a broken deployment, not a mode.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/secret-patterns.txt" ]; then
  while IFS= read -r shared_pattern; do
    [ -z "$shared_pattern" ] && continue
    case "$shared_pattern" in \#*) continue ;; esac
    PATTERNS+=("Shared pattern|$shared_pattern")
  done < "$SCRIPT_DIR/secret-patterns.txt"
else
  echo -e "  ${RED}✗ missing $SCRIPT_DIR/secret-patterns.txt — scan cannot be trusted${NC}" >&2
  ERRORS=$((ERRORS + 1))
fi

for entry in "${PATTERNS[@]}"; do
  label="${entry%%|*}"
  pattern="${entry#*|}"

  # Fail closed on an invalid pattern. `xargs grep … || true` can't distinguish grep's "no match"
  # (exit 1) from "error" (exit 2) — xargs collapses both to 123 — so a malformed ERE ever landing
  # in secret-patterns.txt would otherwise silently disable that pattern forever. Validate the regex
  # against empty input first (valid → exit 1, invalid → exit 2) and hard-fail the scan if it's bad.
  # `|| validity=$?` keeps this off `set -e` (grep exits 1 on the normal no-match). valid → 1, invalid → 2.
  validity=0
  printf '' | grep -qE -e "$pattern" 2>/dev/null || validity=$?
  if [ "$validity" -eq 2 ]; then
    echo -e "  ${RED}✗ invalid secret pattern (regex) — scan cannot be trusted: ${label}${NC}" >&2
    ERRORS=$((ERRORS + 1))
    continue
  fi

  # Special case: Toggl tokens are 32-char hex but appear in many contexts
  # Only flag if near "toggl" or "api" keywords
  # Guard the empty-list case: with no input, both BSD and GNU xargs would run grep once
  # with no file args, making it read stdin and hang. Only scan when the list is non-empty.
  FINDINGS="${SCAN_LIST}.findings"
  : > "$FINDINGS"
  if [ -s "$SCAN_LIST" ]; then
    effective_pattern="$pattern"
    if [ "$label" = "Toggl API Token" ]; then
      effective_pattern="(toggl|api).{0,20}$pattern"
    fi

    # Keep grep batched: invoking it once per file turns a cross-repo release
    # gate into files × patterns processes. -a is security-critical: without it,
    # one NUL byte changes grep's output to "Binary file ... matches", which has
    # no line number and was silently discarded by the parser. -H preserves the
    # source path while xargs -0 retains whitespace-safe file enumeration.
    while IFS= read -r hit; do
      [ -z "$hit" ] && continue
      match_file="${hit%%:*}"
      numbered_line="${hit#*:}"
      line_number="${numbered_line%%:*}"
      matched_line="${numbered_line#*:}"
      # AIO-952: VALUE-BOUND fixture declaration. "aios-secret-fixture:<prefix>" — at
      # least 12 token chars of the declared value, or the full value — suppresses ONLY
      # credential-shaped tokens on this line that START WITH the declared prefix. It is
      # the reviewable alternative to renaming a binding (the PR #575 bypass) when a
      # fixture value has to stay realistic and marker-free: the marker lives OUTSIDE
      # the value, so it composes with the AIO-965 token sanitizer below. Whole-line
      # semantics would be a gate bypass — a one-line file (minified bundle, JSON,
      # transcript) carrying any marker would scan entirely clean, real secrets
      # included — so declared tokens are stripped and every pattern re-checked: an
      # undeclared secret sharing the line still fails. Case-insensitive to mirror this
      # scanner's grep -i. Declaring a REAL credential's prefix is the same explicit,
      # diff-visible act as editing .aios-secretignore.
      while IFS= read -r declared; do
        [ -n "$declared" ] || continue
        declared_prefix="${declared#*:}"
        matched_line=$(printf '%s\n' "$matched_line" |
          sed -E "s/(^|[^A-Za-z0-9_-])${declared_prefix}[A-Za-z0-9_-]*/\1/gI")
      done < <(printf '%s\n' "$matched_line" |
        grep -oiE 'aios-secret-fixture:[A-Za-z0-9_-]{12,}' || true)
      sanitized_line=$(strip_known_non_secrets "$label" "$matched_line" "$match_file")
      if ! printf '%s\n' "$sanitized_line" | grep -qiE -e "$effective_pattern"; then
        continue
      fi
      # Never persist or print the matching line. The raw bytes are needed only
      # for the in-memory false-positive classification above; diagnostics keep
      # the actionable rule, file and line number without turning CI logs (or
      # this temporary findings file) into a second secret exposure.
      printf '%s\t%s\n' "$match_file" "$line_number" >> "$FINDINGS"
    done < <(xargs -0 grep -aHniE -e "$effective_pattern" < "$SCAN_LIST" 2>/dev/null || true)
  fi

  if [ -s "$FINDINGS" ]; then
    echo -e "  ${RED}✗ $label${NC}"
    last_file=""
    while IFS=$'\t' read -r match_file line_number; do
      rel_path="${match_file#"$REPO"/}"
      if [ "$match_file" != "$last_file" ]; then
        echo "    $rel_path:"
        last_file="$match_file"
      fi
      echo "      line $line_number: [REDACTED]"
    done < "$FINDINGS"
    ERRORS=$((ERRORS + 1))
  fi
  rm -f "$FINDINGS"
done

# Also check for .env files that are actually TRACKED by git — not just present on
# disk. Scaffolded workspaces now auto-create .env from .env.example (so dotenvx
# never crashes on a missing file) and gitignore it in the same step; a real,
# gitignored-but-uncommitted .env is expected and safe, not a leak. Only a file git
# would actually include in a commit is the real OGR03 concern.
#
# Asked of git directly (AIO-517): the tracked file list IS the answer, so there is no
# reason to walk the disk to find candidates and then re-ask git about each one. A
# `.git` DIRECTORY test also silently skipped this check inside a linked worktree,
# where `.git` is a file — `rev-parse` is correct in both.
TRACKED_ENV_FILES=""
if git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  while IFS= read -r -d '' rel_path; do
    case "/$rel_path" in
      */.env) TRACKED_ENV_FILES="${TRACKED_ENV_FILES}${rel_path}"$'\n' ;;
    esac
  done < <(git -C "$REPO" ls-files -z)
fi
if [ -n "$TRACKED_ENV_FILES" ]; then
  echo -e "  ${RED}✗ .env file committed${NC}"
  echo "$TRACKED_ENV_FILES" | while IFS= read -r rel_path; do
    [ -z "$rel_path" ] && continue
    echo "    $rel_path"
  done
  ERRORS=$((ERRORS + 1))
fi

# Summary
echo ""
echo "================================================"
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}OGR03 PASSED — no secrets detected${NC}"
  exit 0
else
  echo -e "${RED}OGR03 FAILED — $ERRORS pattern(s) matched${NC}"
  echo "Review matches above. Remove secrets and rotate any exposed credentials."
  exit 1
fi
