#!/usr/bin/env bash
# evals/guards.test.sh — deterministic eval battery for the enforcement hooks.
#
# Every guard is exercised against synthetic blocked/allowed tool-call payloads.
# Run from the repo root:  bash evals/guards.test.sh
# Exit 0 = all pass. Exit 1 = failures (listed).
#
# This is the regression floor: any change to hooks/ must keep this green, and
# every guard bug found in the field gets a case added here (compound-learnings).
#
# Note: secret-like fixtures are ASSEMBLED AT RUNTIME (string concatenation) so
# this file never contains a literal secret-shaped string — otherwise secret
# scanners (including our own guard-secrets.sh) rightly refuse to write it.

# shellcheck disable=SC1091  # cases/*.sh are sourced via a runtime-resolved path
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
H="$ROOT/hooks"
PASS=0; FAIL=0
. "$(dirname "$0")/cases/payloads.sh"

# Runtime-assembled fixtures (never literal in this file)
AWS_KEY="AKIA""ABCDEFGHIJKLMNOP"
ANT_KEY="sk-""ant-api03-""aaaaaaaaaaaaaaaaaaaa""aaaaaaaaaaaaaaaaaaaa"
GH_PAT="ghp_""ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456"
PEM_HDR="-----BEGIN RSA ""PRIVATE KEY-----"
DB_URL="postgres""://admin:hunter2@db.internal/prod"
JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"".""eyJzdWIiOiIxMjM0NTY3ODkwIn0"".""dozjgNryP4J3jVmNHl0w5N3XgL0n3I9PlFUP0THsR8U"

# Fixtures are throwaway repos, so none is the repo this harness guards; without
# HARNESS_GUARDED_ROOT every block-expecting case would pass asserting nothing (see
# cases/cross-repo-scope.sh). The payload cwd is the repo under test.
guarded_root_of() { printf '%s' "$1" | jq -r '.cwd // .tool_input.cwd // empty' 2>/dev/null; }

t() { # name expected_exit hook json [guarded_root — when the TARGET repo is not the cwd]
  local name="$1" want="$2" hook="$3" json="$4" root="${5:-}"
  local got
  [ -n "$root" ] || root="$(guarded_root_of "$json")"
  printf '%s' "$json" | HARNESS_GUARDED_ROOT="$root" bash "$hook" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS ($got): $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"
  fi
}

tc() { # name expected_exit event policy json -- Codex native adapter
  local name="$1" want="$2" event="$3" policy="$4" json="$5"
  local got
  printf '%s' "$json" | HARNESS_GUARDED_ROOT="$(guarded_root_of "$json")" "$ROOT/adapters/run-hook.sh" codex "$event" "$policy" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS ($got): $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"
  fi
}

echo "── guard-secrets ──────────────────────────────────────────"
t "blocks AWS access key"        2 "$H/guard-secrets.sh" "$(wjson config.md "key = $AWS_KEY")"
t "blocks Anthropic API key"     2 "$H/guard-secrets.sh" "$(wjson x.ts "const k = \"$ANT_KEY\"")"
t "blocks GitHub PAT"            2 "$H/guard-secrets.sh" "$(wjson ci.md "$GH_PAT")"
t "blocks private key block"     2 "$H/guard-secrets.sh" "$(wjson k.md "$PEM_HDR")"
t "blocks db url with password"  2 "$H/guard-secrets.sh" "$(wjson a.yml "url: $DB_URL")"
t "blocks JWT-looking token"     2 "$H/guard-secrets.sh" "$(wjson t.md "$JWT")"
tc "blocks secret in Codex patch" 2 pre_edit guard-secrets.sh "$(pjson $'*** Begin Patch\n*** Add File: config.md\n+key = '"$AWS_KEY"$'\n*** End Patch')"
tc "allows removing secret in Codex patch" 0 pre_edit guard-secrets.sh "$(pjson $'*** Begin Patch\n*** Update File: config.md\n@@\n-key = '"$AWS_KEY"$'\n+key = $API_KEY\n*** End Patch')"
t "allows clean content"         0 "$H/guard-secrets.sh" "$(wjson readme.md 'just docs, use $API_KEY from env')"
t "allows empty input"           0 "$H/guard-secrets.sh" '{}'

echo "── guard-protected-paths ──────────────────────────────────"
t "blocks .env"                   2 "$H/guard-protected-paths.sh" "$(wjson .env 'X=1')"
t "blocks nested .env.production" 2 "$H/guard-protected-paths.sh" "$(wjson app/.env.production 'X=1')"
t "blocks package-lock.json"      2 "$H/guard-protected-paths.sh" "$(wjson package-lock.json '{}')"
t "blocks composer.lock"          2 "$H/guard-protected-paths.sh" "$(wjson composer.lock '{}')"
t "blocks migrations dir"         2 "$H/guard-protected-paths.sh" "$(wjson db/migrations/001_init.sql 'ALTER')"
t "blocks vendored code"          2 "$H/guard-protected-paths.sh" "$(wjson vendor/pkg/x.php '<?php')"
tc "blocks Codex patch to .env" 2 pre_edit guard-protected-paths.sh "$(pjson $'*** Begin Patch\n*** Update File: app/.env.production\n@@\n-X=1\n+X=2\n*** End Patch')"
tc "blocks Codex rename to lockfile" 2 pre_edit guard-protected-paths.sh "$(pjson $'*** Begin Patch\n*** Update File: package.json\n*** Move to: package-lock.json\n@@\n-{}\n+{}\n*** End Patch')"
tc "allows normal Codex patch" 0 pre_edit guard-protected-paths.sh "$(pjson $'*** Begin Patch\n*** Add File: src/clean.ts\n+export const clean = true\n*** End Patch')"
t "allows env-helper source"      0 "$H/guard-protected-paths.sh" "$(wjson src/env-helper.ts 'export const x=1')"
t "allows normal markdown"        0 "$H/guard-protected-paths.sh" "$(wjson docs/notes.md 'hi')"

