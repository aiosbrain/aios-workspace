#!/bin/sh
# jq-preflight.sh — SOURCED, not executed. Defines harness_jq_available.
#
# WHY A MISSING INTERPRETER IS NOT A POLICY VIOLATION
# ---------------------------------------------------
# Every portable policy parses its event with jq, and each one answered a missing jq
# with exit 3 ("could not evaluate"), which the adapter maps to a native BLOCK. On
# Claude Code and Codex that is survivable — one tool call is refused and the session
# continues. On Cursor it is not: `failClosed: true` turns it into a deny for EVERY
# edit and shell call in the session, including `brew install jq`, so the deadlock
# cannot be cleared from inside the session that hit it.
#
# "A CLI is missing" and "this action violates policy" are different failures and must
# not share an outcome. A missing interpreter is environmental: it says nothing about
# the action, it is identical for every call, and there is a commit-time backstop
# (hooks/git/pre-commit-primary-guard) that does not depend on jq. So the harness says
# exactly what is wrong and how to fix it, then allows — loudly unenforced, never
# silently unenforced, and never bricked.
#
# HARNESS_REQUIRE_JQ=1 restores fail-closed for anyone who wants that trade (CI, or a
# machine where jq is guaranteed present and its absence should be treated as tamper).

# harness_jq_available — 0 when jq is usable; 1 after printing actionable guidance.
harness_jq_available() {
  command -v jq >/dev/null 2>&1 && return 0
  {
    echo "AIOS harness: 'jq' is not on PATH, so hook payloads cannot be parsed."
    echo "  Fix:  brew install jq          (macOS)"
    echo "        sudo apt-get install jq  (Debian/Ubuntu)"
    echo "  Until then the AIOS guards are NOT enforcing in this session."
    echo "  A missing interpreter is an environment failure, not a policy decision, so"
    echo "  this call is allowed rather than denying every tool call until you restart."
    echo "  Set HARNESS_REQUIRE_JQ=1 to fail closed on a missing interpreter instead."
  } >&2
  return 1
}

# harness_jq_missing_exit — the exit code to use once harness_jq_available said no.
# 3 (could-not-evaluate, mapped to a block) only when the operator asked for it.
harness_jq_missing_exit() {
  if [ "${HARNESS_REQUIRE_JQ:-0}" = "1" ]; then echo 3; else echo 0; fi
}
