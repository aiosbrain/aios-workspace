#!/bin/sh
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
( cd "$GREPO"; git init -q -b main; git config user.email t@t; git config user.name t; \
  echo hi > a.txt; git add a.txt; git commit -qm init; \
  git worktree add -q "$GREPO-wt" -b feat/scope ) >/dev/null 2>&1
OTHER=$(mktemp -d)
( cd "$OTHER"; git init -q -b main; git config user.email t@t; git config user.name t; \
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

