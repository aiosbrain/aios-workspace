#!/bin/sh
# shell-parse.sh — quote-aware shell-text scanners shared by the policy hooks.
#
# SOURCED, not executed: it defines shell functions for guard-worktree.sh.
#
# WHY THIS EXISTS
# ---------------
# The worktree guard has to answer "what does this command WRITE, and where?" from
# unexecuted, attacker-controlled command text. Nothing in here evaluates, expands or
# runs any of it: every scanner is a character-level pass that respects quoting,
# backslash escapes and heredoc bodies, because getting that wrong in either direction
# is a real defect — AIO-864 was a whole class of false positives caused by treating
# quoted DATA as shell syntax, and the heredoc bookkeeping exists because the reverse
# mistake let a real redirect hide inside a heredoc body.
#
# Split out of guard-worktree.sh so both files stay under the repository size cap and
# the parsing surface can be reviewed on its own. The guard verifies every function
# below arrived before it trusts any of them (a truncated lib that sourced cleanly
# would silently disable enforcement), so nothing here may be renamed in isolation.

# Shared awk heredoc bookkeeping for the two scanners below.
AWK_HEREDOC='
  function remember_heredoc(line, start,    i, c, quote, delim, strip_tabs) {
    i = start; strip_tabs = substr(line, i, 1) == "-"
    if (strip_tabs) i++
    while (substr(line, i, 1) ~ /[ \t]/) i++
    quote = substr(line, i, 1)
    if (quote == "\047" || quote == "\"") i++; else quote = ""
    delim = ""
    while (i <= length(line)) {
      c = substr(line, i, 1)
      if ((quote != "" && c == quote) ||
          (quote == "" && c ~ /[ \t;|&<>]/)) break
      delim = delim c
      i++
    }
    if (delim != "") {
      heredoc[++heredoc_count] = delim; heredoc_strip_tabs[heredoc_count] = strip_tabs
    }
    return i
  }
  function in_heredoc_body(line) {
    if (heredoc_current > 0 && heredoc_current <= heredoc_count) {
      closing_line = line
      if (heredoc_strip_tabs[heredoc_current]) sub(/^\t+/, "", closing_line)
      if (closing_line == heredoc[heredoc_current]) heredoc_current++
      return 1
    }
    return 0
  }
'

# shell_redirection_targets <command> -> one output-redirection target per line.
# Operators inside quotes and every line of a heredoc body are data, not shell
# syntax. The scanner intentionally does not execute or expand command text.
shell_redirection_targets() {
  awk "$AWK_HEREDOC"'
    function space(c) { return c == " " || c == "\t" }
    function emit_target(line, start,    i, c, quote, escaped, target) {
      i = start
      while (space(substr(line, i, 1))) i++
      target = ""
      quote = ""
      escaped = 0
      while (i <= length(line)) {
        c = substr(line, i, 1)
        if (escaped) {
          target = target c
          escaped = 0
        } else if (c == "\\") {
          escaped = 1
        } else if (quote != "") {
          if (c == quote) quote = ""
          else target = target c
        } else if (c == "\047" || c == "\"") {
          quote = c
        } else if (space(c) || c ~ /[;|&<>]/) {
          break
        } else {
          target = target c
        }
        i++
      }
      if (target != "") print target
      # Hand back the index BEFORE the character that ended the word: the calling loop
      # increments it, so returning `i` would swallow that character. `cmd >/tmp/x>/primary/f` used to
      # lose its second redirect that way, which is a write the guard never saw.
      return i - 1
    }
    {
      if (in_heredoc_body($0)) next
      quote = ""
      escaped = 0
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        nextc = substr($0, i + 1, 1)
        if (escaped) {
          escaped = 0
        } else if (c == "\\") {
          escaped = 1
        } else if (quote != "") {
          if (c == quote) quote = ""
        } else if (c == "\047" || c == "\"") {
          quote = c
        } else if (c == "<" && nextc == "<") {
          i = remember_heredoc($0, i + 2)
        } else if (c == ">") {
          if (nextc == ">") i++
          after = substr($0, i + 1, 1)
          # `>|` is the noclobber OVERRIDE, so it still truncates its target — skip the
          # bar and read the path. `>&` is a file-descriptor dup and `>(…)` is process
          # substitution: neither names a path, and emitting `(cmd)` as a candidate was
          # exactly the false-positive shape AIO-864 exists to remove.
          if (after == "|") { i++; after = substr($0, i + 1, 1) }
          if (after == "&") {
            # `2>&1` and `>&-` duplicate or close a descriptor. `>&word` with anything
            # else after it is a FILE redirect in bash, and skipping it wholesale let
            # `echo x >& <primary>/f` write into the primary unseen.
            if (substr($0, i + 2) !~ /^[ \t]*([0-9]+|-)([ \t;|&<>]|$)/) i = emit_target($0, i + 2)
          } else if (after != "(") {
            i = emit_target($0, i + 1)
          }
        }
      }
      if (heredoc_current == 0 && heredoc_count > 0) heredoc_current = 1
    }
  '
}

