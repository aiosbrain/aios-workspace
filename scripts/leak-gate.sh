#!/usr/bin/env bash
# leak-gate.sh — confidentiality leak gate for the AIOS workspace toolkit.
#
# Scans the tree for any confidential identifier that must never appear in this
# open-source repository: client/firm names, person names, venture/product
# codenames, and business-data patterns. A clean run returns ZERO matches.
#
# IMPORTANT (public-repo design): the confidential term set is NOT stored in this
# repo — that would itself enumerate the protected identifiers. Terms load from a
# local, untracked file so the open-source tree never carries them:
#   1. $AIOS_LEAK_TERMS_FILE                  (explicit path), else
#   2. ~/.config/aios-nda/leak-gate-terms.sh  (default local install), else
#   3. $AIOS_LEAK_TERMS_B64                    (base64 of the same file — for CI via a repo secret)
# The terms file is shell-sourceable and defines three vars: STRONG, WORDS, PATTERNS
# (each a grep -E alternation). See leak-gate-terms.example.sh for the format.
#
# If no term set is configured, the gate runs in NO-OP mode (prints a notice, exits 0):
# the standing protection is the local write-time PreToolUse hook + the pre-commit hook,
# which read the same term file. Set $AIOS_LEAK_TERMS_B64 as a CI secret to enforce in CI too.
#
# ── OUTPUT CONTAINMENT: the gate must not become the leak ────────────────────
# This gate used to print the matching `grep -n` lines. That wrote the very identifier it
# exists to contain into terminal scrollback AND — because scripts/build.mjs,
# scripts/promote.mjs and scripts/timeline.mjs each CAPTURE this script's stdout+stderr and
# re-emit it into findings / review context — into downstream artifacts, and into the CI job
# log whenever $AIOS_LEAK_TERMS_B64 is set. A CI log is usually readable by more people than
# the repository the gate is protecting.
#
# So this script NEVER writes source-derived matched text, matched line content, or a
# matching file's path to stdout or stderr. It reports only the category and aggregate
# count. grep output is discarded; only trusted filenames from the enumerated input set
# are written to a private temporary file for counting.
#
# Usage: scripts/leak-gate.sh [ROOT]   (defaults to repo root)
# Exit 0 = clean (or no term set configured); exit 1 = at least one forbidden term found;
# exit 2 = the scan could not complete safely. Any non-zero exit is the fail-closed boundary
# documented in SECURITY.md and relied on by build.mjs / promote.mjs / timeline.mjs.

set -euo pipefail

# Tracing is disabled BEFORE the term set is sourced, and stays off. `bash -x` (or an
# inherited SHELLOPTS/BASH_XTRACEFD) would otherwise echo `++ STRONG=<protected term>` as
# the terms file is sourced — turning the gate into the disclosure. This script is
# deliberately opaque at this boundary; inspect candidate inputs separately in a trusted
# local workflow when debugging a hit.
# The umask clamp also protects every private temporary file this gate creates.
set +x
umask 077

ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd)}"

# ── load the confidential term set (never hardcoded in this public repo) ─────
TERMS_FILE="${AIOS_LEAK_TERMS_FILE:-$HOME/.config/aios-nda/leak-gate-terms.sh}"
if [ -f "$TERMS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$TERMS_FILE"
elif [ -n "${AIOS_LEAK_TERMS_B64:-}" ]; then
  # shellcheck disable=SC1090
  . <(printf '%s' "$AIOS_LEAK_TERMS_B64" | base64 --decode)
else
  echo "leak-gate: no term set configured (set \$AIOS_LEAK_TERMS_FILE, install" \
       "~/.config/aios-nda/leak-gate-terms.sh, or set \$AIOS_LEAK_TERMS_B64 in CI)."
  echo "leak-gate: SKIPPED — local write-time + pre-commit hooks still enforce."
  exit 0
fi

# ── enumerate scan targets via GIT, never a filesystem walk (AIO-517) ───────
# A recursive grep descends into gitignored build trees (`src-tauri/target` is 1.6 GB /
# 35k files) and dies of resource exhaustion — a scanner that fails by NOT finishing is
# worse than one that finds nothing. Git's file list (tracked + untracked-but-not-ignored)
# is exactly the content that can ever be published, and it makes every ignored tree
# structurally invisible instead of relying on an ad-hoc exclude list that drifts.
# Non-git targets (a single file from `aios promote`, a throwaway render dir from
# `aios timeline`, the change-set dir from `aios build`) keep the walk — they hold only
# the material being gated, so there is no ignored tree to descend into.
#
# Exclusions still applied on top: VCS, this script, binaries, LICENSE (copyright holder),
# vendored upstream skills, and deliberately-malicious scanner test fixtures.
# skill-library/ — vendored, integrity-locked official upstream skills (OGR09).
# skill-scan-fixtures/ — DELIBERATELY-malicious scanner test inputs; never shipped.
# target/ — Rust/Tauri build output; gitignored. evidence/ — gitignored UX harness output.
# .env* — local-only config (gitignored).
# (docs/strategy/ was deleted from the repo entirely (PR #336) — nothing strategy-related is
#  excluded; the full docs tree is scanned like everything else.)
FILE_LIST=$(mktemp "${TMPDIR:-/tmp}/aios-leak-gate.XXXXXX")
MATCH_LIST=$(mktemp "${TMPDIR:-/tmp}/aios-leak-match.XXXXXX")
trap 'rm -f "$FILE_LIST" "$MATCH_LIST"' EXIT

# $1 = path relative to $ROOT. Emits the path to scan, NUL-terminated, when in scope.
emit_if_scannable() {
  case "/$1" in
    */.git/* | */node_modules/* | */.venv/* | */__pycache__/* | */store/*) return 0 ;;
    */skill-library/* | */skill-scan-fixtures/* | */target/* | */evidence/*) return 0 ;;
    */.git | */.env | */.env.local | */.env.keys) return 0 ;;
    */leak-gate.sh | */leak-gate-terms.sh | */LICENSE) return 0 ;;
    *.png | *.jpg | *.pdf | *.lock) return 0 ;;
  esac
  local abs="$ROOT/$1"
  [ -L "$abs" ] && return 0
  [ -f "$abs" ] || return 0
  printf '%s\0' "$abs"
}