echo "── guard-destructive ──────────────────────────────────────"
t "blocks rm -rf / (with args)"  2 "$H/guard-destructive.sh" "$(bjson 'rm -rf / --no-preserve-root')"
t "blocks rm -rf / (bare)"       2 "$H/guard-destructive.sh" "$(bjson 'rm -rf /')"
t "blocks rm -rf -- /"            2 "$H/guard-destructive.sh" "$(bjson 'rm -rf -- /')"
t "blocks rm -rf absolute path"  2 "$H/guard-destructive.sh" "$(bjson 'rm -rf /tmp/x')"
t "blocks rm -rf ~"              2 "$H/guard-destructive.sh" "$(bjson 'rm -rf ~/Projects')"
t "blocks rm -rf .."             2 "$H/guard-destructive.sh" "$(bjson 'rm -rf ../other-repo')"
t "allows rm -rf ./build"        0 "$H/guard-destructive.sh" "$(bjson 'rm -rf ./build')"
t "allows rm -rf dist"           0 "$H/guard-destructive.sh" "$(bjson 'rm -rf dist node_modules')"
t "blocks force-push main"       2 "$H/guard-destructive.sh" "$(bjson 'git push --force origin main')"
t "blocks -f push to master"     2 "$H/guard-destructive.sh" "$(bjson 'git push -f origin master')"
t "blocks branchless force-push" 2 "$H/guard-destructive.sh" "$(bjson 'git push --force')"
t "blocks remote-only -f push"   2 "$H/guard-destructive.sh" "$(bjson 'git push -f origin')"
t "blocks force-push feature"    2 "$H/guard-destructive.sh" "$(bjson 'git push --force origin feat/x')"
t "allows force-with-lease feat" 0 "$H/guard-destructive.sh" "$(bjson 'git push --force-with-lease origin feat/x')"
t "blocks hard reset main"       2 "$H/guard-destructive.sh" "$(bjson 'git reset --hard origin/main')"
t "blocks branch -D master"      2 "$H/guard-destructive.sh" "$(bjson 'git branch -D master')"
t "blocks filter-branch"         2 "$H/guard-destructive.sh" "$(bjson 'git filter-branch --tree-filter x HEAD')"
t "blocks mkfs"                  2 "$H/guard-destructive.sh" "$(bjson 'mkfs.ext4 /dev/sda1')"
t "blocks dd to device"          2 "$H/guard-destructive.sh" "$(bjson 'dd if=img.iso of=/dev/disk2')"
t "blocks DROP TABLE via psql"   2 "$H/guard-destructive.sh" "$(bjson 'echo "DROP TABLE users;" | psql prod')"
t "allows normal git"            0 "$H/guard-destructive.sh" "$(bjson 'git status && git diff')"
t "allows grepping for SQL"      0 "$H/guard-destructive.sh" "$(bjson 'grep -r "DROP TABLE" ./migrations')"

echo "── escape hatch ───────────────────────────────────────────"
printf '%s' "$(bjson 'git push --force origin main')" | HARNESS_ALLOW_DESTRUCTIVE=1 bash "$H/guard-destructive.sh" >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS (0): HARNESS_ALLOW_DESTRUCTIVE=1 bypasses"; else FAIL=$((FAIL+1)); echo "FAIL: escape hatch broken"; fi

echo "── guard-worktree ─────────────────────────────────────────"
WT=$(mktemp -d)
( cd "$WT"; git init -q -b main; git config user.email t@t; git config user.name t; \
  echo hi > a.txt; git add a.txt; git commit -qm init; \
  git worktree add -q -b feat/x "$WT/wt" main ) >/dev/null 2>&1