# shell_words <segment> -> one shell WORD per line, quote-aware.
#
# AIO-864: the write-candidate list used to be built by shattering the raw command
# text on whitespace, so `echo "run curl to fetch it"` contributed `echo`, `run`,
# `curl`, … as write targets. This tokenizer is the replacement: it strips one layer
# of quoting, keeps a quoted word with spaces as ONE word, and drops redirection
# operators together with their targets (those are collected separately, and far more
# carefully, by shell_redirection_targets). It never executes or expands anything.
shell_words() {
  printf '%s' "$1" | awk '
    function flush() {
      if (started) {
        if (redir) redir = 0
        else if (word != "") print word
      }
      word = ""; started = 0
    }
    {
      quote = ""; escaped = 0; word = ""; started = 0; redir = 0
      n = length($0)
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (escaped) { word = word c; started = 1; escaped = 0; continue }
        if (c == "\\") { escaped = 1; started = 1; continue }
        if (quote != "") { if (c == quote) quote = ""; else word = word c; started = 1; continue }
        if (c == "\047" || c == "\"") { quote = c; started = 1; continue }
        if (c == " " || c == "\t") { flush(); continue }
        if (c == ">" || c == "<") {
          # `2>file` / `1>&2`: the leading file-descriptor digits are shell syntax,
          # not a path — drop them rather than emitting `2` as a write candidate.
          if (started && word ~ /^[0-9]+$/) { word = ""; started = 0 }
          flush()
          while (i < n && (substr($0, i + 1, 1) == ">" || substr($0, i + 1, 1) == "<" ||
                           substr($0, i + 1, 1) == "&" || substr($0, i + 1, 1) == "|")) i++
          redir = 1
          continue
        }
        word = word c; started = 1
      }
      flush()
    }
  '
}

shell_command_segments() {
  printf '%s' "$1" | awk "$AWK_HEREDOC"'
    function emit(kind) {
      gsub(/^[ \t]+|[ \t]+$/, "", segment)
      if (segment != "") print kind "|" segment
      segment = ""
    }
    {
      if (in_heredoc_body($0)) next
      quote = ""; escaped = 0
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        nextc = substr($0, i + 1, 1)
        if (escaped) {
          segment = segment c; escaped = 0
        } else if (c == "\\") {
          segment = segment c; escaped = 1
        } else if (quote != "") {
          segment = segment c
          if (c == quote) quote = ""
        } else if (c == "\047" || c == "\"") {
          segment = segment c; quote = c
        } else if (c == "#" && (i == 1 || substr($0, i - 1, 1) ~ /[ \t]/)) { break
        } else if (c == "<" && nextc == "<") {
          segment = segment c nextc
          i++
          heredoc_end = remember_heredoc($0, i + 1)
          segment = segment substr($0, i + 1, heredoc_end - i)
          i = heredoc_end
        } else if ((c == "&" || c == "|") && nextc == c) {
          emit(in_pipeline ? "P" : "S"); i++; in_pipeline = 0
        } else if (c == "|") {
          # `>|` is one redirection operator, not a redirect followed by a pipe. Splitting
          # there would strand the target in its own segment, where nothing reads it as a
          # write — a silent bypass of the strict shell-write scan. `>&` is the same shape.
          if (segment ~ />[ \t]*$/) { segment = segment c }
          else { emit("P"); in_pipeline = 1 }
        } else if (c == "&") {
          if (segment ~ />[ \t]*$/) { segment = segment c; continue }
          emit("P"); in_pipeline = 0
        } else if (c == ";") {
          emit(in_pipeline ? "P" : "S"); in_pipeline = 0
        } else if (c == "(" && segment ~ /^[ \t]*$/) {
          # AIO-637 F3/F6: unquoted `(` at command position opens a subshell
          # (O/C markers let the driver restore the tracked cwd at the close).
          # A `)` closing a mid-word paren ($(..), %(refname)) or with no open
          # at all (case patterns) stays DATA — never splits a segment.
          print "O|("; segment = ""; in_pipeline = 0; depth++
        } else if (c == ")" && (depth > 0 || paren > 0)) {
          if (paren > 0) { paren--; segment = segment c }
          else { emit(in_pipeline ? "P" : "S"); print "C|)"; in_pipeline = 0; depth-- }
        } else {
          if (c == "(") paren++
          segment = segment c
        }
      }
      emit(in_pipeline ? "P" : "S"); in_pipeline = 0
      if (heredoc_current == 0 && heredoc_count > 0) heredoc_current = 1
    }
  '
}

