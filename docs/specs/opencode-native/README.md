# OpenCode-native workspace specs (AIO-298)

Team-facing specs for dual citizenship: Claude Code + OpenCode sharing the same
`.claude/` agent layer.

| Spec | Deliverable |
|------|-------------|
| [epic.md](epic.md) | ON-EPIC overview |
| [on1-agents-md.md](on1-agents-md.md) | AGENTS.md template + 0-context blurb |
| [on2-opencode-json.md](on2-opencode-json.md) | `scaffold/opencode.json` |
| [on3-commands.md](on3-commands.md) | Command export pipeline |
| [on4-agents.md](on4-agents.md) | `.opencode/agents/*` |
| [on5-instincts.md](on5-instincts.md) | Instincts plugin |
| [on6-skill-export.md](on6-skill-export.md) | BYOA skill export verification |
| [on7-brain-sync.md](on7-brain-sync.md) | Brain sync verification |
| [on8-smoke-test.md](on8-smoke-test.md) | End-to-end smoke test |

Implementation lives in `scaffold/` (shipped on `scaffold-project.sh`). Validators:
`validation/check-opencode-scaffold.mjs` (OGR12), `test/opencode-native/scaffold.test.mjs`.

Regenerate OpenCode commands after editing canonical sources:

```bash
node scripts/export-commands.mjs --scaffold
```
