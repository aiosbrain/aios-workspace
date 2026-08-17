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
      return i
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
          if (substr($0, i + 1, 1) != "&") i = emit_target($0, i + 1)
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
                           substr($0, i + 1, 1) == "&")) i++
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
          emit("P"); in_pipeline = 1
        } else if (c == "&") {
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
split_segment() {
  SEG_CMD=''
  SEG_OPS=''
  _sg_seeking=1
  while IFS= read -r _sg_w || [ -n "$_sg_w" ]; do
    [ -n "$_sg_w" ] || continue
    if [ "$_sg_seeking" = 1 ]; then
      case "$_sg_w" in
        '{'|'}'|'('|')'|'!'|'--'|if|elif|while|until|then|do|else|time|nohup|nice|sudo|doas|command|builtin|env|xargs|exec) continue ;;
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

# has_operand <ops> <ERE> — does any argument of the segment match?
has_operand() { printf '%s\n' "$1" | grep -Eq "$2"; }