tcommit_strict() { # name expected_exit json — strict commit policy
  local name="$1" want="$2" json="$3" got
  printf '%s' "$json" | HARNESS_PRIMARY_COMMIT_POLICY=strict HARNESS_GUARDED_ROOT="$(guarded_root_of "$json")" bash "$H/guard-worktree.sh" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "PASS ($got): $name"; else FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"; fi
}
t "blocks checkout -b in primary"     2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -b feat/y')"
t "blocks switch -c in primary"       2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git switch -c feat/z')"
t "blocks git branch <new> in primary" 2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch newb')"
t "allows git branch --all (read)"    0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch --all')"
t "allows commit on main in primary"  0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git commit -m x')"
printf '%s' "$(wpc "$WT" 'git commit -m x')" | HARNESS_PRIMARY_COMMIT_POLICY=strict HARNESS_GUARDED_ROOT="$WT" bash "$H/guard-worktree.sh" >/dev/null 2>&1
if [ $? = 2 ]; then PASS=$((PASS+1)); echo "PASS (2): strict policy blocks main commit (agent hook)"; else FAIL=$((FAIL+1)); echo "FAIL: strict agent-hook should block main commit"; fi
t "allows commit inside worktree"     0 "$H/guard-worktree.sh" "$(wpc "$WT/wt" 'git commit -m x')"
# AIO-637: command-local overrides are honored in direct and env-prefixed
# forms, but apply to exactly one compound-command segment.
t "allows direct command-local primary override" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT" 'HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git checkout -b feat/override')"
t "allows env-prefixed command-local primary override" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT" 'env HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git checkout -b feat/override')"
t "direct override does not leak across compound command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT" 'HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git status && git checkout -b feat/not-overridden')"
t "env override does not leak across compound command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT" 'env HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git status; git checkout -b feat/not-overridden')"
t "later overridden segment is independently allowed" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT" 'git status && HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git checkout -b feat/override')"
t "compound git targets are classified independently" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "git -C $WT/wt status && git -C $WT checkout -b feat/blocked")"
t "semicolon cd state carries into branch command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "cd $WT; git checkout -b feat/blocked")"
t "newline cd state carries into branch command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" $'cd '"$WT"$'\ngit checkout -b feat/blocked')"
t "chained cd state reaches primary branch command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "cd $WT/wt && cd $WT && git checkout -b feat/blocked")"
t "reverse chained cd reaches worktree branch command" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT" "cd $WT && cd $WT/wt && git checkout -b feat/allowed")"
t "assignment-prefixed cd state carries" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "FLAG=1 cd $WT; git checkout -b feat/blocked")"
t "env-prefixed cd state carries conservatively" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "env FLAG=1 cd $WT; git checkout -b feat/blocked")"
t "command-prefixed cd state carries" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "command cd $WT; git checkout -b feat/blocked")"
t "brace-group cd state carries to parent shell" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "{ cd $WT; }; git checkout -b feat/blocked")"
t "redirected cd state carries to parent shell" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "cd $WT >/tmp/cd.log; git checkout -b feat/blocked")"
t "builtin cd state carries to parent shell" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "builtin cd $WT; git checkout -b feat/blocked")"
t "command -- cd state carries to parent shell" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "command -- cd $WT; git checkout -b feat/blocked")"
t "comment after cd does not hide cwd transition" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" $'cd '"$WT"$' # enter primary\ngit checkout -b feat/blocked')"
t "if-group cd state carries to parent shell" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "if true; then cd $WT; fi; git checkout -b feat/blocked")"
# AIO-637 F2: a cd in an if/while CONDITION changes the parent shell cwd too
t "if-condition cd state carries into branch command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "if cd $WT; then git checkout -b feat/blocked; fi")"
t "while-condition cd state carries into branch command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "while cd $WT; do git checkout -b feat/blocked; done")"
t "if-condition cd to worktree keeps branch command safe" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT" "if cd $WT/wt; then git checkout -b feat/allowed; fi")"
# AIO-637 F3: a subshell-scoped cd applies inside the parens, never past them
t "subshell cd reaches primary branch command" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "(cd $WT && git checkout -b feat/blocked)")"
t "subshell cd does not persist into later branch command" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "(cd $WT && git status); git checkout -b feat/allowed")"
t "pipeline-local cd does not persist" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "cd $WT | cat; git checkout -b feat/allowed")"
t "background cd does not persist" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" "cd $WT & wait; git checkout -b feat/allowed")"
tcommit_strict "semicolon cd state carries into strict commit" 2 \
  "$(wpc "$WT/wt" "cd $WT; git commit -m blocked")"
t "direct override before heredoc does not leak after terminator" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" $'HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\ngit checkout -b harmless-data\nBODY\ngit -C '"$WT"$' checkout -b feat/blocked')"
t "env override before heredoc does not leak after terminator" 2 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" $'env HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\ngit checkout -b harmless-data\nBODY\ngit -C '"$WT"$' checkout -b feat/blocked')"
tcommit_strict "heredoc override does not leak into strict commit" 2 \
  "$(wpc "$WT/wt" $'HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\nharmless\nBODY\ngit -C '"$WT"$' commit -m blocked')"
# AIO-637 F1: the documented pre-commit escape hatch (CLAUDE.md §5) is honored
# by the agent hook under strict commit policy — direct and env-prefixed,
# segment-scoped, and commit-scoped (it never unlocks branch creation).
tcommit_strict "strict honors direct AIOS_ALLOW_PRIMARY_COMMIT override" 0 \
  "$(wpc "$WT" 'AIOS_ALLOW_PRIMARY_COMMIT=1 git commit -m hotfix')"
tcommit_strict "strict honors env-prefixed AIOS_ALLOW_PRIMARY_COMMIT override" 0 \
  "$(wpc "$WT" 'env AIOS_ALLOW_PRIMARY_COMMIT=1 git commit -m hotfix')"
tcommit_strict "strict still blocks primary commit without AIOS override" 2 \
  "$(wpc "$WT" 'git commit -m no-override')"
tcommit_strict "AIOS commit override does not leak across compound command" 2 \
  "$(wpc "$WT" 'AIOS_ALLOW_PRIMARY_COMMIT=1 git commit -m one && git commit -m two')"
tcommit_strict "AIOS commit override does not unlock branch creation" 2 \
  "$(wpc "$WT" 'AIOS_ALLOW_PRIMARY_COMMIT=1 git checkout -b feat/nope')"
# AIO-637 F7: HARNESS_ALLOW_PRIMARY_COMMIT (the git hook's primary name) too
tcommit_strict "strict honors direct HARNESS_ALLOW_PRIMARY_COMMIT override" 0 "$(wpc "$WT" 'HARNESS_ALLOW_PRIMARY_COMMIT=1 git commit -m hotfix')"
tcommit_strict "strict honors env-prefixed HARNESS_ALLOW_PRIMARY_COMMIT override" 0 "$(wpc "$WT" 'env HARNESS_ALLOW_PRIMARY_COMMIT=1 git commit -m hotfix')"
tcommit_strict "HARNESS commit override does not unlock branch creation" 2 "$(wpc "$WT" 'HARNESS_ALLOW_PRIMARY_COMMIT=1 git checkout -b feat/nope')"
t "branch-like heredoc body is inert" 0 "$H/guard-worktree.sh" \
  "$(wpc "$WT/wt" $'cat <<\'BODY\'\ngit -C '"$WT"$' checkout -b harmless-data\nBODY\ngit status')"
