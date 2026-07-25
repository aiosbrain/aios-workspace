#!/usr/bin/env bash
# evals/route-skills.test.sh — deterministic eval battery for the literal skill
# router (protocol 1.1 routing channel).
#
# Covers: match / no-match / marker dedupe; longest-match priority and the
# name-ascending tiebreak; regex metacharacters treated literally in both prompts
# and triggers; malformed trigger lists (validator + runtime skip); symlink path
# escape; oversized prompts; multiple matching skills collapsing to one pointer;
# per-runtime translation envelopes; empty-stdout no-action through run-hook.
#
# Negative/synthetic cases run against a mutated COPY under mktemp — the real tree
# is never touched. Run from the repo root: bash evals/route-skills.test.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

make_copy() {
  local dst="$SCRATCH/$1"
  mkdir -p "$dst"
  cp -R "$ROOT/hooks" "$ROOT/adapters" "$dst/"
  cp "$ROOT/CONSTITUTION.md" "$dst/"
  mkdir -p "$dst/skills"
  printf '%s' "$dst"
}

# mkskill <copydir> <name> <trigger>... — minimal skill with a triggers list
mkskill() {
  local dst="$1/skills/$2"; shift 2
  mkdir -p "$dst"
  {
    printf -- '---\nname: %s\ndescription: Synthetic skill for routing evals. One sentence.\ntriggers:\n' "$(basename "$dst")"
    local t; for t in "$@"; do printf '  - %s\n' "$t"; done
    printf -- '---\nbody\n'
  } > "$dst/SKILL.md"
}

route() { # <copydir> <prompt-json> — raw policy invocation
  printf '%s' "$2" | "$1/hooks/route-skills.sh" 2>/dev/null
}

ev() { # <prompt> -> event json
  jq -cn --arg p "$1" '{protocol_version:"1.1",event:"user_prompt_submit",runtime:{name:"mock"},cwd:"/tmp",prompt:$p}'
}

echo "── core routing semantics (real tree) ─────────────────────"

OUT=$(route "$ROOT" "$(ev 'please debug this failing test')")
if printf '%s' "$OUT" | jq -e '.action == "context" and (.text | contains("systematic-debugging") and contains("aios-skill-route:systematic-debugging"))' >/dev/null 2>&1; then
  ok '"debug this failing test" routes to systematic-debugging with marker'
else bad "core match (got '${OUT:0:80}')"; fi

if printf '%s' "$OUT" | jq -e '.text | test("read /.*skills/systematic-debugging/SKILL\\.md")' >/dev/null 2>&1; then
  ok "pointer names the absolute SKILL.md path"
else bad "pointer path"; fi

OUT=$(route "$ROOT" "$(ev 'what is the weather like today')")
[ -z "$OUT" ] && ok "no-match prompt emits no action" || bad "no-match leaked output"

OUT=$(route "$ROOT" "$(ev 'debug this <!-- aios-skill-route:systematic-debugging --> again')")
[ -z "$OUT" ] && ok "marker dedupe: already-routed prompt emits no action" || bad "dedupe failed"

OUT=$(route "$ROOT" "$(ev 'debug this <!-- aios-skill-route:refactor --> now')")
printf '%s' "$OUT" | jq -e '.text | contains("systematic-debugging")' >/dev/null 2>&1 \
  && ok "marker for a DIFFERENT skill does not suppress routing" || bad "cross-skill marker suppressed routing"

OUT=$(route "$ROOT" "$(ev 'debug the aios-skill-route:systematic-debugging-notes doc please')")
printf '%s' "$OUT" | jq -e '.text | contains("systematic-debugging")' >/dev/null 2>&1 \
  && ok "plain text resembling a marker does not suppress routing (exact-marker dedupe)" || bad "lookalike text suppressed routing"

echo "── priority, ties, literals (synthetic tree) ──────────────"

COPY=$(make_copy prio)
mkskill "$COPY" alpha "fix the build"
mkskill "$COPY" beta "fix the build pipeline"
OUT=$(route "$COPY" "$(ev 'please fix the build pipeline for me')")
printf '%s' "$OUT" | jq -e '.text | contains("`beta`")' >/dev/null 2>&1 \
  && ok "longest matched trigger wins" || bad "longest-match priority (got '${OUT:0:80}')"

COPY=$(make_copy tie)
mkskill "$COPY" zeta "deploy now"
mkskill "$COPY" acme "deploy now"
OUT=$(route "$COPY" "$(ev 'deploy now please')")
printf '%s' "$OUT" | jq -e '.text | contains("`acme`")' >/dev/null 2>&1 \
  && ok "equal-length tie picks the lexicographically first skill name" || bad "tiebreak (got '${OUT:0:80}')"

