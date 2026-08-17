#!/usr/bin/env bash
# team-ops-guard.sh — PreToolUse hook for Claude Code (Agentic Team Ops)
#
# Fires on Write/Edit/MultiEdit tool calls. Validates the file being written.
# Exit 0 = allow (no decision), Exit 2 + stderr = BLOCK (Claude Code's deny signal;
# any other non-zero is a non-blocking error, so blocks MUST use exit 2).
#
# Checks:
#   1. Secrets scan (API keys, tokens, passwords)
#   2. Access tag enforcement (no admin content in team/client dirs)
#   3. Frontmatter required for deliverables/client-surface
#
# Input: current Claude Code sends a JSON event on STDIN:
#   { "tool_name": "...", "tool_input": { "file_path": "...", "content": "..." } }
# We also accept CC_TOOL_NAME / CC_TOOL_INPUT env vars (used by the GUI's
# host-side guardWrite, which has no stdin). STDIN wins when present.

set -euo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Reaching a verdict at all (AIO-864 follow-up; the 0.11.0 clean-container defect) ──
#
# This guard used to shell out to `jq` with every call wrapped `2>/dev/null || true`.
# `jq` is not in package.json, was not a documented prerequisite, and is absent from
# `node:*` images, Debian/Ubuntu slim, Alpine, and most self-hosted runners — while
# macOS 15+ ships it at /usr/bin/jq and GitHub's ubuntu-latest pre-installs it. So on a
# clean install the parse produced an empty string, `set -euo pipefail` never saw the
# missing binary, and the script fell through to `exit 0  # allow`. A workspace's
# write-time secret/tier guard was inert, silently, and an AWS key was written through
# it in the 0.11.0 sandbox test at exit 0 with no output.
#
# Three things changed, in order of how much each one matters:
#
# 1. **The `jq` dependency is gone as a hard requirement.** Every extraction below is
#    reachable through `node` too, and `node` is not an assumption — it is what runs
#    this toolkit, what Claude Code itself is written in, and what the sibling
#    PreToolUse hook (`hooks/file-governance-guard.mjs`) is invoked with in the same
#    settings.json array. A machine that can run the workspace can parse this event.
#    `jq` is still preferred when present: it is the cheaper process on a hook that
#    fires on every single write.
#
# 2. **A parse failure is now distinguished from an absent field.** "Parsed fine, this
#    event carries no tool_input" is a real answer and still allows. "Could not read
#    the document" is not an answer at all, and no longer borrows the allow branch.
#
# 3. **No verdict fails CLOSED (exit 2), loudly and by name.** A missing interpreter is
#    an environmental failure, not a policy verdict, and the safe direction for a
#    security control is to refuse rather than to wave writes through. The usual
#    objection to fail-closed is that it bricks a session — the class of pain AIO-864
#    exists to remove. That objection is answered by (1): after the node fallback the
#    only way to reach this branch is to have neither `jq` nor `node` on PATH, in which
#    case the toolkit, the other hook, and the agent are all already broken. It is
#    additionally escapable with a documented env var that shouts on every invocation,
#    so "usable" never has to mean "silent".
#
# Still worth saying, since it is the deeper point: a shell guard that needs a JSON
# parser to reach any verdict is fragile by construction, and the honest end state is
# for the whole of this file to be the .mjs hook it sits next to — one process, one
# language, no interpreter roulette. That is a bigger change than a patch release
# should carry (it is the shipped file OGR08 asserts on and the file every existing
# workspace has vendored), so it is not being done here. The node fallback removes the
# defect without pretending the shape is right.

GUARD_PARSER=""
if command -v jq >/dev/null 2>&1; then
  GUARD_PARSER=jq
elif command -v node >/dev/null 2>&1; then
  GUARD_PARSER=node
fi