t "allows edit on main in primary"    0 "$H/guard-worktree.sh" "$(wpe "$WT" "$WT/a.txt")"
printf '%s' "$(wpe "$WT" "$WT/a.txt")" | HARNESS_PRIMARY_EDIT_POLICY=strict HARNESS_GUARDED_ROOT="$WT" bash "$H/guard-worktree.sh" >/dev/null 2>&1
if [ $? = 2 ]; then PASS=$((PASS+1)); echo "PASS (2): strict policy blocks main edit (agent hook)"; else FAIL=$((FAIL+1)); echo "FAIL: strict agent-hook should block main edit"; fi
t "allows edit inside worktree"       0 "$H/guard-worktree.sh" "$(wpe "$WT/wt" "$WT/wt/a.txt")"
t "no-op outside a git repo"          0 "$H/guard-worktree.sh" "$(wpe /tmp /tmp/x.txt)"
# review round 4 (PR #431) — strict shell-write scan hardening
ts() { # name expected_exit json — strict edit policy
  local name="$1" want="$2" json="$3" got
  printf '%s' "$json" | HARNESS_PRIMARY_EDIT_POLICY=strict HARNESS_GUARDED_ROOT="$(guarded_root_of "$json")" bash "$H/guard-worktree.sh" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "PASS ($got): $name"; else FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"; fi
}
# a trailing redirect must not mask the cp/mv destination
ts "strict blocks cp dest hidden by redirect"  2 "$(wpc "$WT/wt" "cp /tmp/src $WT/b.txt >/tmp/cp431.log")"
ts "strict blocks mv dest hidden by redirect"  2 "$(wpc "$WT/wt" "mv /tmp/src $WT/b.txt 2>/dev/null")"
ts "strict allows cp outside primary w/ redirect" 0 "$(wpc "$WT/wt" 'cp /tmp/a /tmp/b >/tmp/cp431.log')"
# a not-yet-existing multi-level path inside the primary is still classified by it
ts "strict blocks mkdir -p new deep primary path" 2 "$(wpc "$WT/wt" "mkdir -p $WT/new1/new2")"
ts "strict blocks redirect into new deep primary path" 2 "$(wpc "$WT/wt" "echo x > $WT/new1/new2/f.txt")"
ts "strict allows mkdir -p deep path outside repos" 0 "$(wpc "$WT/wt" 'mkdir -p /tmp/guards431/new1/new2')"
# AIO-637: package-manager `install` is not the filesystem `install` utility.
ts "strict allows npm install in primary" 0 "$(wpc "$WT" 'npm install')"
ts "strict allows pnpm install in primary" 0 "$(wpc "$WT" 'pnpm install')"
ts "strict allows yarn install in primary" 0 "$(wpc "$WT" 'yarn install')"
ts "strict allows bun install in primary" 0 "$(wpc "$WT" 'bun install')"
ts "strict still blocks write after package manager segment" 2 \
  "$(wpc "$WT/wt" "npm install && echo x > $WT/package-write")"
ts "strict still blocks tee after package manager segment" 2 \
  "$(wpc "$WT/wt" "pnpm install; echo x | tee $WT/package-write")"
ts "strict semicolon cd state carries into redirect" 2 \
  "$(wpc "$WT/wt" "cd $WT; echo x > primary-write")"
ts "strict newline cd state carries into copy" 2 \
  "$(wpc "$WT/wt" $'cd '"$WT"$'\ncp /tmp/source primary-copy')"
ts "strict chained cd state reaches primary copy" 2 \
  "$(wpc "$WT/wt" "cd $WT/wt && cd $WT && cp /tmp/source primary-copy")"
ts "strict reverse chained cd reaches worktree copy" 0 \
  "$(wpc "$WT" "cd $WT && cd $WT/wt && cp /tmp/source worktree-copy")"
ts "strict assignment-prefixed cd reaches primary write" 2 \
  "$(wpc "$WT/wt" "FLAG=1 cd $WT; echo x > primary-write")"
ts "strict command-prefixed cd reaches primary move" 2 \
  "$(wpc "$WT/wt" "command cd $WT; mv /tmp/source primary-move")"
ts "strict brace-group cd reaches primary tee" 2 \
  "$(wpc "$WT/wt" "{ cd $WT; }; echo x | tee primary-tee")"
ts "strict redirected cd reaches primary write" 2 \
  "$(wpc "$WT/wt" "cd $WT >/tmp/cd.log; echo x > primary-write")"
ts "strict builtin cd reaches primary copy" 2 \
  "$(wpc "$WT/wt" "builtin cd $WT; cp /tmp/source primary-copy")"
ts "strict command -- cd reaches primary move" 2 \
  "$(wpc "$WT/wt" "command -- cd $WT; mv /tmp/source primary-move")"
ts "strict comment after cd does not hide cwd transition" 2 \
  "$(wpc "$WT/wt" $'cd '"$WT"$' # enter primary\necho x > primary-write')"
ts "strict if-group cd reaches primary tee" 2 \
  "$(wpc "$WT/wt" "if true; then cd $WT; fi; echo x | tee primary-tee")"
# AIO-637 F2: cd in a compound-command CONDITION is tracked
ts "strict if-condition cd reaches primary write" 2 \
  "$(wpc "$WT/wt" "if cd $WT; then echo x > primary-write; fi")"
ts "strict while-condition cd reaches primary write" 2 \
  "$(wpc "$WT/wt" "while cd $WT; do echo x > primary-write; done")"
ts "strict until-condition cd reaches primary write" 2 \
  "$(wpc "$WT/wt" "until cd $WT; do echo x > primary-write; done")"
ts "strict elif-condition cd reaches primary write" 2 \
  "$(wpc "$WT/wt" "if false; then :; elif cd $WT; then echo x > primary-write; fi")"
ts "strict if-condition cd to worktree keeps write safe" 0 \
  "$(wpc "$WT" "if cd $WT/wt; then echo x > worktree-write; fi")"
# AIO-637 F3: subshell cd is scoped to the parenthesized group
ts "strict subshell cd reaches primary write" 2 \
  "$(wpc "$WT/wt" "(cd $WT && echo x > f)")"
ts "strict subshell cd to worktree keeps write safe" 0 \
  "$(wpc "$WT" "(cd $WT/wt && echo x > f)")"
ts "strict subshell cd does not leak past the closing paren" 0 \
  "$(wpc "$WT/wt" "(cd $WT && ls); echo x > local.txt")"