# split_segment <segment> — sets SEG_CMD (the command WORD, basename'd) and SEG_OPS
# (its arguments, one per line) for ONE simple command.
#
# AIO-864: a mutating verb only counts when it is the word that NAMES the command.
# A verb inside a quoted argument (`grep -rn "npm install -g x" docs/`) is data and
# can never reach SEG_CMD, which is what kills the whole false-positive class. The
# scan looks past compound-command keywords, `VAR=val` prefixes and process wrappers
# (`env`, `sudo`, `command`, `xargs`, …) so `xargs rm` still resolves to `rm`.
#
# A wrapper's own OPTION VALUE is consumed too: without that, `sudo -u alex rm -rf …`
# resolves its command word to `alex`, which is no mutating command, and the `rm` behind
# it goes unexamined. The value-taking set is the union across the recognised wrappers
# (sudo/doas `-u -g -p -C -h -D -R -T -U`, nice/xargs `-n -P -I -i -d -s -E -e -a -L -l`,
# timeout `-k -s`, stdbuf `-i -o -e`); it is consulted only AFTER a wrapper has been
# seen, so an ordinary command's own flags are never treated as taking a value.
split_segment() {
  SEG_CMD=''
  SEG_OPS=''
  _sg_seeking=1
  _sg_wrapped=0
  _sg_skip=0
  while IFS= read -r _sg_w || [ -n "$_sg_w" ]; do
    [ -n "$_sg_w" ] || continue
    if [ "$_sg_seeking" = 1 ]; then
      if [ "$_sg_skip" = 1 ]; then _sg_skip=0; continue; fi
      case "$_sg_w" in
        '{'|'}'|'('|')'|'!'|'--'|if|elif|while|until|then|do|else) continue ;;
        time|nohup|exec|command|builtin) continue ;;
        nice|sudo|doas|env|xargs|timeout|stdbuf) _sg_wrapped=1; continue ;;
        -u|-g|-p|-C|-h|-D|-R|-T|-U|-n|-P|-I|-i|-d|-s|-E|-e|-a|-L|-l|-k|-o)
          [ "$_sg_wrapped" = 1 ] && _sg_skip=1
          continue ;;
        -*) continue ;;
        [A-Za-z_]*=*) continue ;;
      esac
      # shellcheck disable=SC2034  # SEG_CMD is this function's return value, read by the caller
      SEG_CMD=${_sg_w##*/}
      _sg_seeking=0
      continue
    fi
    SEG_OPS="$SEG_OPS$_sg_w
"
  done <<SPLIT_SEGMENT_EOF
$(shell_words "$1")
SPLIT_SEGMENT_EOF
}