# The node extractor: same four selectors as the jq filters, same `//`-style fallback
# semantics (null/false fall through; "" does not). Exit 3 = the document is not JSON.
GUARD_JSON_NODE='
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  let o;
  try { o = JSON.parse(s); } catch { process.exit(3); }
  if (o === null || typeof o !== "object") process.exit(3);
  const str = (v) => (v === undefined || v === null || v === false ? null : String(v));
  const key = process.argv[1];
  let out = null;
  if (key === "tool_input") {
    const v = o.tool_input;
    out = v === undefined || v === null || v === false ? null : JSON.stringify(v);
  } else if (key === "file_path") {
    out = str(o.file_path) ?? str(o.path);
  } else if (key === "content") {
    const joined = Array.isArray(o.edits)
      ? o.edits.map((e) => (e && e.new_string !== undefined && e.new_string !== null ? String(e.new_string) : "")).join("\n")
      : "";
    out = str(o.content) ?? str(o.new_string) ?? joined;
  } else if (key === "write_content") {
    out = str(o.content);
  } else {
    process.exit(4);
  }
  process.stdout.write(out === null ? "" : out);
});
'

# guard_json <selector> — read a JSON document on stdin, print the extracted value.
# Exit 0 means the document WAS parsed; an empty print is then a real "field absent".
# Non-zero means the document could not be read — callers must route that to
# guard_no_verdict, never to an allow.
guard_json() {
  case "$GUARD_PARSER" in
    jq)
      case "$1" in
        tool_input) jq -c '.tool_input // empty' ;;
        file_path) jq -r '.file_path // .path // empty' ;;
        content) jq -r '.content // .new_string // ([.edits[]?.new_string] | join("\n")) // empty' ;;
        write_content) jq -r '.content // empty' ;;
        *) return 4 ;;
      esac
      ;;
    node) node -e "$GUARD_JSON_NODE" -- "$1" ;;
    *) return 127 ;;
  esac
}

# The guard could not read its input. Say so by name, name the cause, and never
# report "allow". The remedy lines differ by cause: a missing interpreter is fixed by
# installing one; unreadable JSON from a present parser is not.
guard_no_verdict() {
  local reason="$1"
  local degraded=0
  [ "${AIOS_GUARD_ALLOW_UNPARSED:-}" = "1" ] && degraded=1

  if [ "$degraded" -eq 1 ]; then
    echo "AIOS_GUARD_DEGRADED by team-ops-guard: no verdict — $reason." >&2
  else
    echo "BLOCKED by team-ops-guard: AIOS_GUARD_NO_JSON_PARSER — no verdict — $reason." >&2
  fi
  echo "  This hook scans writes for secrets and admin-tier content before they land." >&2
  echo "  It needs a JSON parser to read the tool event, and it will not report 'allow'" >&2
  echo "  on input it never read." >&2
  if [ -z "$GUARD_PARSER" ]; then
    echo "  Cause: neither 'jq' nor 'node' is on PATH." >&2
    echo "  Fix: install jq (apt-get install -y jq / brew install jq), or put node >= 22" >&2
    echo "  on PATH — the toolkit needs node anyway." >&2
  else
    echo "  Cause: '$GUARD_PARSER' is on PATH but could not read this event as JSON." >&2
    echo "  Fix: the caller must send the Claude Code PreToolUse event JSON on stdin," >&2
    echo "  or set CC_TOOL_INPUT to the tool_input object." >&2
  fi

  if [ "$degraded" -eq 1 ]; then
    echo "  AIOS_GUARD_ALLOW_UNPARSED=1 is set, so this write is ALLOWED UNCHECKED." >&2
    echo "  Secret, access-tier and frontmatter enforcement are OFF for this write." >&2
    exit 0
  fi
  echo "  Escape hatch, writes then UNCHECKED: export AIOS_GUARD_ALLOW_UNPARSED=1" >&2
  exit 2
}

