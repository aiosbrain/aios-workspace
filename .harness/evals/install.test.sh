#!/usr/bin/env bash
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass() {
  PASS=$((PASS + 1))
  echo "PASS: $1"
}

fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1"
}

new_repo() {
  local repo="$1"
  mkdir -p "$repo/.harness"
  cp -R "$ROOT"/. "$repo/.harness/"
  rm -rf "$repo/.harness/.git"
  git -C "$repo" init -q
  git -C "$repo" config user.email test@example.invalid
  git -C "$repo" config user.name "Harness Test"
}

tree_digest() {
  local repo="$1"
  find "$repo" -type f -not -path '*/.git/index' -not -path '*/.git/logs/*' \
    -not -path '*/.git/COMMIT_EDITMSG' -print0 |
    sort -z |
    xargs -0 shasum
}

echo "clean all-runtime install + idempotent rerun"
CLEAN="$TMP/clean"
new_repo "$CLEAN"
if "$CLEAN/.harness/install.sh" --repo "$CLEAN" --all >/dev/null 2>&1 &&
   [ -f "$CLEAN/.claude/settings.json" ] &&
   [ -f "$CLEAN/.codex/hooks.json" ] &&
   [ -f "$CLEAN/opencode.json" ] &&
   [ -f "$CLEAN/.cursor/hooks.json" ] &&
   [ -f "$CLEAN/.harness/check" ] &&
   [ ! -e "$CLEAN/.harness/.harness/check" ] &&
   jq -e 'has("$comment") | not' "$CLEAN/.claude/settings.json" >/dev/null &&
   jq -e 'has("$comment") | not' "$CLEAN/.codex/hooks.json" >/dev/null &&
   jq -e 'has("$comment") | not' "$CLEAN/opencode.json" >/dev/null &&
   jq -e 'has("$comment") | not' "$CLEAN/.cursor/hooks.json" >/dev/null; then
  pass "all four runtime configs and target .harness/check are installed"
else
  fail "all-runtime clean install"
fi

if find "$CLEAN/.harness/hooks" "$CLEAN/.harness/adapters" -type f \
     \( -name '*.sh' -o -path '*/hooks/git/*' \) ! -perm -u+x | grep -q .; then
  fail "required harness scripts are executable"
else
  pass "required harness scripts are executable"
fi

BEFORE="$(tree_digest "$CLEAN")"
if "$CLEAN/.harness/install.sh" --repo "$CLEAN" --all >/dev/null 2>&1; then
  AFTER="$(tree_digest "$CLEAN")"
  if [ "$BEFORE" = "$AFTER" ] &&
     ! find "$CLEAN" -name '*.harness-incoming' -print -quit | grep -q .; then
    pass "clean rerun is a content no-op"
  else
    fail "clean rerun changed installed content"
  fi
else
  fail "clean rerun exited nonzero"
fi

echo "existing configs are preserved with non-destructive merge artifacts"
for SPEC in \
  "claude-code:.claude/settings.json" \
  "codex:.codex/hooks.json" \
  "opencode:opencode.json" \
  "cursor:.cursor/hooks.json"; do
  RT="${SPEC%%:*}"
  DST="${SPEC#*:}"
  REPO="$TMP/existing-$RT"
  new_repo "$REPO"
  mkdir -p "$(dirname "$REPO/$DST")"
  printf '{"userManaged":true}\n' > "$REPO/$DST"
  if "$REPO/.harness/install.sh" --repo "$REPO" --runtime "$RT" >/dev/null 2>&1 &&
     jq -e '.userManaged == true' "$REPO/$DST" >/dev/null &&
     [ -f "$REPO/$DST.harness-incoming" ] &&
     jq -e 'has("$comment") | not' "$REPO/$DST.harness-incoming" >/dev/null; then
    pass "$RT preserves config and writes a normalized merge artifact"
  else
    fail "$RT config preservation"
  fi
done

