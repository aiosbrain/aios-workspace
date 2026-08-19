#!/usr/bin/env bash
# Cross-repo scope cases for guard-worktree.sh. SOURCED by ../guards.test.sh (which owns
# PASS/FAIL, $H and the wpc/wpe payload builders) — kept in its own file only to stay under
# the repository file-size cap, not because it is a separate entry point. There is one eval
# entry point and it is guards.test.sh.
#
# What these pin: the guard polices exactly ONE repository — the one vendoring this harness.
# Before this, ANY primary checkout was policed, so a session anchored on the toolkit refused
# edits to a personal AIOS workspace, a sibling product repo, or an unrelated project.

echo "── cross-repo scope ───────────────────────────────────────"
# Regression cover for the leak where ANY primary checkout was policed. GREPO is the repo
# the guard protects; OTHER is somebody else's. Fresh fixtures on purpose: earlier ones are
# torn down by now, and a missing guarded root falls back to "police everything", which
# would invert every assertion below while still looking like a real result.
GREPO=$(mktemp -d)
( cd -- "$GREPO" || exit 1; git init -q -b main; git config user.email t@t; git config user.name t; \
  echo hi > a.txt; git add a.txt; git commit -qm init; \
  git worktree add -q "$GREPO-wt" -b feat/scope ) >/dev/null 2>&1
OTHER=$(mktemp -d)
( cd -- "$OTHER" || exit 1; git init -q -b main; git config user.email t@t; git config user.name t; \
  echo hi > a.txt; git add a.txt; git commit -qm init ) >/dev/null 2>&1

tscope() { # name expected_exit json [policy_env]
  local name="$1" want="$2" json="$3" pol="${4:-HARNESS_PRIMARY_EDIT_POLICY=strict}" got
  printf '%s' "$json" | env "$pol" HARNESS_GUARDED_ROOT="$GREPO" \
    bash "$H/guard-worktree.sh" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "PASS ($got): $name"
  else FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"; fi
}

tscope "edit in another repo is not policed"    0 "$(wpe "$OTHER" "$OTHER/a.txt")"
tscope "shell write to another repo not policed" 0 "$(wpc "$OTHER" "echo x > $OTHER/b.txt")"
tscope "git commit in another repo not policed"  0 "$(wpc "$OTHER" 'git commit -m x')" \
  HARNESS_PRIMARY_COMMIT_POLICY=strict
tscope "git checkout -b in another repo not policed" 0 "$(wpc "$OTHER" 'git checkout -b feat/x')" \
  HARNESS_PRIMARY_COMMIT_POLICY=strict
# …and the guarded repo itself is still policed, from the same invocation shape.
tscope "guarded primary edit still blocked"      2 "$(wpe "$GREPO" "$GREPO/a.txt")"
tscope "guarded primary commit still blocked"    2 "$(wpc "$GREPO" 'git commit -m x')" \
  HARNESS_PRIMARY_COMMIT_POLICY=strict
# A linked worktree of the guarded repo stays IN scope (same git common dir) and allowed.
tscope "worktree of the guarded repo allowed"    0 "$(wpc "$GREPO-wt" 'git commit -m x')" \
  HARNESS_PRIMARY_COMMIT_POLICY=strict
rm -rf "$OTHER" "$GREPO" "$GREPO-wt"

# The scope lib is load-bearing: a truncated one SOURCES cleanly but leaves
# same_repository undefined, and an undefined call returns non-zero, which every
# caller reads as "not our repo" — silently disabling the guard. Missing or
# incomplete must be exit 3 (block), never a quiet pass.
LIBSB=$(mktemp -d); mkdir -p "$LIBSB/.harness/hooks"
cp "$H/"*.sh "$LIBSB/.harness/hooks/" 2>/dev/null
LREPO="$LIBSB/repo"; mkdir -p "$LREPO"
git -C "$LREPO" init -q -b main
git -C "$LREPO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
tlib() { # name expected_exit
  local got
  printf '%s' "$(wpe "$LREPO" "$LREPO/a.txt")" | HARNESS_PRIMARY_EDIT_POLICY=strict \
    HARNESS_GUARDED_ROOT="$LREPO" bash "$LIBSB/.harness/hooks/guard-worktree.sh" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$2" ]; then PASS=$((PASS+1)); echo "PASS ($got): $1"
  else FAIL=$((FAIL+1)); echo "FAIL (got $got, want $2): $1"; fi
}
tlib "intact scope lib polices the guarded repo" 2
printf '#!/bin/sh\n' > "$LIBSB/.harness/hooks/repo-scope.sh"
tlib "truncated scope lib blocks, never passes"  3
rm -f "$LIBSB/.harness/hooks/repo-scope.sh"
tlib "missing scope lib blocks, never passes"    3
cp "$H/repo-scope.sh" "$LIBSB/.harness/hooks/repo-scope.sh"
# shell-parse.sh (the quote-aware command scanners, extracted from guard-worktree.sh)
# is held to the same rule: a truncated lib sources cleanly and leaves the scanners
# undefined, which would yield an EMPTY write-candidate list — enforcement dropped in
# silence. It must be exit 3, exactly like a truncated repo-scope.sh.
tlib "intact parse lib polices the guarded repo" 2
printf '#!/bin/sh\n' > "$LIBSB/.harness/hooks/shell-parse.sh"
tlib "truncated parse lib blocks, never passes"  3
rm -f "$LIBSB/.harness/hooks/shell-parse.sh"
tlib "missing parse lib blocks, never passes"    3
rm -rf "$LIBSB"