ts "strict subshell close restores tracked parent cwd" 2 \
  "$(wpc "$WT/wt" "cd $WT; (cd /tmp && ls); echo x > primary-write")"
# AIO-637 F6: a `)` closing a mid-word $(…) is data — a command-substitution
# argument must not split the primary destination away from its command.
ts "strict blocks cp with cmd-subst arg into primary" 2 "$(wpc "$WT/wt" "cp \$(cat list) $WT/dst")"
ts "strict blocks tee with cmd-subst arg into primary" 2 "$(wpc "$WT/wt" "echo y | tee \$(cat list) $WT/f")"
ts "strict blocks mv with cmd-subst arg into primary" 2 "$(wpc "$WT/wt" "mv \$(ls x) $WT/dst")"
ts "strict blocks cmd-subst arg inside subshell into primary" 2 "$(wpc "$WT/wt" "(cp \$(cat list) $WT/dst2)")"
ts "strict allows cp with cmd-subst arg outside primary" 0 "$(wpc "$WT/wt" "cp \$(cat list) /tmp/dst637")"
ts "strict case pattern stays inert for safe write" 0 "$(wpc "$WT/wt" "case x in a) echo hi;; esac; echo x > local.txt")"
ts "strict case pattern does not hide a primary write" 2 "$(wpc "$WT/wt" "case x in a) echo hi;; esac; echo x > $WT/case-write")"
ts "strict pipeline-local cd does not persist into copy" 0 \
  "$(wpc "$WT/wt" "cd $WT | cat; cp /tmp/source worktree-copy")"
ts "strict pipeline-local cd does not affect peer redirect" 0 \
  "$(wpc "$WT/wt" "cd $WT | echo x > worktree-write")"
ts "strict background cd does not persist into copy" 0 \
  "$(wpc "$WT/wt" "cd $WT & wait; cp /tmp/source worktree-copy")"
ts "strict semicolon cd state carries into tee" 2 \
  "$(wpc "$WT/wt" "cd $WT; echo x | tee primary-tee")"
ts "strict semicolon cd state carries into move" 2 \
  "$(wpc "$WT/wt" "cd $WT; mv /tmp/source primary-move")"
ts "strict direct override before heredoc does not leak into write" 2 \
  "$(wpc "$WT/wt" $'HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\necho x > harmless-data\nBODY\necho x > '"$WT"$'/primary-write')"
ts "strict env override before heredoc does not leak into write" 2 \
  "$(wpc "$WT/wt" $'env HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\necho x > harmless-data\nBODY\necho x > '"$WT"$'/primary-write')"
ts "strict heredoc override does not leak into tee" 2 \
  "$(wpc "$WT/wt" $'HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\nharmless\nBODY\necho x | tee '"$WT"$'/primary-tee')"
ts "strict heredoc override does not leak into copy" 2 \
  "$(wpc "$WT/wt" $'HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\nharmless\nBODY\ncp /tmp/source '"$WT"$'/primary-copy')"
ts "strict heredoc override does not leak into move" 2 \
  "$(wpc "$WT/wt" $'env HARNESS_ALLOW_PRIMARY_CHECKOUT=1 cat <<\'BODY\'\nharmless\nBODY\nmv /tmp/source '"$WT"$'/primary-move')"
ts "strict redirect-like heredoc body is inert" 0 \
  "$(wpc "$WT/wt" $'cat <<\'BODY\'\necho x > '"$WT"$'/harmless-data\nBODY\necho done')"
ts "strict allows greater-than text in a heredoc from a worktree" 0 \
  "$(wpc "$WT/wt" $'git commit -F - <<\'MSG\'\n531 lines > ../a.txt\nMSG')"
ts "strict closes tab-stripping heredoc before a real redirect" 2 \
  "$(wpc "$WT/wt" $'cat <<-MSG\n\tbody > harmless\n\tMSG\necho x > '"$WT"$'/primary-file')"
ts "strict allows greater-than operators in a single-quoted node program" 0 \
  "$(wpc "$WT/wt" "node -e 'const pick = (x) => x > ../a.txt'")"
ts "strict allows greater-than text and a backtick path in a double-quoted PR body" 0 \
  "$(wpc "$WT/wt" "gh pr create --body \"Use \`../a.txt\` when score > ../a.txt\"")"
ts "strict resolves a redirect against cwd, not an unrelated git -C target" 0 \
  "$(wpc "$WT/wt" "git -C $WT status && echo x > local.txt")"
ts "strict resolves a redirect against a leading cd target" 2 \
  "$(wpc "$WT/wt" "cd $WT && echo x > primary-file")"
ts "strict still blocks a genuine redirect into the primary" 2 \
  "$(wpc "$WT/wt" "echo x > $WT/primary-file")"
# pre_edit: multi-level new path in the primary must not fall back to session cwd
ts "strict blocks edit at new deep primary path" 2 "$(wpe "$WT/wt" "$WT/newdir/sub/new.txt")"
# archive extraction into the primary is a shell write (tar -C / old-style xf / unzip -d)
ts "strict blocks tar -C extract into primary"   2 "$(wpc "$WT/wt" "tar -C $WT -xf /tmp/a431.tar")"
ts "strict blocks old-style tar xf into primary" 2 "$(wpc "$WT/wt" "tar xf /tmp/a431.tar -C $WT")"
ts "strict blocks unzip -d into primary"         2 "$(wpc "$WT/wt" "unzip /tmp/a431.zip -d $WT")"
ts "strict blocks unzip attached -d into primary" 2 "$(wpc "$WT/wt" "unzip /tmp/a431.zip -d$WT")"
ts "strict allows tar CREATE reading from primary" 0 "$(wpc "$WT/wt" "tar -cf /tmp/b431.tar -C $WT a.txt")"
ts "strict allows tar extract outside primary"   0 "$(wpc "$WT/wt" 'tar -C /tmp -xf /tmp/a431.tar')"

