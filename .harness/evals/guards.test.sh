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

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
H="$ROOT/hooks"
PASS=0; FAIL=0

# Runtime-assembled fixtures (never literal in this file)
AWS_KEY="AKIA""ABCDEFGHIJKLMNOP"
ANT_KEY="sk-""ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
GH_PAT="ghp_""ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456"
PEM_HDR="-----BEGIN RSA ""PRIVATE KEY-----"
DB_URL="postgres""://admin:hunter2@db.internal/prod"
JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"".""eyJzdWIiOiIxMjM0NTY3ODkwIn0"".""dozjgNryP4J3jVmNHl0w5N3XgL0n3I9PlFUP0THsR8U"

t() { # name  expected_exit  hook  json
  local name="$1" want="$2" hook="$3" json="$4"
  local got
  printf '%s' "$json" | bash "$hook" >/dev/null 2>&1
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
  printf '%s' "$json" | "$ROOT/adapters/run-hook.sh" codex "$event" "$policy" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    PASS=$((PASS+1)); echo "PASS ($got): $name"
  else
    FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"
  fi
}

wjson() { # file_path content -> Write payload (jq-safe encoding)
  jq -cn --arg fp "$1" --arg c "$2" '{tool_name:"Write",tool_input:{file_path:$fp,content:$c}}'
}

pjson() { # patch -> Codex apply_patch payload
  jq -cn --arg c "$1" '{tool_name:"apply_patch",tool_input:{command:$c}}'
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

bjson() { jq -cn --arg c "$1" '{tool_input:{command:$c}}'; }

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
wpc() { jq -cn --arg cwd "$1" --arg cmd "$2" '{protocol_version:"1.0",event:"pre_command",runtime:{name:"mock"},cwd:$cwd,command:$cmd}'; }
wpe() { jq -cn --arg cwd "$1" --arg p "$2" '{protocol_version:"1.0",event:"pre_edit",runtime:{name:"mock"},cwd:$cwd,paths:[{path:$p,action:"update"}],added_content:[]}'; }
t "blocks checkout -b in primary"     2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git checkout -b feat/y')"
t "blocks switch -c in primary"       2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git switch -c feat/z')"
t "blocks git branch <new> in primary" 2 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch newb')"
t "allows git branch --all (read)"    0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git branch --all')"
t "allows commit on main in primary"  0 "$H/guard-worktree.sh" "$(wpc "$WT" 'git commit -m x')"
printf '%s' "$(wpc "$WT" 'git commit -m x')" | HARNESS_PRIMARY_COMMIT_POLICY=strict bash "$H/guard-worktree.sh" >/dev/null 2>&1
if [ $? = 2 ]; then PASS=$((PASS+1)); echo "PASS (2): strict policy blocks main commit (agent hook)"; else FAIL=$((FAIL+1)); echo "FAIL: strict agent-hook should block main commit"; fi
t "allows commit inside worktree"     0 "$H/guard-worktree.sh" "$(wpc "$WT/wt" 'git commit -m x')"
t "allows edit on main in primary"    0 "$H/guard-worktree.sh" "$(wpe "$WT" "$WT/a.txt")"
t "allows edit inside worktree"       0 "$H/guard-worktree.sh" "$(wpe "$WT/wt" "$WT/wt/a.txt")"
t "no-op outside a git repo"          0 "$H/guard-worktree.sh" "$(wpe /tmp /tmp/x.txt)"
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
t "blocks git -C <spaced primary> commit" 2 "$H/guard-worktree.sh" "$(wpc "$WT" "git -C \"$SPW\" commit -m x")"
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

echo "────────────────────────────────────────────────────────────"
echo "guards.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ] || exit 1
