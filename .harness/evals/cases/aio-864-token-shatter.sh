#!/usr/bin/env bash
# AIO-864 token-shatter regression cases for guard-worktree.sh. SOURCED by
# ../guards.test.sh (which owns PASS/FAIL, $ROOT, $WT and the ts/wpc helpers) — kept in
# its own file only to stay under the repository file-size cap, not because it is a
# separate entry point. There is one eval entry point and it is guards.test.sh.
#
# What these pin: the strict write-candidate list is built from the segment's COMMAND
# WORD and that command's own arguments. It used to be the raw command text shattered on
# whitespace, so any command whose TEXT mentioned a mutating verb had every one of its
# tokens treated as a write target — `echo`, `grep` and `dotenvx` all resolved to the
# primary checkout root and blocked. Every row of the issue's reproduction table is here,
# alongside the true-positive controls the issue explicitly fences in.

echo "── AIO-864 token shatter ──────────────────────────────────"
# The candidate list used to be the raw command shattered on whitespace, so any
# command whose TEXT mentioned a mutating verb had every one of its tokens treated
# as a write target — `echo`, `grep` and `dotenvx` all resolved to the primary root
# and blocked. Every row of the issue's reproduction table is pinned here, from the
# PRIMARY checkout (where the false positives actually fired).
ts "864 allows echo mentioning curl in a quoted string" 0 "$(wpc "$WT" 'echo "run curl to fetch it"')"
ts "864 allows grep for literal text containing install" 0 \
  "$(wpc "$WT" 'grep -rn "npm install -g @aiosbrain/aios" ../aios-website/src')"
ts "864 allows a Linear create whose title contains install" 0 \
  "$(wpc "$WT" 'dotenvx run -f .env -- node lin.mjs create "Website package-first install path"')"
ts "864 allows grep with no mutating verb at all" 0 "$(wpc "$WT" 'grep -rn "deepseek" scripts/')"
ts "864 allows git log --grep=touch"             0 "$(wpc "$WT" 'git log --grep=touch')"
# a mutating verb inside single OR double quotes is data, not a command
ts "864 allows single-quoted rm -rf as grep data" 0 "$(wpc "$WT" "grep -rn 'rm -rf' docs/")"
ts "864 allows double-quoted rm -rf as grep data" 0 "$(wpc "$WT" 'grep -rn "rm -rf" docs/')"
ts "864 allows node -e text mentioning mkdir"    0 "$(wpc "$WT" 'node -e "console.log(\"mkdir here\")"')"
# curl/wget only write when asked to; a read-only fetch is not a primary write
ts "864 allows curl streaming to stdout in primary" 0 "$(wpc "$WT" 'curl -sS https://example.com/api')"
ts "864 blocks curl -o into the primary"         2 "$(wpc "$WT/wt" "curl -sS -o $WT/out864.txt https://example.com")"
ts "864 blocks curl -O writing into the primary" 2 "$(wpc "$WT" 'curl -O https://example.com/a.tgz')"
ts "864 blocks wget default write into primary"  2 "$(wpc "$WT" 'wget https://example.com/a.tgz')"
ts "864 allows wget -O outside the primary"      0 "$(wpc "$WT" 'wget -O /tmp/a864.tgz https://example.com/a.tgz')"
# chmod/chown lead with a mode/owner operand, which is not a path
ts "864 allows chmod on a path outside the primary" 0 "$(wpc "$WT" 'chmod 755 /tmp/a864.sh')"
ts "864 blocks chmod on a path inside the primary"  2 "$(wpc "$WT/wt" "chmod 755 $WT/a.txt")"
# the true-positive controls the issue fences in — coverage must not drop
ts "864 control blocks redirect in primary"      2 "$(wpc "$WT" 'echo hi > notes864.txt')"
ts "864 control blocks mkdir in primary"         2 "$(wpc "$WT" 'mkdir -p newdir864')"
ts "864 control blocks rm in primary"            2 "$(wpc "$WT" 'rm -f README.md')"
ts "864 control blocks cp into primary"          2 "$(wpc "$WT/wt" "cp /tmp/x864 $WT/y864")"
ts "864 control blocks sed -i into primary"      2 "$(wpc "$WT/wt" "sed -i '' s/a/b/ $WT/a.txt")"
ts "864 control blocks tee into primary"         2 "$(wpc "$WT/wt" "tee $WT/f864")"
ts "864 control blocks quoted path with spaces"  2 "$(wpc "$WT/wt" "rm -f \"$WT/a file 864.txt\"")"
# the same verdicts must come out of BOTH strict adapters, not just the portable policy
tadapter() { # name expected_exit adapter-relpath event json
  local name="$1" want="$2" rel="$3" event="$4" json="$5" got
  printf '%s' "$json" | HARNESS_GUARDED_ROOT="$(guarded_root_of "$json")" \
    /bin/sh "$ROOT/$rel" "$event" guard-worktree.sh >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "PASS ($got): $name"; else FAIL=$((FAIL+1)); echo "FAIL (got $got, want $want): $name"; fi
}
_c864_allow='echo "run curl to fetch it"'
_c864_block='rm -f README.md'
for _a864 in adapters/cursor/run-strict-guard.sh adapters/claude-code/run-strict-guard.sh; do
  _label864=$(printf '%s' "$_a864" | cut -d/ -f2)
  tadapter "864 $_label864 adapter allows quoted-verb echo" 0 "$_a864" pre_command \
    "$(jq -cn --arg cwd "$WT" --arg c "$_c864_allow" '{tool_name:"Bash",command:$c,tool_input:{command:$c},cwd:$cwd}')"
  tadapter "864 $_label864 adapter still blocks a real rm" 2 "$_a864" pre_command \
    "$(jq -cn --arg cwd "$WT" --arg c "$_c864_block" '{tool_name:"Bash",command:$c,tool_input:{command:$c},cwd:$cwd}')"
done