echo "pending merge work and invalid setup fail loudly"
COLLISION="$TMP/collision"
new_repo "$COLLISION"
mkdir -p "$COLLISION/.cursor"
printf '{"userManaged":true}\n' > "$COLLISION/.cursor/hooks.json"
printf 'do-not-overwrite\n' > "$COLLISION/.cursor/hooks.json.harness-incoming"
if "$COLLISION/.harness/install.sh" --repo "$COLLISION" --runtime cursor >/dev/null 2>&1; then
  fail "pre-existing merge artifact aborts installation"
elif [ "$(cat "$COLLISION/.cursor/hooks.json.harness-incoming")" = "do-not-overwrite" ] &&
     [ ! -e "$COLLISION/AGENTS.md" ]; then
  pass "pre-existing merge artifact is preserved and aborts before writes"
else
  fail "merge artifact collision mutated target state"
fi

UNKNOWN="$TMP/unknown"
new_repo "$UNKNOWN"
if "$UNKNOWN/.harness/install.sh" --repo "$UNKNOWN" --runtime typo >/dev/null 2>&1; then
  fail "unknown runtime exits nonzero"
elif [ ! -e "$UNKNOWN/AGENTS.md" ]; then
  pass "unknown runtime exits nonzero before writes"
else
  fail "unknown runtime wrote target files"
fi
if "$UNKNOWN/.harness/install.sh" --repo "$UNKNOWN" --runtime typo --all >/dev/null 2>&1; then
  fail "unknown runtime combined with --all exits nonzero"
else
  pass "unknown runtime cannot be hidden by --all"
fi

DUPLICATE="$TMP/duplicate"
new_repo "$DUPLICATE"
if "$DUPLICATE/.harness/install.sh" --repo "$DUPLICATE" \
     --runtime cursor --runtime cursor >/dev/null 2>&1 &&
   [ -f "$DUPLICATE/.cursor/hooks.json" ] &&
   [ ! -e "$DUPLICATE/.cursor/hooks.json.harness-incoming" ]; then
  pass "duplicate runtime arguments remain idempotent"
else
  fail "duplicate runtime arguments"
fi

NO_JQ="$TMP/no-jq"
new_repo "$NO_JQ"
mkdir -p "$TMP/empty-path"
ln -s "$(command -v dirname)" "$TMP/empty-path/dirname"
NO_JQ_OUT=$(PATH="$TMP/empty-path" /bin/bash "$NO_JQ/.harness/install.sh" --repo "$NO_JQ" --runtime cursor 2>&1)
NO_JQ_STATUS=$?
if [ "$NO_JQ_STATUS" -eq 0 ]; then
  fail "missing jq exits nonzero"
elif printf '%s' "$NO_JQ_OUT" | grep -q 'jq is required' &&
     [ ! -e "$NO_JQ/AGENTS.md" ]; then
  pass "missing jq exits nonzero before writes"
else
  printf '%s\n' "$NO_JQ_OUT"
  fail "missing jq did not produce the required fail-fast diagnostic"
fi

BAD_JSON="$TMP/bad-json"
new_repo "$BAD_JSON"
printf '{bad json\n' > "$BAD_JSON/.harness/adapters/cursor/hooks.json"
if "$BAD_JSON/.harness/install.sh" --repo "$BAD_JSON" --runtime cursor >/dev/null 2>&1; then
  fail "malformed template normalization exits nonzero"
elif [ ! -e "$BAD_JSON/.cursor/hooks.json" ]; then
  pass "malformed template is never installed as runtime configuration"
else
  fail "malformed template was copied into runtime configuration"
fi

SYMLINK_DIR="$TMP/symlink-dir"
new_repo "$SYMLINK_DIR"
mkdir -p "$TMP/outside-cursor"
ln -s "$TMP/outside-cursor" "$SYMLINK_DIR/.cursor"
if "$SYMLINK_DIR/.harness/install.sh" --repo "$SYMLINK_DIR" --runtime cursor >/dev/null 2>&1; then
  fail "symlinked runtime destination directory aborts installation"