. "$(dirname "$0")/cases/aio-864-token-shatter.sh"
# a move DESTINATION into the primary is a write into it (.to on normalized events)
ts "strict blocks move .to destination in primary" 2 "$(jq -cn --arg cwd "$WT/wt" --arg p /tmp/x431.txt --arg to "$WT/moved431.txt" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,paths:[{path:$p,action:"update",to:$to}],added_content:[]}')"
# cursor adapter maps Move/Rename destination keys into paths[]
_nm=$(printf '{"tool_name":"Move","tool_input":{"path":"/tmp/a431.md","destination":"/tmp/b431.md"},"cwd":"/tmp"}' | "$ROOT/adapters/cursor/normalize.sh" pre_edit | jq -r '[.paths[].path] | sort | join(",")')
if [ "$_nm" = "/tmp/a431.md,/tmp/b431.md" ]; then PASS=$((PASS+1)); echo "PASS: cursor normalize maps move destination into paths"; else FAIL=$((FAIL+1)); echo "FAIL: cursor normalize missed move destination (got '$_nm')"; fi
tc "codex adapter blocks checkout -b" 2 pre_command guard-worktree.sh "$(jq -cn --arg cwd "$WT" '{tool_name:"Bash",tool_input:{command:"git checkout -b feat/adapter"},cwd:$cwd}')"
# review finding 2 — -B / -C / --create / branch -m
t "blocks checkout -B in primary"     2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -B feat/y')"
t "blocks switch -C in primary"       2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git switch -C feat/y')"
t "blocks switch --create in primary" 2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git switch --create feat/y')"
t "blocks git branch -m in primary"   2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch -m old new')"
# review finding 3 — global git options (git -C) don't defeat the pattern
t "blocks git -C <primary> checkout -b" 2 "$H/guard-worktree.sh" "$(wpc "$WT" "git -C $WT checkout -b feat/y")"
# review finding 4 — classified by command target, not session cwd
t "allows cd <worktree> && checkout -b" 0 "$H/guard-worktree.sh" "$(wpc "$WT" "cd $WT/wt && git checkout -b feat/stacked")"
t "allows git -C <worktree> checkout -b" 0 "$H/guard-worktree.sh" "$(wpc "$WT" "git -C $WT/wt checkout -b feat/stacked")"
t "blocks cd <primary> && checkout -b from wt" 2 "$H/guard-worktree.sh" "$(wpc "$WT/wt" "cd $WT && git checkout -b feat/q")"
# review round 2, finding 2b — create flag after other options (e.g. -q)
t "blocks checkout -q -b in primary"  2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -q -b feat/y')"
t "blocks switch -q -c in primary"    2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git switch -q -c feat/y')"
t "allows checkout -q -- file"        0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -q -- a.txt')"
t "allows branch -d (delete not create)" 0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch -d old')"
# review round 3, finding 1 — read-only branch listing that is piped/chained must NOT be blocked
t "allows git branch | grep (read)"   0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch | grep feat')"
t "allows git branch ; ls (read)"     0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch ; ls')"
t "allows git branch --format (read)" 0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch --format=%(refname)')"
t "allows git branch -D (force delete)" 0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch -D old')"
# review round 3, finding 2 — force/track branch creation is caught (only -m/-c were before)
t "blocks git branch -f <name>"       2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch -f other origin/main')"
t "blocks git branch -t <name>"       2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch -t track origin/main')"
t "blocks git branch --track <name>"  2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch --track track2 origin/main')"
# review round 3, finding 4 — pushd (like cd) resolves the command target; -C= equals form
t "blocks pushd <primary> && checkout -b from wt" 2 "$H/guard-worktree.sh" "$(wpc "$WT/wt" "pushd $WT && git checkout -b feat/p")"
t "allows pushd <worktree> && checkout -b"        0 "$H/guard-worktree.sh" "$(wpc "$WT" "pushd $WT/wt && git checkout -b feat/p")"
t "blocks git -C=<primary> checkout -b"           2 "$H/guard-worktree.sh" "$(wpc "$WT/wt" "git -C=$WT checkout -b feat/p")"
# adversarial round — attached create-flag argument (git accepts -bNAME) must block
t "blocks checkout -bNAME (attached)"  2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -bfeat/a')"
t "blocks checkout -b\"NAME\" (quoted attached)" 2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -b"feat/a"')"
t "blocks switch -cNAME (attached)"    2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git switch -cfeat/a')"
t "allows checkout -q -- file (attached-form false-positive guard)" 0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -q -- a.txt')"
# adversarial round — bare branch name butted against a shell separator must block
t "blocks git branch NAME; (butted separator)"  2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch newb;')"
t "blocks git branch NAME|cat (butted pipe)"    2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch newb|cat')"
# adversarial round — cd -- <dir> (POSIX end-of-options) resolves the target
t "blocks cd -- <primary> && checkout -b from wt" 2 "$H/guard-worktree.sh" "$(wpc "$WT/wt" "cd -- $WT && git checkout -b feat/p")"
t "allows cd -- <worktree> && checkout -b"        0 "$H/guard-worktree.sh" "$(wpc "$WT" "cd -- $WT/wt && git checkout -b feat/p")"
# review round 2, finding 1 — SECURITY: a tilde target must NOT be eval'd (no RCE)
RCE_MARK="$WT/.rce_marker"; rm -f "$RCE_MARK"
printf '%s' "$(wpc "$WT" "cd \"~/x\$(touch $RCE_MARK)\" && git status")" | bash "$H/guard-worktree.sh" >/dev/null 2>&1
if [ ! -e "$RCE_MARK" ]; then PASS=$((PASS+1)); echo "PASS: tilde target not eval'd (no RCE)"; else FAIL=$((FAIL+1)); echo "FAIL: RCE — guard executed a command substitution"; rm -f "$RCE_MARK"; fi
# review round 2, finding 3 — git -C "<path with spaces>" commit caught by the agent hook
SPW="$(mktemp -d)/my repo"; mkdir -p "$SPW"
( cd "$SPW"; git init -q -b main; git config user.email t@t; git config user.name t; echo hi > a.txt; git add a.txt; git commit -qm init; git checkout -q -b feat/s ) >/dev/null 2>&1
t "blocks git -C <spaced primary> commit" 2 "$H/guard-worktree.sh" "$(wpc "$WT" "git -C \"$SPW\" commit -m x")" "$SPW"
rm -rf "$(dirname "$SPW")"
git -C "$WT" checkout -q -b feat/stranded   # strand a feature branch in the primary checkout
t "blocks edit on feat in primary"    2 "$H/guard-worktree.sh" "$(wpe "$WT" "$WT/a.txt")"
t "allows exempt aios.yaml edit"      0 "$H/guard-worktree.sh" "$(wpe "$WT" "$WT/aios.yaml")"
t "blocks commit on feat in primary"  2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git commit -m x')"
t "blocks git -C <primary> commit on feat" 2 "$H/guard-worktree.sh" "$(wpc "$WT" "git -C $WT commit -m x")"
# review round 3, finding 3 + global-option class — leading git globals must not defeat commit detection
t "blocks git -c k='v v' commit on feat"   2 "$H/guard-worktree.sh" "$(wpc "$WT" "git -c core.pager='less -R' commit -m x")"
t "blocks git --no-pager commit on feat"   2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git --no-pager commit -m x')"
t "blocks git -p commit on feat"           2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git -p commit -m x')"
t "blocks git --exec-path=x commit on feat" 2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git --exec-path=/usr/x commit -m x')"
# review finding 7 — every edited path classified by its own repo (first=worktree, second=primary-feat)
t "multi-file worktree+primary-feat blocked" 2 "$H/guard-worktree.sh" "$(jq -cn --arg cwd "$WT" --arg a "$WT/wt/a.txt" --arg b "$WT/a.txt" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,paths:[{path:$a,action:"update"},{path:$b,action:"update"}],added_content:[]}')"
# review finding 8 — paths with spaces are read whole (no word-splitting)
mkdir -p "$WT/My Dir"; : > "$WT/My Dir/aios.yaml"; : > "$WT/My Dir/notes.md"
t "space path exempt allowed"         0 "$H/guard-worktree.sh" "$(wpe "$WT" "$WT/My Dir/aios.yaml")"
t "space path non-exempt blocked"     2 "$H/guard-worktree.sh" "$(wpe "$WT" "$WT/My Dir/notes.md")"
printf '%s' "$(wpe "$WT" "$WT/a.txt")" | HARNESS_ALLOW_PRIMARY_CHECKOUT=1 bash "$H/guard-worktree.sh" >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS (0): HARNESS_ALLOW_PRIMARY_CHECKOUT bypasses"; else FAIL=$((FAIL+1)); echo "FAIL: worktree escape hatch broken"; fi
# pre-commit git-hook backstop (commit-time)
bash "$ROOT/hooks/git/install-primary-commit-guard.sh" "$WT" >/dev/null 2>&1
( cd "$WT"; echo more >> a.txt; git add a.txt; git commit -qm feat ) >/dev/null 2>&1
if [ $? != 0 ]; then PASS=$((PASS+1)); echo "PASS: pre-commit guard blocks feature commit in primary"; else FAIL=$((FAIL+1)); echo "FAIL: pre-commit guard should block feature commit in primary"; fi
( cd "$WT"; HARNESS_ALLOW_PRIMARY_COMMIT=1 git commit -qm feat ) >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS: pre-commit guard override commits"; else FAIL=$((FAIL+1)); echo "FAIL: pre-commit guard override should commit"; fi
# strict policy: even a commit on the default branch is blocked in the primary
git -C "$WT" checkout -q main
( cd "$WT"; echo s >> a.txt; git add a.txt; HARNESS_PRIMARY_COMMIT_POLICY=strict git commit -qm strict-main ) >/dev/null 2>&1
if [ $? != 0 ]; then PASS=$((PASS+1)); echo "PASS: strict pre-commit blocks main commit in primary"; else FAIL=$((FAIL+1)); echo "FAIL: strict pre-commit should block main commit"; fi
( cd "$WT"; git commit -qm main-ok ) >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS: default-ok allows main commit in primary"; else FAIL=$((FAIL+1)); echo "FAIL: default-ok should allow main commit"; fi
# review finding 5 — strict blocks a non-ff merge commit via the pre-merge-commit hook
# (branch creation in the primary now needs the override, since the strand guard below is installed)
( cd "$WT"; HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git checkout -q -b side; echo z >> a.txt; git add a.txt; HARNESS_ALLOW_PRIMARY_COMMIT=1 git commit -qm side; HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git checkout -q main ) >/dev/null 2>&1
( cd "$WT"; HARNESS_PRIMARY_COMMIT_POLICY=strict git merge --no-ff -m merge side ) >/dev/null 2>&1
if [ $? != 0 ]; then PASS=$((PASS+1)); echo "PASS: strict pre-merge-commit blocks non-ff merge in primary"; else FAIL=$((FAIL+1)); echo "FAIL: strict should block non-ff merge in primary"; fi
git -C "$WT" merge --abort >/dev/null 2>&1 || true
# reference-transaction strand guard (branch-creation backstop, parse-free) — installed on $WT above
( cd "$WT"; git checkout -b feat/rtx ) >/dev/null 2>&1
if [ $? != 0 ]; then PASS=$((PASS+1)); echo "PASS: strand guard blocks checkout -b in primary"; else FAIL=$((FAIL+1)); echo "FAIL: strand guard should block checkout -b in primary"; git -C "$WT" checkout -q main 2>/dev/null; fi
( cd "$WT"; git switch -c feat/rtx2 ) >/dev/null 2>&1
if [ $? != 0 ]; then PASS=$((PASS+1)); echo "PASS: strand guard blocks switch -c in primary"; else FAIL=$((FAIL+1)); echo "FAIL: strand guard should block switch -c in primary"; git -C "$WT" checkout -q main 2>/dev/null; fi
# the group-2 bypass the agent hook can't catch: git -C <primary> behind a global option, from a worktree cwd
( cd "$WT/wt"; git -p -C "$WT" checkout -b feat/g2 ) >/dev/null 2>&1
if [ $? != 0 ]; then PASS=$((PASS+1)); echo "PASS: strand guard blocks git -p -C <primary> checkout -b (parse-free)"; else FAIL=$((FAIL+1)); echo "FAIL: strand guard should block the -C-after-global bypass"; git -C "$WT" checkout -q main 2>/dev/null; fi
( cd "$WT"; HARNESS_ALLOW_PRIMARY_CHECKOUT=1 git checkout -b feat/ovr ) >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS: strand guard override creates branch"; git -C "$WT" checkout -q main 2>/dev/null; else FAIL=$((FAIL+1)); echo "FAIL: strand guard override should allow"; fi
( cd "$WT"; git worktree add -b feat/wta "$WT-strandwt" main ) >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS: strand guard allows git worktree add -b"; else FAIL=$((FAIL+1)); echo "FAIL: strand guard should allow worktree add"; fi
git -C "$WT" worktree remove "$WT-strandwt" >/dev/null 2>&1; rm -rf "$WT-strandwt"
( cd "$WT/wt"; git checkout -b feat/inwt ) >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS: strand guard is a no-op inside a linked worktree"; else FAIL=$((FAIL+1)); echo "FAIL: strand guard should not fire inside a worktree"; fi
rm -rf "$WT"