if [ -d "$ROOT" ] && git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if ! {
    git -C "$ROOT" ls-files -z
    git -C "$ROOT" ls-files -z -o --exclude-standard
  } | while IFS= read -r -d '' rel; do
    emit_if_scannable "$rel"
  done > "$FILE_LIST"; then
    echo "leak-gate: ERROR — scan target enumeration failed; refusing to report clean." >&2
    exit 2
  fi
elif [ -d "$ROOT" ]; then
  if ! find "$ROOT" -not -path "*/.git/*" -not -path "*/node_modules/*" -type f -print0 2>/dev/null |
    while IFS= read -r -d '' abs; do
      emit_if_scannable "${abs#"$ROOT"/}"
    done > "$FILE_LIST"; then
    echo "leak-gate: ERROR — scan target enumeration failed; refusing to report clean." >&2
    exit 2
  fi
else
  # A single file (aios promote scans one copied deliverable).
  printf '%s\0' "$ROOT" > "$FILE_LIST"
fi

# Top-level path segments that are safe to name in output. An ALLOWLIST, not a denylist:
# a directory can itself be named after a protected client, so anything unrecognised is
# reported as "location withheld".
SAFE_SEGMENTS='0-context 1-inbox 2-work 3-log 4-shared 5-personal 6-business .claude .github docs examples gui hooks scaffold scripts src src-tauri test validation'

# $1 = absolute path of a matching file. Echoes an allowlisted top-level segment, or "".
sanitize_location() {
  local rel seg
  rel="${1#"$ROOT"/}"
  if [ "$rel" = "$1" ]; then return 0; fi   # ROOT is a single file: its name may be sensitive
  seg="${rel%%/*}"
  if [ "$seg" = "$rel" ]; then return 0; fi # file at the top level: no directory to name
  case "$seg" in ""|*[!A-Za-z0-9._-]*) return 0 ;; esac
  case " $SAFE_SEGMENTS " in *" $seg "*) printf '%s' "$seg" ;; esac
}

fail=0

# Accumulators for the current category, filled by tally_match.
_count=0
_locs=""

tally_match() { # $1 = absolute path of a matching file
  local loc
  _count=$((_count + 1))
  loc=$(sanitize_location "$1")
  if [ -n "$loc" ]; then
    case " $_locs " in *" $loc "*) ;; *) _locs="${_locs:+$_locs, }$loc" ;; esac
  fi
}

# Scan one file at a time so grep's three-state result remains observable:
#   0 = match, 1 = no match, >1 = invalid regex / unreadable input / scanner failure.
# `xargs grep || true` cannot preserve that distinction and previously turned a malformed
# configured regex into CLEAN. Match content is redirected away; only the trusted filename
# enters MATCH_LIST, NUL-terminated.
scan() { # $1 = extra grep flag(s) or "", $2 = pattern, $3 = human category label
  [ -s "$FILE_LIST" ] || return 0
  : > "$MATCH_LIST"
  local extra="$1" pattern="$2" f rc
  while IFS= read -r -d '' f; do
    rc=0
    if [ -n "$extra" ]; then
      grep -EI "$extra" -e "$pattern" -- "$f" >/dev/null 2>&1 || rc=$?
    else
      grep -EI -e "$pattern" -- "$f" >/dev/null 2>&1 || rc=$?
    fi
    case "$rc" in
      0) printf '%s\0' "$f" >> "$MATCH_LIST" ;;
      1) ;;
      *)
        echo "leak-gate: ERROR — scan could not complete; refusing to report clean." >&2
        exit 2
        ;;
    esac
  done < "$FILE_LIST"
  [ -s "$MATCH_LIST" ] || return 0
  fail=1

  _count=0
  _locs=""
  while IFS= read -r -d '' f; do tally_match "$f"; done < "$MATCH_LIST"

  local where="location withheld"
  [ -n "$_locs" ] && where="under: $_locs"
  printf '  %-52s %d file(s)  %s\n' "$3" "$_count" "$where"

}

if [ -n "${STRONG:-}" ]; then
  scan -i "$STRONG" "client/person/firm identifier (substring)"
fi
if [ -n "${WORDS:-}" ]; then
  scan -w "$WORDS" "client/person identifier (word)"
fi
if [ -n "${PATTERNS:-}" ]; then
  scan "" "$PATTERNS" "business-data pattern (ticket/CO/invoice/amount)"
fi

if [ "$fail" -eq 0 ]; then
  # $ROOT is deliberately NOT echoed: callers pass arbitrary paths (aios promote passes a
  # single deliverable, aios timeline a render dir) and a path can itself carry a protected
  # identifier. The literal "leak-gate: CLEAN" prefix is the asserted contract.
  echo "leak-gate: CLEAN — no forbidden identifiers found."
  exit 0
else
  echo "  matched source content and untrusted paths are withheld on purpose."
  echo "leak-gate: FAILED — forbidden identifiers above must be removed."
  exit 1
fi