# drop_first_operand <ops> — the first NON-FLAG argument, removed. `sed -i '' s/a/b/ f`
# and `chmod 755 f` both lead with an operand that is a script/mode, not a path.
drop_first_operand() {
  printf '%s\n' "$1" | awk 'NF { if (!dropped && $0 !~ /^-/) { dropped = 1; next } print }'
}

# drop_flag_values <ops> <ERE of value-taking flags> — remove those flags AND the word
# each one consumes. `truncate -s 0 /tmp/f` otherwise contributes `0`, which resolves
# against the shell cwd and blocks a command that never touches the primary checkout.
drop_flag_values() {
  printf '%s\n' "$1" | awk -v flags="$2" '
    NF {
      if (skip) { skip = 0; next }
      if ($0 ~ ("^(" flags ")$")) { skip = 1; next }
      if ($0 ~ ("^(" flags ")=")) next
      print
    }
  '
}

# has_operand <ops> <ERE> — does any argument of the segment match?
has_operand() { printf '%s\n' "$1" | grep -Eq "$2"; }

# last_destination <ops> <honor_target_flag> — where a copy/link/install-style command
# writes. Normally the last non-flag operand, but coreutils `-t <dir>` /
# `--target-directory=<dir>` names the destination explicitly and makes EVERY positional
# operand a source, so `cp -t <primary>/dir a b` would otherwise report `b` and allow a
# real write. Pass 0 for rsync, where `-t` means --times and consuming the next word
# would both invent a candidate and hide the true destination.
last_destination() {
  printf '%s\n' "$1" | awk -v honor="$2" '
    NF {
      if (take) { take = 0; got = 1; if ($0 != "-") print; next }
      if (honor == 1) {
        if ($0 == "-t" || $0 == "--target-directory") { take = 1; next }
        if ($0 ~ /^--target-directory=/) { sub(/^[^=]*=/, ""); print; got = 1; next }
        if ($0 ~ /^-t./ && $0 !~ /^--/) { print substr($0, 3); got = 1; next }
      }
      if ($0 !~ /^-/) last = $0
    }
    END { if (!got && last != "") print last }
  '
}

# flag_destinations <ops> <letter> <long-names ERE> <cwd> <cwd-when-absent 0|1>
# Destinations named by an OUTPUT FLAG rather than by position — how curl and wget say
# where bytes land. Bundled short-option clusters count: `curl -sLo <path>` and
# `wget -qO <path>` are the ordinary spellings, and matching only the exact word `-o`
# would let the most common real write walk straight past the guard. `-` is stdout, not
# a path. With <cwd-when-absent>, a command that writes into the shell cwd by default
# (wget) reports that cwd when no explicit destination was given.
flag_destinations() {
  printf '%s\n' "$1" | awk -v letter="$2" -v longs="$3" -v cwd="$4" -v dfl="$5" '
    # Walk the cluster one character at a time rather than pattern-matching it: the
    # value may be ATTACHED at the position where the option letter appears, as in
    # `curl -sLo<path>`, and a regex cannot say where that letter was without
    # ambiguity once the value itself contains letters. Returns "\001" when this token
    # is not a short-option cluster carrying the letter, "" when the value is the next
    # word, and otherwise the attached value.
    function cluster_value(tok, want,   j, ch) {
      if (tok !~ /^-[A-Za-z]/) return "\001"
      for (j = 2; j <= length(tok); j++) {
        ch = substr(tok, j, 1)
        if (ch == want) return substr(tok, j + 1)
        if (ch !~ /[A-Za-z]/) return "\001"
      }
      return "\001"
    }
    NF {
      if (take) { take = 0; got = 1; if ($0 != "-") print; next }
      if (longs != "" && $0 ~ ("^--(" longs ")$")) { take = 1; next }
      if (longs != "" && $0 ~ ("^--(" longs ")=")) {
        sub(/^[^=]*=/, ""); got = 1; if ($0 != "-") print; next
      }
      if ($0 !~ /^--/) {
        value = cluster_value($0, letter)
        if (value != "\001") {
          if (value == "") { take = 1; next }
          got = 1; if (value != "-") print value; next
        }
      }
    }
    END { if (dfl == 1 && !got) print cwd }
  '
}
