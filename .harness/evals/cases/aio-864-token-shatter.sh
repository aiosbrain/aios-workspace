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
# ── destination detection, once the token shatter stops hiding it ────────────
# Removing the shatter removes a crude safety net: it used to make EVERY token a
# candidate, so a flag-carried destination was caught by accident. Each form below is a
# real write into the primary and must be found deliberately.
ts "864 blocks curl bundled -sLo into primary" 2 "$(wpc "$WT/wt" "curl -sLo $WT/f864c https://example.com")"
ts "864 blocks wget bundled -qO into primary"  2 "$(wpc "$WT/wt" "wget -qO $WT/f864w https://example.com")"
ts "864 blocks wget -P prefix into primary"    2 "$(wpc "$WT/wt" "wget -P $WT https://example.com")"
ts "864 blocks cp -t target-dir in primary"    2 "$(wpc "$WT/wt" "cp -t $WT/dir864 a b")"
ts "864 blocks cp --target-directory= primary" 2 "$(wpc "$WT/wt" "cp --target-directory=$WT/dir864 a")"
ts "864 blocks sudo -u <user> rm in primary"   2 "$(wpc "$WT/wt" "sudo -u alex rm -rf $WT/a.txt")"
ts "864 blocks noclobber-override redirect"    2 "$(wpc "$WT/wt" "echo x >| $WT/f864n")"
ts "864 blocks ln destination in primary"      2 "$(wpc "$WT/wt" "ln -s /tmp/x864 $WT/link864")"
ts "864 blocks install destination in primary" 2 "$(wpc "$WT/wt" "install /tmp/src864 $WT/dst864")"
ts "864 blocks dd of= into primary"            2 "$(wpc "$WT/wt" "dd if=/tmp/x864 of=$WT/y864")"
ts "864 blocks rsync destination in primary"   2 "$(wpc "$WT/wt" "rsync -t /tmp/src864 $WT/rdst864")"
# …and the SOURCE operands of those same commands are reads, not writes
ts "864 allows ln source from primary"      0 "$(wpc "$WT/wt" "ln -s $WT/a.txt /tmp/b864")"
ts "864 allows install source from primary" 0 "$(wpc "$WT/wt" "install $WT/a.txt /tmp/dst864b")"
ts "864 allows dd if= source from primary"  0 "$(wpc "$WT/wt" "dd if=$WT/a.txt of=/tmp/y864b")"
ts "864 allows curl bundled -o outside"     0 "$(wpc "$WT" 'curl -sSo /tmp/o864 https://example.com')"
ts "864 allows wget -O - to stdout"         0 "$(wpc "$WT" 'wget -O - https://example.com')"
ts "864 allows rsync -t outside primary"    0 "$(wpc "$WT" 'rsync -t /tmp/src864 /tmp/dst864')"
ts "864 allows process substitution"        0 "$(wpc "$WT" 'diff <(cat a.txt) >(sort)')"

# ── option values and read-only modes are not destinations ───────────────────
ts "864 allows truncate size operand outside primary" 0 "$(wpc "$WT" 'truncate -s 0 /tmp/f864t')"
ts "864 blocks truncate on a primary file"    2 "$(wpc "$WT/wt" "truncate -s 0 $WT/a.txt")"
ts "864 allows unzip -l listing in primary"   0 "$(wpc "$WT" 'unzip -l archive864.zip')"
ts "864 allows unzip of a primary archive elsewhere" 0 "$(wpc "$WT/wt" "unzip $WT/a864.zip -d /tmp")"
ts "864 blocks bare unzip into primary cwd"   2 "$(wpc "$WT" 'unzip /tmp/a864.zip')"
ts "864 allows tar reading a primary archive elsewhere" 0 "$(wpc "$WT/wt" "tar -xf $WT/a431.tar -C /tmp")"
ts "864 blocks bare tar extract into primary cwd" 2 "$(wpc "$WT" 'tar -xf /tmp/a431.tar')"
ts "864 allows tar create whose operand starts with x" 0 "$(wpc "$WT" 'tar -cf /tmp/out864.tar xml')"
ts "864 allows ditto reading from the primary" 0 "$(wpc "$WT/wt" "ditto $WT/a.txt /tmp/dst864d")"
ts "864 blocks ditto into the primary"         2 "$(wpc "$WT/wt" "ditto /tmp/src864 $WT/dst864d")"
# ── redirection operator forms the scanner used to lose ──────────────────────
ts "864 blocks the second of two adjacent redirects" 2 "$(wpc "$WT/wt" "echo x >/tmp/x864r>$WT/f864r")"
ts "864 blocks >& file redirect into primary"  2 "$(wpc "$WT/wt" "echo x >& $WT/f864a")"
ts "864 blocks attached >&file into primary"   2 "$(wpc "$WT/wt" "echo x >&$WT/f864b")"
ts "864 allows fd duplication 2>&1"            0 "$(wpc "$WT" 'echo x 2>&1')"
ts "864 allows fd close >&-"                   0 "$(wpc "$WT" 'ls >&-')"
ts "864 allows a backgrounded command"         0 "$(wpc "$WT" 'sleep 1 & echo done')"
ts "864 still blocks a write after a background job" 2 "$(wpc "$WT/wt" "sleep 1 & echo x > $WT/bg864")"

# ── option values attached to, or consumed by, a short option ────────────────
ts "864 allows mkdir -m mode outside primary"  0 "$(wpc "$WT" 'mkdir -m 755 /tmp/new864m')"
ts "864 blocks mkdir -m mode into primary"     2 "$(wpc "$WT/wt" "mkdir -m 755 $WT/new864m")"
ts "864 allows touch -d stamp outside primary" 0 "$(wpc "$WT" 'touch -d 2026-01-01 /tmp/f864d')"
ts "864 blocks touch -d stamp into primary"    2 "$(wpc "$WT/wt" "touch -d 2026-01-01 $WT/f864d")"
ts "864 blocks chmod --reference on a primary file" 2 "$(wpc "$WT/wt" "chmod --reference=/tmp/ref864 $WT/a.txt")"
ts "864 blocks chown --reference on a primary file" 2 "$(wpc "$WT/wt" "chown --reference=/tmp/ref864 $WT/a.txt")"
ts "864 allows chmod --reference outside primary"   0 "$(wpc "$WT" 'chmod --reference=/tmp/ref864 /tmp/x864')"
ts "864 blocks curl attached bundled -sLo<path>" 2 "$(wpc "$WT/wt" "curl -sLo$WT/f864ca https://example.com")"
ts "864 blocks wget attached bundled -qO<path>"  2 "$(wpc "$WT/wt" "wget -qO$WT/f864wa https://example.com")"
ts "864 allows curl with no output option"       0 "$(wpc "$WT" 'curl -sSL https://example.com')"
ts "864 allows wget -qO- to stdout"              0 "$(wpc "$WT" 'wget -qO- https://example.com')"

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