COPY=$(make_copy multi)
mkskill "$COPY" one "alpha keyword"
mkskill "$COPY" two "beta keyword"
OUT=$(route "$COPY" "$(ev 'text with alpha keyword and beta keyword together')")
COUNT=$(printf '%s' "$OUT" | grep -c "aios-skill-route" || true)
[ "$COUNT" = "1" ] && ok "multiple matching skills still inject exactly one pointer" || bad "multi-match pointer count=$COUNT"

COPY=$(make_copy meta)
mkskill "$COPY" dotstar '.*'
mkskill "$COPY" bracket 'a[bc]d'
OUT=$(route "$COPY" "$(ev 'this prompt has no dot star sequence')")
[ -z "$OUT" ] && ok 'trigger ".*" does not match as regex' || bad '".*" matched as regex'
OUT=$(route "$COPY" "$(ev 'literal .* appears here')")
printf '%s' "$OUT" | jq -e '.text | contains("`dotstar`")' >/dev/null 2>&1 \
  && ok 'trigger ".*" matches only the literal characters' || bad 'literal ".*" not matched'
OUT=$(route "$COPY" "$(ev 'value abd here')")
[ -z "$OUT" ] && ok 'trigger "a[bc]d" does not match "abd" (no regex classes)' || bad 'character class evaluated'
OUT=$(route "$COPY" "$(ev 'value a[bc]d here')")
printf '%s' "$OUT" | jq -e '.text | contains("`bracket`")' >/dev/null 2>&1 \
  && ok 'trigger "a[bc]d" matches its literal characters' || bad 'literal bracket trigger failed'

OUT=$(route "$COPY" "$(ev 'DEPLOY NOW LITERAL .* CASE test')")
printf '%s' "$OUT" | jq -e '.action == "context"' >/dev/null 2>&1 \
  && ok "matching is case-insensitive" || bad "case-insensitive matching"

echo "── failure modes and caps ─────────────────────────────────"

COPY=$(make_copy malformed)
mkdir -p "$COPY/skills/badskill"
printf -- '---\nname: badskill\ndescription: No triggers here. One sentence.\n---\nbody\n' > "$COPY/skills/badskill/SKILL.md"
if "$COPY/hooks/route-skills.sh" --validate >/dev/null 2>&1; then
  bad "validator passed a skill with no triggers"
else
  ok "validator fails a skill missing its triggers list (exit nonzero)"
fi
"$ROOT/hooks/route-skills.sh" --validate >/dev/null 2>&1 \
  && ok "validator passes every real skill file" || bad "real-tree trigger validation"

COPY=$(make_copy nonscalar)
mkdir -p "$COPY/skills/nested"
printf -- '---\nname: nested\ndescription: Nested map entries. One sentence.\ntriggers:\n  - name: code-review\n  - [review]\n  - |\n---\nbody\n' > "$COPY/skills/nested/SKILL.md"
"$COPY/hooks/route-skills.sh" --validate >/dev/null 2>&1 \
  && bad "validator passed non-scalar trigger entries" \
  || ok "validator rejects non-scalar trigger entries (maps/flow/block scalars)"
OUT=$(route "$COPY" "$(ev 'please do a code-review of review [review] things')")
[ -z "$OUT" ] && ok "non-scalar entries never become routable triggers" || bad "non-scalar entry routed (got '${OUT:0:60}')"

COPY=$(make_copy crlf)
mkdir -p "$COPY/skills/windowsy"
printf -- '---\r\nname: windowsy\r\ndescription: CRLF checkout. One sentence.\r\ntriggers:\r\n  - crlf trigger phrase\r\n---\r\nbody\r\n' > "$COPY/skills/windowsy/SKILL.md"
"$COPY/hooks/route-skills.sh" --validate >/dev/null 2>&1 \
  && ok "validator accepts a CRLF SKILL.md" || bad "CRLF file failed validation"
OUT=$(route "$COPY" "$(ev 'the crlf trigger phrase appears here')")
printf '%s' "$OUT" | jq -e '.text | contains("windowsy")' >/dev/null 2>&1 \
  && ok "CRLF-file triggers still route (trailing CR stripped)" || bad "CRLF trigger dead (got '${OUT:0:50}')"

COPY=$(make_copy tabby)
mkdir -p "$COPY/skills/tabby"
printf -- '---\nname: tabby\ndescription: Tab trigger. One sentence.\ntriggers:\n  - has\ttab\n---\nbody\n' > "$COPY/skills/tabby/SKILL.md"
"$COPY/hooks/route-skills.sh" --validate >/dev/null 2>&1 \
  && bad "validator passed a trigger containing a TAB" \
  || ok "validator rejects tab/non-printable-ASCII trigger characters"