# Parse tool input from stdin JSON (Claude Code) or env (GUI guardWrite).
STDIN_JSON=$(cat 2>/dev/null || true)
if [ -z "$STDIN_JSON" ] && [ -z "${CC_TOOL_INPUT:-}" ]; then
  exit 0  # No event at all (e.g. invoked with </dev/null) — nothing to check, allow
fi

[ -n "$GUARD_PARSER" ] || guard_no_verdict "neither 'jq' nor 'node' is on PATH"

if [ -n "$STDIN_JSON" ]; then
  TOOL_INPUT=$(printf '%s' "$STDIN_JSON" | guard_json tool_input) ||
    guard_no_verdict "the tool event on stdin is not readable JSON"
else
  TOOL_INPUT="${CC_TOOL_INPUT:-}"
fi
if [ -z "$TOOL_INPUT" ]; then
  exit 0  # Parsed cleanly; this event carries no tool_input (not a write) — allow
fi

# Extract file path from tool input
FILE_PATH=$(printf '%s' "$TOOL_INPUT" | guard_json file_path) ||
  guard_no_verdict "tool_input is not readable JSON"
if [ -z "$FILE_PATH" ]; then
  exit 0  # Can't determine file path — allow
fi

# Only check files we care about (markdown, yaml, config)
case "$FILE_PATH" in
  *.md|*.yaml|*.yml|*.json|*.sh|*.py|*.ts|*.js)
    ;; # Continue checking
  *)
    exit 0  # Not a text file we check — allow
    ;;
esac

# Get the content being written. Covers Write (.content), Edit (.new_string), AND MultiEdit
# (.edits[].new_string) — the last was previously missed, so a MultiEdit could write a secret
# or admin-tier content straight past this gate (M1). Aggregate every new_string in the batch.
CONTENT=$(printf '%s' "$TOOL_INPUT" | guard_json content) ||
  guard_no_verdict "tool_input is not readable JSON"
if [ -z "$CONTENT" ]; then
  exit 0  # No content to check — allow (might be a read or other op)
fi

# ── Check 1: Secrets ────────────────────────────────────────────────
# Patterns are shared with validation/check-secrets.sh and scripts/aios.mjs
# via validation/secret-patterns.txt (single source — they must not drift).

PATTERNS_FILE="$HOOK_DIR/../validation/secret-patterns.txt"

