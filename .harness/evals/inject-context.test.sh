#!/usr/bin/env bash
# evals/inject-context.test.sh — deterministic eval battery for the session/subagent
# context injector (protocol 1.1 action channel).
#
# Covers: valid context actions translated per runtime envelope; malformed action
# envelopes rejected with a nonzero exit and EMPTY stdout; the 8,000-byte cap as an
# explicit failure; missing agent-digest as an explicit failure; zero skills producing
# a valid empty index; symlinked SKILL.md entries rejected; compact-phase re-injection.
#
# Negative cases run against a mutated COPY of the harness under mktemp — the real
# tree is never touched. Run from the repo root: bash evals/inject-context.test.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

# make_copy <name> — minimal mutable harness copy (hooks + adapters + contracts + skills)
make_copy() {
  local dst="$SCRATCH/$1"
  mkdir -p "$dst"
  cp -R "$ROOT/hooks" "$ROOT/adapters" "$ROOT/skills" "$dst/"
  cp "$ROOT/CONSTITUTION.md" "$dst/"
  printf '%s' "$dst"
}

SS_CLAUDE='{"session_id":"s1","source":"startup","cwd":"/tmp"}'
SS_COMPACT='{"session_id":"s1","source":"compact","cwd":"/tmp"}'
SA_CLAUDE='{"session_id":"s1","agent_type":"Explore","cwd":"/tmp"}'
SS_CODEX='{"session_id":"s1","cwd":"/tmp"}'
SS_CURSOR='{"conversation_id":"c1"}'

echo "── translation per runtime ────────────────────────────────"

