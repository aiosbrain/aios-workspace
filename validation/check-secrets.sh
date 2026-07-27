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
  "GitHub Token|gh[ps]_[A-Za-z0-9_]{36,}"
  "Slack Token|xox[bporas]-[A-Za-z0-9-]+"
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

# One filter for both enumeration modes so their semantics cannot drift.
# $1 = path relative to $REPO. Emits the absolute path, NUL-terminated, when scannable.
emit_if_scannable() {
  case "/$1" in
    */.git/* | */node_modules/* | */skill-library/* | */skill-scan-fixtures/*) return 0 ;;
    */test/ux/evidence/*) return 0 ;;
    */.env | */.env.example) return 0 ;;
    *.pdf | *.png | *.jpg | *.jpeg | *.gif | *.xlsx | *.docx) return 0 ;;
    */check-secrets.sh | */secret-patterns.txt) return 0 ;;
  esac
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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/secret-patterns.txt" ]; then
  while IFS= read -r shared_pattern; do
    [ -z "$shared_pattern" ] && continue
    case "$shared_pattern" in \#*) continue ;; esac
    PATTERNS+=("Shared pattern|$shared_pattern")
  done < "$SCRIPT_DIR/secret-patterns.txt"
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
  if [ ! -s "$SCAN_LIST" ]; then
    matches=""
  elif [ "$label" = "Toggl API Token" ]; then
    matches=$(xargs -0 grep -lniE -e "(toggl|api).{0,20}$pattern" < "$SCAN_LIST" 2>/dev/null || true)
  else
    matches=$(xargs -0 grep -lniE -e "$pattern" < "$SCAN_LIST" 2>/dev/null || true)
  fi

  if [ -n "$matches" ]; then
    echo -e "  ${RED}✗ $label${NC}"
    while IFS= read -r match_file; do
      rel_path="${match_file#$REPO/}"
      # Show the matching line (truncated) but redact the actual secret
      line=$(grep -niE -e "$pattern" -- "$match_file" 2>/dev/null | head -3 | sed 's/\(.\{80\}\).*/\1.../')
      echo "    $rel_path:"
      echo "$line" | while IFS= read -r l; do
        echo "      $l"
      done
    done <<< "$matches"
    ERRORS=$((ERRORS + 1))
  fi
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