SECRETS_PATTERNS=()
if [ -f "$PATTERNS_FILE" ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    SECRETS_PATTERNS+=("$line")
  done < "$PATTERNS_FILE"
else
  # Fallback if the shared file is missing (e.g. hook copied standalone). MUST mirror the full
  # set in validation/secret-patterns.txt — a partial list makes standalone mode a strictly
  # weaker gate (e.g. a github_pat_… token would pass here but be blocked in a normal checkout).
  SECRETS_PATTERNS=(
    "AKIA[0-9A-Z]{16}"
    "-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"
    "gh[ps]_[A-Za-z0-9_]{36,}"
    "xox[bporas]-[A-Za-z0-9-]+"
    "sk-[A-Za-z0-9_-]{40,}"
    "sk-ant-[A-Za-z0-9_-]{20,}"
    "aios_[A-Za-z0-9]+_[A-Za-z0-9]{24,}"
    "https?://[^/[:space:]:]+:[^@[:space:]]+@"
    "[Bb]earer [A-Za-z0-9_.=-]{30,}"
    "github_pat_[A-Za-z0-9_]{22,}"
    "AIza[0-9A-Za-z_-]{35}"
    "[sr]k_live_[A-Za-z0-9]{20,}"
    "npm_[A-Za-z0-9]{36}"
    "eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"
  )
fi

for pattern in "${SECRETS_PATTERNS[@]}"; do
  if echo "$CONTENT" | grep -qE -e "$pattern" 2>/dev/null; then
    echo "BLOCKED by team-ops-guard: Potential secret detected in $FILE_PATH" >&2
    echo "Pattern matched: $pattern" >&2
    echo "Remove the secret before writing this file." >&2
    exit 2
  fi
done

# ── Check 2: Access tag enforcement ────────────────────────────────

# Only enforce on outward/shared directories (new 4-shared; legacy variants)
if echo "$FILE_PATH" | grep -qE "(4-shared|04-shared|04-client-surface|06-client-surface|05-workspace)" 2>/dev/null; then
  # 2a. Explicit tier tag: a file the owner marked `access: admin` (or its `private`
  # alias — see docs/tier-vocabulary.md) must never be written into an outward/shared
  # directory, regardless of content patterns (AIO-600 C5 review finding — previously
  # only the pattern heuristics below caught admin content here).
  ACCESS_TAG=$(printf '%s\n' "$CONTENT" | awk '
    NR==1 { if ($0 !~ /^---[[:space:]]*$/) exit; next }
    /^---[[:space:]]*$/ { exit }
    /^[[:space:]]*access:/ {
      sub(/^[[:space:]]*access:[[:space:]]*/, "")
      gsub(/["'"'"'\r[:space:]]/, "")
      print tolower($0); exit
    }' 2>/dev/null || true)
  case "$ACCESS_TAG" in
    admin|private)
      echo "BLOCKED by team-ops-guard: access: ${ACCESS_TAG} content in team/client directory" >&2
      echo "File: $FILE_PATH" >&2
      echo "Admin-tier files (access: admin/private) cannot be written to workspace or client-surface directories." >&2
      exit 2
      ;;
  esac

  SENSITIVE_PATTERNS=(
    'day rate'
    'Day Rate'
    'EUR/day'
    'USD/day'
    'margin'
    'markup'
    'cost model'
    'sub rate'
    'subcontractor rate'
    'consultant rate'
    'client rate'
    'P&L'
    'psychological profile'
    'stakeholder psych'
    'negotiation strateg'
  )

  for pattern in "${SENSITIVE_PATTERNS[@]}"; do
    if echo "$CONTENT" | grep -qi "$pattern" 2>/dev/null; then
      echo "BLOCKED by team-ops-guard: Admin-only content detected in team/client directory" >&2
      echo "File: $FILE_PATH" >&2
      echo "Pattern: '$pattern'" >&2
      echo "Admin-tier content cannot be written to workspace or client-surface directories." >&2
      exit 2
    fi
  done
fi

# ── Check 3: Frontmatter required ──────────────────────────────────

# Only for markdown files in work/deliverables or shared (new + legacy)
if echo "$FILE_PATH" | grep -qE "(2-work|02-deliverables|4-shared|04-shared|04-client-surface|06-client-surface)" 2>/dev/null; then
  if echo "$FILE_PATH" | grep -qE "\.md$" 2>/dev/null; then
    # For Write tool, check if content starts with ---
    WRITE_CONTENT=$(printf '%s' "$TOOL_INPUT" | guard_json write_content) ||
      guard_no_verdict "tool_input is not readable JSON"
    if [ -n "$WRITE_CONTENT" ]; then
      # Pure-bash first-line check (same semantics as the previous
      # `echo | head -1 | grep -q "^---"`). This is the guard's only
      # INVERTED pipeline check — under `set -o pipefail`, a transient
      # pipeline failure (fork EAGAIN under load, SIGPIPE, grep error)
      # read as "no frontmatter" and spuriously blocked compliant writes
      # (one-off CI flake in approval-mode-governance.test.mjs). A case
      # match forks no processes, so it cannot fail transiently.
      case "$CONTENT" in
        ---*)
          : # frontmatter present — allowed
          ;;
        *)
          echo "BLOCKED by team-ops-guard: Markdown files in deliverables/client-surface require YAML frontmatter" >&2
          echo "File: $FILE_PATH" >&2
          echo "Add frontmatter with at least: status, owner" >&2
          exit 2
          ;;
      esac
    fi
  fi
fi

# All checks passed
exit 0