# Claude SessionStart consumes PLAIN STDOUT (live-verified on 2.1.220: top-level
# additionalContext JSON is ignored for this event) — so the translation is raw text.
OUT=$(printf '%s' "$SS_CLAUDE" | "$ROOT/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | grep -q "Spec before code" && ! printf '%s' "$OUT" | jq -e 'type' >/dev/null 2>&1; then
  ok "claude session_start -> plain-text stdout with digest (not JSON)"
else bad "claude session_start plain-text translation"; fi

if printf '%s' "$OUT" | grep -q "Skills index" && printf '%s' "$OUT" | grep -q "/skills/"; then
  ok "claude session_start context carries a skill index with absolute paths"
else bad "claude session_start skill index"; fi

OUT=$(printf '%s' "$SA_CLAUDE" | "$ROOT/adapters/run-hook.sh" claude-code subagent_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "SubagentStart" and (.hookSpecificOutput.additionalContext | length > 0)' >/dev/null 2>&1; then
  ok "claude subagent_start -> nested hookSpecificOutput.additionalContext"
else bad "claude subagent_start envelope"; fi

OUT=$(printf '%s' "$SS_CODEX" | "$ROOT/adapters/run-hook.sh" codex session_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart" and (.hookSpecificOutput.additionalContext | length > 0)' >/dev/null 2>&1; then
  ok "codex session_start -> nested hookSpecificOutput.additionalContext"
else bad "codex session_start envelope"; fi

OUT=$(printf '%s' "$SS_CODEX" | "$ROOT/adapters/run-hook.sh" codex subagent_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.hookEventName == "SubagentStart"' >/dev/null 2>&1; then
  ok "codex subagent_start -> nested hookSpecificOutput.additionalContext"
else bad "codex subagent_start envelope"; fi

OUT=$(printf '%s' "$SS_CURSOR" | "$ROOT/adapters/run-hook.sh" cursor session_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | jq -e '(keys == ["additional_context"]) and (.additional_context | length > 0)' >/dev/null 2>&1; then
  ok "cursor session_start -> additional_context"
else bad "cursor session_start envelope"; fi

OUT=$(printf '%s' "$SS_COMPACT" | "$ROOT/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | grep -q "Spec before code"; then
  ok "compact-phase session_start re-emits the digest"
else bad "compact-phase re-injection"; fi

PHASE=$(printf '%s' '{"session_id":"s1","source":"resume","cwd":"/tmp"}' | "$ROOT/adapters/claude-code/normalize.sh" session_start 2>/dev/null | jq -r '.session_start.phase')
[ "$PHASE" = "resume" ] && ok "resume source normalizes to phase=resume" || bad "resume phase mapping (got '$PHASE')"
PHASE=$(printf '%s' '{"session_id":"s1","source":"clear","cwd":"/tmp"}' | "$ROOT/adapters/claude-code/normalize.sh" session_start 2>/dev/null | jq -r '.session_start.phase')
[ "$PHASE" = "startup" ] && ok "clear source normalizes to phase=startup" || bad "clear phase mapping (got '$PHASE')"

echo "── action-envelope validation ─────────────────────────────"

printf '%s' '{"protocol":"1.1","action":"context","text":"hello"}' | "$ROOT/hooks/validate-action.sh" >/dev/null 2>&1 \
  && ok "validate-action accepts a minimal context action" || bad "validate-action minimal accept"

for bad_env in \
  '{"protocol":"1.0","action":"context","text":"x"}' \
  '{"protocol":"1.1","action":"inject","text":"x"}' \
  '{"protocol":"1.1","action":"context"}' \
  '{"protocol":"1.1","action":"context","text":""}' \
  '{"protocol":"1.1","action":"context","text":"x","extra":true}' \
  'not-json'; do
  if printf '%s' "$bad_env" | "$ROOT/hooks/validate-action.sh" >/dev/null 2>&1; then
    bad "validate-action wrongly accepted: $bad_env"
  else
    ok "validate-action rejects: ${bad_env:0:50}"
  fi
done

BIG=$(printf 'a%.0s' $(seq 1 8001))
if jq -cn --arg t "$BIG" '{protocol:"1.1",action:"context",text:$t}' | "$ROOT/hooks/validate-action.sh" >/dev/null 2>&1; then
  bad "validate-action wrongly accepted an oversized action"
else
  ok "validate-action rejects an action over the 8,000-byte cap"
fi

if printf '%s\n%s' '{"a":1}' '{"protocol":"1.1","action":"context","text":"legit"}' | "$ROOT/hooks/validate-action.sh" >/dev/null 2>&1; then
  bad "validate-action wrongly accepted a multi-document stream"
else
  ok "validate-action rejects a multi-document JSON stream"
fi

echo "── run-hook fails closed on a malformed envelope ──────────"

COPY=$(make_copy malformed)
printf '#!/bin/sh\necho not-an-action\n' > "$COPY/hooks/inject-context.sh"
chmod +x "$COPY/hooks/inject-context.sh"
OUT=$(printf '%s' "$SS_CLAUDE" | "$COPY/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
STATUS=$?
if [ "$STATUS" -ne 0 ] && [ -z "$OUT" ]; then
  ok "malformed policy output -> nonzero exit ($STATUS) with empty stdout"
else
  bad "malformed policy output (exit=$STATUS, stdout='${OUT:0:40}')"
fi

COPY=$(make_copy native-json)
printf '#!/bin/sh\necho %s\n' "'{\"additionalContext\":\"sneaky native json\"}'" > "$COPY/hooks/inject-context.sh"
chmod +x "$COPY/hooks/inject-context.sh"
OUT=$(printf '%s' "$SS_CLAUDE" | "$COPY/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
STATUS=$?
if [ "$STATUS" -ne 0 ] && [ -z "$OUT" ]; then
  ok "runtime-native JSON from a policy is rejected (translation is adapter-only)"
else
  bad "native JSON smuggled through (exit=$STATUS)"
fi

echo "── builder failure modes ──────────────────────────────────"

COPY=$(make_copy no-digest)
sed -i.bak 's/agent-digest:start/agent-digest:gone/; s/agent-digest:end/agent-digest:over/' "$COPY/CONSTITUTION.md"
ERR=$(printf '%s' "$SS_CLAUDE" | "$COPY/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>&1 >/dev/null)
STATUS=$?
if [ "$STATUS" -ne 0 ] && printf '%s' "$ERR" | grep -Eq "agent-digest (block|start/end markers) missing"; then
  ok "missing digest -> explicit named error, nonzero exit"
else
  bad "missing digest (exit=$STATUS, err='${ERR:0:60}')"
fi

COPY=$(make_copy oversize)
{
  echo "<!-- agent-digest:start -->"
  # 9 KB of digest — over the total cap on its own.
  for _ in $(seq 1 180); do printf 'x%.0s' $(seq 1 50); echo; done
  echo "<!-- agent-digest:end -->"
} > "$COPY/CONSTITUTION.md"
ERR=$(printf '%s' "$SS_CLAUDE" | "$COPY/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>&1 >/dev/null)
STATUS=$?
if [ "$STATUS" -ne 0 ] && printf '%s' "$ERR" | grep -q "exceeds 8000-byte cap"; then
  ok "over-cap context -> explicit failure, never silent truncation"
else
  bad "over-cap context (exit=$STATUS, err='${ERR:0:60}')"
fi

COPY=$(make_copy zero-skills)
rm -rf "$COPY/skills"
OUT=$(printf '%s' "$SS_CLAUDE" | "$COPY/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | grep -q "(no skills installed)"; then
  ok "zero skills -> valid action with an explicit empty index"
else
  bad "zero skills handling"
fi

COPY=$(make_copy symlink-escape)
OUTSIDE="$SCRATCH/outside-skill"
mkdir -p "$OUTSIDE"
printf -- '---\nname: evil\ndescription: Escaped skill. Never index me.\n---\n' > "$OUTSIDE/SKILL.md"
mkdir -p "$COPY/skills/escaped"
ln -s "$OUTSIDE/SKILL.md" "$COPY/skills/escaped/SKILL.md"
OUT=$(printf '%s' "$SS_CLAUDE" | "$COPY/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
if [ -n "$OUT" ] && ! printf '%s' "$OUT" | grep -Eq "evil|outside-skill"; then
  ok "symlinked SKILL.md is rejected from the index"
else
  bad "symlink escape leaked into the index"
fi

COPY=$(make_copy no-description)
mkdir -p "$COPY/skills/broken"
printf -- '---\nname: broken\n---\nno description here\n' > "$COPY/skills/broken/SKILL.md"
OUT=$(printf '%s' "$SS_CLAUDE" | "$COPY/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
STATUS=$?
if [ "$STATUS" -eq 0 ] && [ -n "$OUT" ] && ! printf '%s' "$OUT" | grep -q "\- broken —"; then
  ok "skill with no frontmatter description is skipped, run still succeeds"
else
  bad "malformed skill entry handling (exit=$STATUS)"
fi

COPY_PARENT="$SCRATCH/vendored-repo"
mkdir -p "$COPY_PARENT/.harness"
cp -R "$ROOT/hooks" "$ROOT/adapters" "$ROOT/skills" "$COPY_PARENT/.harness/"
cp "$ROOT/CONSTITUTION.md" "$COPY_PARENT/.harness/"
sed 's/agent-digest:start -->/agent-digest:start -->\n- The repo-root customization marker is OWL-77./' "$ROOT/CONSTITUTION.md" > "$COPY_PARENT/CONSTITUTION.md"
OUT=$(printf '%s' "$SS_CLAUDE" | "$COPY_PARENT/.harness/adapters/run-hook.sh" claude-code session_start inject-context.sh 2>/dev/null)
if printf '%s' "$OUT" | grep -q "OWL-77"; then
  ok "vendored .harness layout prefers the repo-root CONSTITUTION.md"
else
  bad "vendored layout used the stale pack CONSTITUTION.md"
fi

echo "── event validation ───────────────────────────────────────"

printf '%s' '{"protocol_version":"1.1","event":"session_start","runtime":{"name":"mock"},"cwd":"/tmp","session_start":{"phase":"startup"}}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && ok "validate-event accepts a 1.1 session_start" || bad "validate-event session_start accept"

printf '%s' '{"protocol_version":"1.0","event":"session_start","runtime":{"name":"mock"},"cwd":"/tmp","session_start":{"phase":"startup"}}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && bad "validate-event wrongly accepted session_start on protocol 1.0" \
  || ok "validate-event requires protocol 1.1 for session_start"

printf '%s' '{"protocol_version":"1.1","event":"session_start","runtime":{"name":"mock"},"cwd":"/tmp","session_start":{"phase":"sideways"}}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && bad "validate-event wrongly accepted an unknown phase" \
  || ok "validate-event rejects an unknown session_start phase"

printf '%s' '{"protocol_version":"1.1","event":"subagent_start","runtime":{"name":"mock"},"cwd":"/tmp","subagent_start":{"agent_type":"Explore"}}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && ok "validate-event accepts a 1.1 subagent_start" || bad "validate-event subagent_start accept"

printf '%s' '{"protocol_version":"1.0","event":"stop","runtime":{"name":"mock"},"cwd":"/tmp","stop":{"verification_loop_active":false}}' \
  | "$ROOT/hooks/validate-event.sh" >/dev/null 2>&1 \
  && ok "validate-event still accepts a 1.0 stop event (back-compat)" || bad "validate-event 1.0 back-compat"

echo "────────────────────────────────────────────────────────────"
echo "inject-context evals: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