# review finding 1 & 6 — master-default repo + detached HEAD
MREPO=$(mktemp -d)
( cd "$MREPO"; git init -q -b master; git config user.email t@t; git config user.name t; \
  echo hi > a.txt; git add a.txt; git commit -qm init ) >/dev/null 2>&1
t "master-default: commit on master ok" 0 "$H/guard-worktree.sh" "$(jq -cn --arg cwd "$MREPO" '{protocol_version:"1.0",event:"pre_command",runtime:{name:"mock"},cwd:$cwd,command:"git commit -m x"}')"
t "master-default: edit on master ok"   0 "$H/guard-worktree.sh" "$(jq -cn --arg cwd "$MREPO" --arg p "$MREPO/a.txt" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,paths:[{path:$p,action:"update"}],added_content:[]}')"
bash "$ROOT/hooks/git/install-primary-commit-guard.sh" "$MREPO" >/dev/null 2>&1
( cd "$MREPO"; echo m >> a.txt; git add a.txt; git commit -qm ok ) >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS: master-default commit allowed by git-hook"; else FAIL=$((FAIL+1)); echo "FAIL: master-default should be allowed by git-hook"; fi
git -C "$MREPO" checkout -q --detach >/dev/null 2>&1
t "detached HEAD: edit allowed"         0 "$H/guard-worktree.sh" "$(jq -cn --arg cwd "$MREPO" --arg p "$MREPO/a.txt" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,paths:[{path:$p,action:"update"}],added_content:[]}')"
rm -rf "$MREPO"