elif [ ! -e "$SYMLINK_DIR/AGENTS.md" ] &&
     [ ! -e "$TMP/outside-cursor/hooks.json" ]; then
  pass "symlinked runtime destination is rejected before outside writes"
else
  fail "symlinked runtime destination escaped the repository"
fi

DANGLING="$TMP/dangling"
new_repo "$DANGLING"
ln -s "$TMP/outside-agents" "$DANGLING/AGENTS.md"
if "$DANGLING/.harness/install.sh" --repo "$DANGLING" --runtime cursor >/dev/null 2>&1 &&
   [ -L "$DANGLING/AGENTS.md" ] &&
   [ ! -e "$TMP/outside-agents" ]; then
  pass "dangling seed symlink is preserved without following it"
else
  fail "dangling seed symlink was followed or replaced"
fi

CHMOD_FAIL="$TMP/chmod-fail"
new_repo "$CHMOD_FAIL"
mkdir -p "$TMP/fail-bin"
printf '#!/bin/sh\nexit 42\n' > "$TMP/fail-bin/chmod"
chmod +x "$TMP/fail-bin/chmod"
if PATH="$TMP/fail-bin:$PATH" "$CHMOD_FAIL/.harness/install.sh" --repo "$CHMOD_FAIL" --runtime cursor >/dev/null 2>&1; then
  fail "chmod failure propagates"
else
  pass "chmod failure propagates"
fi

GUARD_FAIL="$TMP/guard-fail"
new_repo "$GUARD_FAIL"
touch "$GUARD_FAIL/not-a-directory"
git -C "$GUARD_FAIL" config core.hooksPath "$GUARD_FAIL/not-a-directory"
if "$GUARD_FAIL/.harness/install.sh" --repo "$GUARD_FAIL" --runtime cursor >/dev/null 2>&1; then
  fail "commit-guard installation failure propagates"
else
  pass "commit-guard installation failure propagates"
fi

echo "default invocation survives stock bash 3.2 (empty-array set -u)"
B32="$TMP/bash32"
new_repo "$B32"
# No --runtime/--all: WANT stays empty through validation, which crashed on
# macOS /bin/bash 3.2 ("WANT[@]: unbound variable"). Run under /bin/bash to cover it.
if [ -x /bin/bash ] &&
   /bin/bash "$B32/.harness/install.sh" --repo "$B32" >/dev/null 2>&1 &&
   [ -f "$B32/.claude/settings.json" ]; then
  pass "default (auto-detect) invocation succeeds under /bin/bash"
elif [ ! -x /bin/bash ]; then
  pass "default (auto-detect) invocation under /bin/bash skipped (no /bin/bash)"
else
  fail "default (auto-detect) invocation under /bin/bash"
fi

echo "locally edited skills survive re-install"
SKILL_EDIT="$TMP/skill-edit"
new_repo "$SKILL_EDIT"
if "$SKILL_EDIT/.harness/install.sh" --repo "$SKILL_EDIT" --runtime claude-code >/dev/null 2>&1; then
  EDITED="$SKILL_EDIT/.claude/skills/plan-first/SKILL.md"
  printf '\nLOCAL CUSTOMIZATION\n' >> "$EDITED"
  if "$SKILL_EDIT/.harness/install.sh" --repo "$SKILL_EDIT" --runtime claude-code >/dev/null 2>&1 &&
     grep -q "LOCAL CUSTOMIZATION" "$EDITED" &&
     [ -f "$EDITED.harness-incoming" ] &&
     ! grep -q "LOCAL CUSTOMIZATION" "$EDITED.harness-incoming"; then
    pass "edited skill is kept; pristine copy lands in .harness-incoming"
  else
    fail "edited skill was overwritten or no merge artifact was written"
  fi
else
  fail "claude-code install for skill-edit case"
fi

echo "install.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
