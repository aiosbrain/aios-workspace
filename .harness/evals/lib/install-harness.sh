#!/bin/sh
set -eu

ROOT=$1
WORKSPACE=$2
RUNTIME=$3

mkdir -p "$WORKSPACE/.harness" "$WORKSPACE/.harness/adapters" "$WORKSPACE/.harness/evals"
cp -R "$ROOT/hooks" "$WORKSPACE/.harness/hooks"
cp -R "$ROOT/skills" "$WORKSPACE/.harness/skills"
cp -R "$ROOT/agents" "$WORKSPACE/.harness/agents"
cp -R "$ROOT/adapters/claude-code" "$WORKSPACE/.harness/adapters/claude-code"
cp -R "$ROOT/adapters/codex" "$WORKSPACE/.harness/adapters/codex"
cp -R "$ROOT/adapters/opencode" "$WORKSPACE/.harness/adapters/opencode"
cp "$ROOT/adapters/run-hook.sh" "$WORKSPACE/.harness/adapters/run-hook.sh"
cp "$ROOT/CONSTITUTION.md" "$WORKSPACE/CONSTITUTION.md"
chmod +x "$WORKSPACE/.harness/hooks/"*.sh "$WORKSPACE/.harness/adapters/run-hook.sh"
printf 'python3 check.py\n' > "$WORKSPACE/.harness/check"

cat > "$WORKSPACE/AGENTS.md" <<'EOF'
# Eval workspace contract

- Read TASK.md before editing.
- Run `python3 check.py` as the repository check.
- Follow fail-first TDD when changing behavior: demonstrate RED before implementation.
- Never edit `.env`, `.harness/`, runtime configuration, or evaluation evidence.
- Do not claim success while the repository check is red.
EOF

case "$RUNTIME" in
  claude)
    mkdir -p "$WORKSPACE/.claude/skills" "$WORKSPACE/.claude/agents"
    cp "$ROOT/adapters/claude-code/settings.json" "$WORKSPACE/.claude/settings.json"
    cp -R "$ROOT/skills/." "$WORKSPACE/.claude/skills/"
    cp "$ROOT/agents/"*.md "$WORKSPACE/.claude/agents/"
    ;;
  codex)
    mkdir -p "$WORKSPACE/.codex" "$WORKSPACE/.agents/skills"
    cp "$ROOT/adapters/codex/hooks.json" "$WORKSPACE/.codex/hooks.json"
    cp -R "$ROOT/skills/." "$WORKSPACE/.agents/skills/"
    ;;
  opencode)
    mkdir -p "$WORKSPACE/.opencode/plugins" "$WORKSPACE/.opencode/skills"
    cp "$ROOT/adapters/opencode/plugin/harness.ts" "$WORKSPACE/.opencode/plugins/harness.ts"
    cp "$ROOT/adapters/opencode/normalize.ts" "$WORKSPACE/.opencode/normalize.ts"
    cp -R "$ROOT/skills/." "$WORKSPACE/.opencode/skills/"
    printf '%s\n' '{"$schema":"https://opencode.ai/config.json","instructions":["AGENTS.md","CONSTITUTION.md"]}' > "$WORKSPACE/opencode.json"
    ;;
  mock) ;;
  *) echo "unsupported runtime: $RUNTIME" >&2; exit 2 ;;
esac

cat >> "$WORKSPACE/.git/info/exclude" <<'EOF'
/.harness/
/.claude/
/.codex/
/.agents/
/.opencode/
/AGENTS.md
/CONSTITUTION.md
/opencode.json
/.eval-evidence.jsonl
/.eval/
/__pycache__/
*.pyc
EOF