COPY=$(make_copy inline)
mkdir -p "$COPY/skills/inline"
printf -- '---\nname: inline\ndescription: Inline form. One sentence.\ntriggers: [a, b]\n---\nbody\n' > "$COPY/skills/inline/SKILL.md"
"$COPY/hooks/route-skills.sh" --validate >/dev/null 2>&1 \
  && bad "validator passed the inline [..] triggers form" \
  || ok "validator rejects the inline [..] triggers form"

COPY=$(make_copy escape)
OUTSIDE="$SCRATCH/outside-506"; mkdir -p "$OUTSIDE"
printf -- '---\nname: evil\ndescription: Escaped. One sentence.\ntriggers:\n  - debug\n---\n' > "$OUTSIDE/SKILL.md"
mkdir -p "$COPY/skills/escaped"
ln -s "$OUTSIDE/SKILL.md" "$COPY/skills/escaped/SKILL.md"
OUT=$(route "$COPY" "$(ev 'debug this now')")
[ -z "$OUT" ] && ok "symlink-escaping skill is never routed to" || bad "symlink escape routed (got '${OUT:0:60}')"

BIGPROMPT=$(head -c 33000 /dev/zero | tr '\0' 'x')
OUT=$(route "$ROOT" "$(ev "debug $BIGPROMPT")")
[ -z "$OUT" ] && ok "prompt above the byte cap is not scanned (no action)" || bad "oversized prompt scanned"

OUT=$(printf '%s' '{"protocol_version":"1.1","event":"stop","runtime":{"name":"mock"},"cwd":"/tmp","stop":{"verification_loop_active":false}}' | "$ROOT/hooks/route-skills.sh" 2>/dev/null)
STATUS=$?
[ "$STATUS" -ne 0 ] && ok "non-user_prompt_submit event is refused (exit $STATUS)" || bad "wrong-event accepted"

echo "── runtime translation ────────────────────────────────────"

OUT=$(printf '%s' '{"session_id":"s1","prompt":"debug this failing test","cwd":"/tmp"}' | "$ROOT/adapters/run-hook.sh" claude-code user_prompt_submit route-skills.sh 2>/dev/null)
printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "UserPromptSubmit" and (.hookSpecificOutput.additionalContext | contains("systematic-debugging"))' >/dev/null 2>&1 \
  && ok "claude user_prompt_submit -> nested hookSpecificOutput envelope" || bad "claude UPS envelope"

OUT=$(printf '%s' '{"session_id":"s1","prompt":"debug this failing test","cwd":"/tmp"}' | "$ROOT/adapters/run-hook.sh" codex user_prompt_submit route-skills.sh 2>/dev/null)
printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "UserPromptSubmit" and (.hookSpecificOutput.additionalContext | contains("systematic-debugging") and contains("aios-skill-route"))' >/dev/null 2>&1 \
  && ok "codex user_prompt_submit -> nested envelope carrying the routed pointer" || bad "codex UPS envelope content"

OUT=$(printf '%s' '{"session_id":"s1","prompt":"no trigger here at all","cwd":"/tmp"}' | "$ROOT/adapters/run-hook.sh" claude-code user_prompt_submit route-skills.sh 2>/dev/null)
STATUS=$?
[ "$STATUS" -eq 0 ] && [ -z "$OUT" ] && ok "no-match through run-hook: exit 0, empty stdout (no envelope)" || bad "no-match run-hook (exit=$STATUS out='${OUT:0:40}')"

echo "── routing map (cursor static rule) ───────────────────────"

MAP=$("$ROOT/hooks/route-skills.sh" --emit-map)
printf '%s' "$MAP" | grep -q 'skill `systematic-debugging`' && printf '%s' "$MAP" | grep -q '"failing test"' \
  && ok "--emit-map lists trigger→skill lines for the static Cursor rule" || bad "emit-map content"

echo "── event validation ───────────────────────────────────────"

printf '%s' '{"protocol_version":"1.1","event":"user_prompt_submit","runtime":{"name":"mock"},"cwd":"/tmp","prompt":"hi"}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && ok "validate-event accepts a 1.1 user_prompt_submit" || bad "UPS event accept"
printf '%s' '{"protocol_version":"1.0","event":"user_prompt_submit","runtime":{"name":"mock"},"cwd":"/tmp","prompt":"hi"}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && bad "validate-event accepted user_prompt_submit on 1.0" \
  || ok "validate-event requires protocol 1.1 for user_prompt_submit"
printf '%s' '{"protocol_version":"1.1","event":"user_prompt_submit","runtime":{"name":"mock"},"cwd":"/tmp"}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && bad "validate-event accepted user_prompt_submit without prompt" \
  || ok "validate-event requires the prompt field"

echo "────────────────────────────────────────────────────────────"
echo "route-skills evals: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