echo "── stop-verify-gate ───────────────────────────────────────"
TMP=$(mktemp -d)
pushd "$TMP" >/dev/null
git init -q
printf '{}' | bash "$H/stop-verify-gate.sh" >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS (0): gate off when unconfigured"; else FAIL=$((FAIL+1)); echo "FAIL: gate should be off when unconfigured"; fi
mkdir -p .harness && printf 'false\n' > .harness/check
printf '{}' | bash "$H/stop-verify-gate.sh" >/dev/null 2>&1
if [ $? = 2 ]; then PASS=$((PASS+1)); echo "PASS (2): blocks stop on failing check"; else FAIL=$((FAIL+1)); echo "FAIL: should block on failing check"; fi
mkdir -p nested
pushd nested >/dev/null
printf '{}' | bash "$H/stop-verify-gate.sh" >/dev/null 2>&1
if [ $? = 2 ]; then PASS=$((PASS+1)); echo "PASS (2): nested CWD finds root check"; else FAIL=$((FAIL+1)); echo "FAIL: nested CWD missed root check"; fi
popd >/dev/null
printf '{"stop_hook_active":true}' | bash "$H/stop-verify-gate.sh" >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS (0): loop protection allows second stop"; else FAIL=$((FAIL+1)); echo "FAIL: loop protection broken"; fi
printf 'true\n' > .harness/check
printf '{}' | bash "$H/stop-verify-gate.sh" >/dev/null 2>&1
if [ $? = 0 ]; then PASS=$((PASS+1)); echo "PASS (0): allows stop on green check"; else FAIL=$((FAIL+1)); echo "FAIL: should allow on green check"; fi
HARNESS_CHECK=false bash -c "printf '{}' | bash '$H/stop-verify-gate.sh'" >/dev/null 2>&1
if [ $? = 2 ]; then PASS=$((PASS+1)); echo "PASS (2): HARNESS_CHECK env respected"; else FAIL=$((FAIL+1)); echo "FAIL: HARNESS_CHECK env ignored"; fi
popd >/dev/null
rm -rf "$TMP"

echo "── post-edit-format ───────────────────────────────────────"
t "formatter no-ops on missing file" 0 "$H/post-edit-format.sh" "$(bjson x | jq -c '{tool_input:{file_path:"/nonexistent/x.ts"}}')"
tc "formatter accepts Codex patch" 0 post_edit post-edit-format.sh "$(pjson $'*** Begin Patch\n*** Update File: /nonexistent/x.ts\n@@\n-old\n+new\n*** End Patch')"
t "formatter no-ops on empty input"  0 "$H/post-edit-format.sh" '{}'

. "$(dirname "$0")/cases/cross-repo-scope.sh"

echo "────────────────────────────────────────────────────────────"
echo "guards.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
